/**
 * SpatialGrid —— 均匀网格空间分区
 *
 * 用途：把「每个单位都要遍历全部单位找目标」的 O(n^2) 降到接近 O(n)。
 *
 * 实现要点（针对 GC 优化）：
 *  - 网格单元存的是可复用的数组，清空时把数组归还到对象池而不是丢弃，
 *    避免每帧产生数百个短命数组造成 GC 抖动；
 *  - 查询结果写入调用方提供的数组，避免内部临时分配。
 */

import { tileKey } from '../core/MathUtils.js';

export class SpatialGrid {
    constructor(cellSize = 16) {
        this.cellSize = Math.max(4, cellSize);
        this._cells = new Map();
        this._pool = [];
    }

    clear() {
        // 归还所有单元数组到池中
        for (const bucket of this._cells.values()) {
            bucket.length = 0;
            if (this._pool.length < 512) this._pool.push(bucket);
        }
        this._cells.clear();
    }

    _obtain() {
        const buf = this._pool.pop();
        return buf || [];
    }

    insert(entity) {
        if (!entity) return;
        const cx = Math.floor(entity.position.x / this.cellSize);
        const cz = Math.floor(entity.position.z / this.cellSize);
        const key = tileKey(cx, cz);
        let bucket = this._cells.get(key);
        if (!bucket) {
            bucket = this._obtain();
            this._cells.set(key, bucket);
        }
        bucket.push(entity);
    }

    rebuild(entities) {
        this.clear();
        if (!entities) return;
        for (let i = 0; i < entities.length; i++) this.insert(entities[i]);
    }

    /**
     * 查询圆形范围内（按中心点距离）的对象，结果写入 out。
     * @param {number} x
     * @param {number} z
     * @param {number} radius
     * @param {Array} out 调用方提供的数组（会被 push 内容）
     */
    queryCircle(x, z, radius, out) {
        const r = Math.max(0, radius);
        const minCx = Math.floor((x - r) / this.cellSize);
        const maxCx = Math.floor((x + r) / this.cellSize);
        const minCz = Math.floor((z - r) / this.cellSize);
        const maxCz = Math.floor((z + r) / this.cellSize);
        const rSq = r * r;

        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cz = minCz; cz <= maxCz; cz++) {
                const bucket = this._cells.get(tileKey(cx, cz));
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) {
                    const e = bucket[i];
                    if (!e) continue;
                    const dx = e.position.x - x;
                    const dz = e.position.z - z;
                    if (dx * dx + dz * dz <= rSq) out.push(e);
                }
            }
        }
        return out;
    }

    get cellCount() {
        return this._cells.size;
    }
}