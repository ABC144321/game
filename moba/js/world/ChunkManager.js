/**
 * ChunkManager —— 动态分块加载 / 卸载
 *
 * 职责：
 *  - 根据相机位置与「渲染距离」计算需要存在的分块集合；
 *  - 分帧构建（每帧有时间预算与数量上限），避免一次性生成造成卡顿；
 *  - 卸载远离的分块并释放显存，杜绝内存泄漏；
 *  - 维持队列上限，相机高速移动时也不会堆积成灾。
 *
 * 注意：地形是纯函数，所以分块卸载后再回来重建，结果完全一致。
 */

import { CHUNK_SIZE, VIEW } from '../config/GameConfig.js';
import { tileKey } from '../core/MathUtils.js';
import { Chunk } from './Chunk.js';

export class ChunkManager {
    /**
     * @param {THREE.Scene} scene
     * @param {import('./Terrain.js').Terrain} terrain
     */
    constructor(scene, terrain) {
        this.scene = scene;
        this.terrain = terrain;

        this.chunks = new Map();     // key -> Chunk
        this.pending = [];           // 待构建队列（按距离升序）
        this._pendingKeys = new Set();

        this._lastCx = null;
        this._lastCz = null;
        this._lastViewDistance = -1;
        this._dirty = true;

        this.buildOptions = { propKeepRatio: 1, maxProps: 120 };
        this.maxChunks = 1200;       // 硬上限，防止极端设置下爆内存

        this.stats = {
            loaded: 0,
            pending: 0,
            builtThisFrame: 0,
            totalBuildMs: 0,
            evicted: 0
        };
    }

    /** 修改画质相关参数；会触发全量重建 */
    setBuildOptions(opts) {
        const nextRatio = typeof opts.propKeepRatio === 'number' ? opts.propKeepRatio : this.buildOptions.propKeepRatio;
        const nextMax = typeof opts.maxProps === 'number' ? opts.maxProps : this.buildOptions.maxProps;
        if (nextRatio === this.buildOptions.propKeepRatio && nextMax === this.buildOptions.maxProps) return;
        this.buildOptions.propKeepRatio = nextRatio;
        this.buildOptions.maxProps = nextMax;
        this.rebuildAll();
    }

    /** 卸载全部分块并重新排队 */
    rebuildAll() {
        for (const chunk of this.chunks.values()) chunk.dispose(this.scene);
        this.chunks.clear();
        this.pending.length = 0;
        this._pendingKeys.clear();
        this._dirty = true;
    }

    disposeAll() {
        for (const chunk of this.chunks.values()) chunk.dispose(this.scene);
        this.chunks.clear();
        this.pending.length = 0;
        this._pendingKeys.clear();
    }

    getChunk(cx, cz) {
        return this.chunks.get(tileKey(cx, cz)) || null;
    }

    /** 世界坐标所在分块（可能尚未加载） */
    getChunkAtWorld(x, z) {
        return this.getChunk(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE));
    }

    /** 主更新：在游戏循环的渲染阶段调用 */
    update(camX, camZ, viewDistance) {
        const vd = Math.max(1, viewDistance);
        const radius = Math.ceil(vd / CHUNK_SIZE) + VIEW.chunkLoadMargin;
        const ccx = Math.floor(camX / CHUNK_SIZE);
        const ccz = Math.floor(camZ / CHUNK_SIZE);

        const moved = ccx !== this._lastCx || ccz !== this._lastCz;
        const vdChanged = vd !== this._lastViewDistance;

        if (moved || vdChanged || this._dirty) {
            this._lastCx = ccx;
            this._lastCz = ccz;
            this._lastViewDistance = vd;
            this._dirty = false;
            this._refreshDesired(ccx, ccz, radius, camX, camZ, vd);
            this._unloadFar(ccx, ccz, vd);
        }

        this._processQueue(camX, camZ, vd);
        this._enforceHardCap(camX, camZ);

        this.stats.loaded = this.chunks.size;
        this.stats.pending = this.pending.length;
    }

    /* ------------------------------ 内部实现 ------------------------------ */

    _refreshDesired(ccx, ccz, radius, camX, camZ, vd) {
        const reach = vd + CHUNK_SIZE;
        const desired = new Set();

        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const cx = ccx + dx;
                const cz = ccz + dz;
                const centerX = cx * CHUNK_SIZE + CHUNK_SIZE * 0.5;
                const centerZ = cz * CHUNK_SIZE + CHUNK_SIZE * 0.5;
                const ddx = Math.max(0, Math.abs(camX - centerX) - CHUNK_SIZE * 0.5);
                const ddz = Math.max(0, Math.abs(camZ - centerZ) - CHUNK_SIZE * 0.5);
                if (ddx * ddx + ddz * ddz > reach * reach) continue;

                const key = tileKey(cx, cz);
                desired.add(key);
                if (this.chunks.has(key) || this._pendingKeys.has(key)) continue;

                this.pending.push({ cx, cz, key, dist: Math.sqrt(ddx * ddx + ddz * ddz) });
                this._pendingKeys.add(key);
            }
        }

        // 丢弃已不在视野范围内的排队项
        if (this.pending.length > 0) {
            this.pending = this.pending.filter((item) => desired.has(item.key));
            this._pendingKeys.clear();
            for (const item of this.pending) this._pendingKeys.add(item.key);
        }

        // 若队列过长（相机高速拖拽），只保留最近的一批
        if (this.pending.length > VIEW.maxPendingQueue) {
            this.pending.sort((a, b) => a.dist - b.dist);
            const kept = this.pending.slice(0, VIEW.maxPendingQueue);
            this.pending.length = 0;
            this._pendingKeys.clear();
            for (const item of kept) {
                this.pending.push(item);
                this._pendingKeys.add(item.key);
            }
        }

        this.pending.sort((a, b) => a.dist - b.dist);
    }

    _processQueue(camX, camZ, vd) {
        const t0 = performance.now();
        let built = 0;
        const dropDistance = vd + CHUNK_SIZE * 2;

        while (this.pending.length > 0) {
            if (built >= VIEW.maxBuildsPerFrame) break;
            if (performance.now() - t0 >= VIEW.buildBudgetMs) break;

            const item = this.pending.shift();
            this._pendingKeys.delete(item.key);

            if (this.chunks.has(item.key)) continue;

            // 排队期间相机可能已经走远
            const centerX = item.cx * CHUNK_SIZE + CHUNK_SIZE * 0.5;
            const centerZ = item.cz * CHUNK_SIZE + CHUNK_SIZE * 0.5;
            const dist = Math.hypot(camX - centerX, camZ - centerZ) - CHUNK_SIZE * 0.5;
            if (dist > dropDistance) continue;

            const chunk = new Chunk(item.cx, item.cz, this.terrain, this.buildOptions);
            if (chunk.build(this.scene)) {
                chunk.finalizeBounds();
                this.chunks.set(item.key, chunk);
                built++;
            }
        }

        this.stats.builtThisFrame = built;
        this.stats.totalBuildMs += performance.now() - t0;
    }

    _unloadFar(ccx, ccz, vd) {
        const keepDistance = vd + CHUNK_SIZE * 1.6;
        const toRemove = [];

        for (const [key, chunk] of this.chunks) {
            const dx = Math.abs(chunk.cx - ccx) * CHUNK_SIZE;
            const dz = Math.abs(chunk.cz - ccz) * CHUNK_SIZE;
            const approx = Math.sqrt(Math.max(0, dx - CHUNK_SIZE) ** 2 + Math.max(0, dz - CHUNK_SIZE) ** 2);
            if (approx > keepDistance) toRemove.push(key);
        }

        for (const key of toRemove) {
            const chunk = this.chunks.get(key);
            if (chunk) chunk.dispose(this.scene);
            this.chunks.delete(key);
        }
        this.stats.evicted += toRemove.length;
    }

    /** 极端情况下的兜底：总量超过硬上限时淘汰最远分块 */
    _enforceHardCap(camX, camZ) {
        if (this.chunks.size <= this.maxChunks) return;

        const list = Array.from(this.chunks.values());
        list.sort((a, b) => b.distanceTo(camX, camZ) - a.distanceTo(camX, camZ));
        const removeCount = this.chunks.size - this.maxChunks;
        for (let i = 0; i < removeCount; i++) {
            const chunk = list[i];
            chunk.dispose(this.scene);
            this.chunks.delete(tileKey(chunk.cx, chunk.cz));
        }
    }
}