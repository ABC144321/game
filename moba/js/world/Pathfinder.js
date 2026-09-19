/**
 * Pathfinder —— 寻路系统（两套互补算法）
 *
 * 1) A*：用于「点到点」的精确寻路。玩家点击移动、AI 英雄奔袭目标点时使用。
 *    - 二叉堆开放列表；八方向；八分度启发式（octile）。
 *    - 严格节点上限 maxNodes：无论如何都不会陷入无限搜索。
 *    - 路径平滑：用视线检测剔除冗余拐点，让单位走直线而不是锯齿。
 *
 * 2) FlowField：用于「大量单位涌向同一目标」的塔防场景。
 *    从目标点做一次 BFS 生成方向场，之后每只怪物只需 O(1) 查表即可知道往哪走。
 *    100 只怪物 = 1 次计算，而不是 100 次 A*，这是塔防性能的关键。
 */

import { TILE_SIZE } from '../config/GameConfig.js';
import { tileKey, keyToTile } from '../core/MathUtils.js';

/* ------------------------------ 八方向定义 ------------------------------ */

export const DIRS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1]
];
/** DIRS 的反向索引：0<->1, 2<->3, 4<->7, 5<->6 */
const OPPOSITE = [1, 0, 3, 2, 7, 6, 5, 4];
const SQRT2 = Math.SQRT2;

/* ------------------------------ 最小堆 ------------------------------ */

class MinHeap {
    constructor() {
        this._key = [];
        this._f = [];
    }

    get size() { return this._key.length; }

    clear() {
        this._key.length = 0;
        this._f.length = 0;
    }

    push(key, f) {
        this._key.push(key);
        this._f.push(f);
        let i = this._key.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this._f[parent] <= this._f[i]) break;
            this._swap(i, parent);
            i = parent;
        }
    }

    pop() {
        const n = this._key.length;
        if (n === 0) return -1;
        const top = this._key[0];
        const lastKey = this._key.pop();
        const lastF = this._f.pop();
        if (n > 1) {
            this._key[0] = lastKey;
            this._f[0] = lastF;
            let i = 0;
            const size = this._key.length;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let smallest = i;
                if (l < size && this._f[l] < this._f[smallest]) smallest = l;
                if (r < size && this._f[r] < this._f[smallest]) smallest = r;
                if (smallest === i) break;
                this._swap(i, smallest);
                i = smallest;
            }
        }
        return top;
    }

    _swap(a, b) {
        const k = this._key[a]; this._key[a] = this._key[b]; this._key[b] = k;
        const f = this._f[a]; this._f[a] = this._f[b]; this._f[b] = f;
    }
}

/* ------------------------------ A* ------------------------------ */

export class Pathfinder {
    /**
     * @param {import('./NavGrid.js').NavGrid} nav
     * @param {number} maxNodes
     */
    constructor(nav, maxNodes = 6000) {
        this.nav = nav;
        this.maxNodes = Math.max(64, maxNodes | 0);

        this._heap = new MinHeap();
        this._g = new Map();
        this._parent = new Map();
        this._closed = new Set();

        this.stats = { calls: 0, failures: 0, nodesVisited: 0, lastMs: 0 };
    }

    /**
     * 求解瓦片路径。
     * @returns {{tx:number,tz:number}[]|null} 不含起点；无法到达返回 null
     */
    findPath(startTx, startTz, goalTx, goalTz) {
        const t0 = performance.now();
        this.stats.calls++;

        const nav = this.nav;
        const start = nav.findNearestWalkable(startTx, startTz, 6);
        if (!start) return this._fail(t0);

        const goal = nav.findNearestWalkable(goalTx, goalTz, 10);
        if (!goal) return this._fail(t0);

        if (start.tx === goal.tx && start.tz === goal.tz) return [];

        this._heap.clear();
        this._g.clear();
        this._parent.clear();
        this._closed.clear();

        const startKey = tileKey(start.tx, start.tz);
        const goalKey = tileKey(goal.tx, goal.tz);

        this._g.set(startKey, 0);
        this._parent.set(startKey, -1);
        this._heap.push(startKey, this._heuristic(start.tx, start.tz, goal.tx, goal.tz));

        let visited = 0;
        let result = null;

        while (this._heap.size > 0) {
            if (++visited > this.maxNodes) {
                // 达到上限：放弃本次搜索（宁可不寻路，也不能卡死主线程）
                break;
            }

            const currentKey = this._heap.pop();
            if (currentKey === -1) break;
            if (this._closed.has(currentKey)) continue;
            this._closed.add(currentKey);

            if (currentKey === goalKey) {
                result = this._reconstruct(currentKey, startKey);
                break;
            }

            const cur = keyToTile(currentKey);
            const curG = this._g.get(currentKey) || 0;

            for (let d = 0; d < 8; d++) {
                const dx = DIRS[d][0];
                const dz = DIRS[d][1];
                const nx = cur.tx + dx;
                const nz = cur.tz + dz;

                if (!nav.isWalkable(nx, nz)) continue;
                // 对角线不允许「贴角穿过」
                if (d >= 4 && (!nav.isWalkable(cur.tx + dx, cur.tz) || !nav.isWalkable(cur.tx, cur.tz + dz))) {
                    continue;
                }

                const nKey = tileKey(nx, nz);
                if (this._closed.has(nKey)) continue;

                const step = d >= 4 ? SQRT2 : 1;
                const tentative = curG + step;
                const known = this._g.get(nKey);
                if (known !== undefined && tentative >= known) continue;

                this._g.set(nKey, tentative);
                this._parent.set(nKey, currentKey);
                this._heap.push(nKey, tentative + this._heuristic(nx, nz, goal.tx, goal.tz));
            }
        }

        this.stats.nodesVisited += visited;
        this.stats.lastMs = performance.now() - t0;

        if (!result) return this._fail(t0, false);
        return this._smooth(result);
    }

    /** 世界坐标版本，返回世界坐标路点数组 */
    findPathWorld(x0, z0, x1, z1) {
        const s = Pathfinder.worldToTile(x0, z0);
        const g = Pathfinder.worldToTile(x1, z1);
        const tiles = this.findPath(s.tx, s.tz, g.tx, g.tz);
        if (!tiles) return null;
        const out = [];
        for (let i = 0; i < tiles.length; i++) {
            out.push({
                x: tiles[i].tx * TILE_SIZE + TILE_SIZE * 0.5,
                z: tiles[i].tz * TILE_SIZE + TILE_SIZE * 0.5
            });
        }
        return out;
    }

    static worldToTile(x, z) {
        return { tx: Math.floor(x / TILE_SIZE), tz: Math.floor(z / TILE_SIZE) };
    }

    _heuristic(ax, az, bx, bz) {
        const dx = Math.abs(ax - bx);
        const dz = Math.abs(az - bz);
        return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
    }

    _reconstruct(goalKey, startKey) {
        const out = [];
        let key = goalKey;
        let guard = 0;
        const limit = this.maxNodes + 8;
        while (key !== -1 && key !== startKey && guard++ < limit) {
            const t = keyToTile(key);
            out.push({ tx: t.tx, tz: t.tz });
            const parent = this._parent.get(key);
            if (parent === undefined) break;
            key = parent;
        }
        out.reverse();
        return out;
    }

    /** 视线平滑：能直达的中间点全部删掉 */
    _smooth(path) {
        if (!path || path.length <= 2) return path;
        const out = [path[0]];
        let anchor = 0;
        for (let i = 2; i < path.length; i++) {
            if (!this.hasLineOfSight(path[anchor].tx, path[anchor].tz, path[i].tx, path[i].tz)) {
                out.push(path[i - 1]);
                anchor = i - 1;
            }
        }
        out.push(path[path.length - 1]);
        return out;
    }

    /** 瓦片级视线检测（Bresenham，带步数上限防死循环） */
    hasLineOfSight(x0, z0, x1, z1) {
        const nav = this.nav;
        let dx = Math.abs(x1 - x0);
        let dz = Math.abs(z1 - z0);
        const sx = x0 < x1 ? 1 : -1;
        const sz = z0 < z1 ? 1 : -1;
        let err = dx - dz;
        let x = x0;
        let z = z0;
        let guard = dx + dz + 2;

        while (guard-- > 0) {
            if (!nav.isWalkable(x, z)) return false;
            if (x === x1 && z === z1) return true;
            const e2 = err * 2;
            if (e2 > -dz) { err -= dz; x += sx; }
            if (e2 < dx) { err += dx; z += sz; }
        }
        return false;
    }

    _fail(t0, count = true) {
        if (count) this.stats.failures++;
        this.stats.lastMs = performance.now() - t0;
        return null;
    }
}

/* ------------------------------ 流场 ------------------------------ */

export const FLOW_NONE = 0;
export const FLOW_GOAL = 9;

export class FlowField {
    constructor() {
        this.minTx = 0;
        this.minTz = 0;
        this.width = 0;
        this.height = 0;

        this._dir = null;   // Uint8Array：0=不可达, 1..8=方向索引+1, 9=目标点
        this._dist = null;  // Int32Array：距离目标的步数
        this._queue = null; // Int32Array 循环队列

        this.ready = false;
        this.version = -1;
        this.lastComputeMs = 0;

        this.stats = { computations: 0, tiles: 0, reachable: 0 };
    }

    /** 依据世界坐标包围盒配置网格尺寸 */
    configure(bounds) {
        const minTx = Math.floor(bounds.minX / TILE_SIZE);
        const minTz = Math.floor(bounds.minZ / TILE_SIZE);
        const maxTx = Math.ceil(bounds.maxX / TILE_SIZE);
        const maxTz = Math.ceil(bounds.maxZ / TILE_SIZE);

        const width = Math.max(4, maxTx - minTx + 1);
        const height = Math.max(4, maxTz - minTz + 1);

        if (width === this.width && height === this.height && minTx === this.minTx && minTz === this.minTz) {
            return false;
        }

        this.minTx = minTx;
        this.minTz = minTz;
        this.width = width;
        this.height = height;

        const size = width * height;
        this._dir = new Uint8Array(size);
        this._dist = new Int32Array(size);
        this._dist.fill(-1);
        this._queue = new Int32Array(size);

        this.ready = false;
        this.version = -1;
        return true;
    }

    indexOf(tx, tz) {
        const cx = tx - this.minTx;
        const cz = tz - this.minTz;
        if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.height) return -1;
        return cz * this.width + cx;
    }

    /**
     * 以 goal 为源做一次 BFS，生成「指向目标」的方向场。
     * BFS 天然是 O(N)，且每个瓦片只入队一次，不存在死循环。
     */
    compute(nav, goalTx, goalTz) {
        const t0 = performance.now();
        const w = this.width;
        const h = this.height;
        if (!w || !h || !this._dir || !this._dist || !this._queue) return false;

        this._dir.fill(FLOW_NONE);
        this._dist.fill(-1);

        const snapped = nav.findNearestWalkable(goalTx, goalTz, 14);
        if (!snapped) {
            this.ready = false;
            this.lastComputeMs = performance.now() - t0;
            return false;
        }

        const goalIndex = this.indexOf(snapped.tx, snapped.tz);
        if (goalIndex < 0) {
            this.ready = false;
            this.lastComputeMs = performance.now() - t0;
            return false;
        }

        const dir = this._dir;
        const dist = this._dist;
        const queue = this._queue;
        let head = 0;
        let tail = 0;

        dist[goalIndex] = 0;
        dir[goalIndex] = FLOW_GOAL;
        queue[tail++] = goalIndex;

        let reachable = 0;

        while (head < tail) {
            const idx = queue[head++];
            reachable++;
            const cy = (idx / w) | 0;
            const cx = idx - cy * w;
            const tx = this.minTx + cx;
            const tz = this.minTz + cy;
            const cd = dist[idx];

            for (let d = 0; d < 8; d++) {
                const dx = DIRS[d][0];
                const dz = DIRS[d][1];
                const nx = tx + dx;
                const nz = tz + dz;
                const ni = this.indexOf(nx, nz);
                if (ni < 0) continue;
                if (dist[ni] !== -1) continue;
                if (!nav.isWalkable(nx, nz)) continue;
                if (d >= 4 && (!nav.isWalkable(tx + dx, tz) || !nav.isWalkable(tx, tz + dz))) continue;

                dist[ni] = cd + 1;
                dir[ni] = OPPOSITE[d] + 1; // 从该瓦片朝目标走，方向是「来的反方向」
                queue[tail++] = ni;
            }
        }

        this.ready = true;
        this.lastComputeMs = performance.now() - t0;
        this.stats.computations++;
        this.stats.tiles = w * h;
        this.stats.reachable = reachable;
        return true;
    }

    /**
     * 若导航网格发生变化则重算（由调用方控制节流频率）。
     * @returns {boolean} 是否真的重算了
     */
    ensure(nav, goalTx, goalTz) {
        if (this.ready && this.version === nav.version) return false;
        const ok = this.compute(nav, goalTx, goalTz);
        if (ok) this.version = nav.version;
        return ok;
    }

    /**
     * 读取某瓦片的流向，写入 out=[dx,dz]。
     * @returns {boolean} false 表示该点不可达或越界
     */
    readFlow(tx, tz, out) {
        if (!this._dir) return false;
        const idx = this.indexOf(tx, tz);
        if (idx < 0) return false;
        const code = this._dir[idx];
        if (code === FLOW_NONE || code === FLOW_GOAL) return false;
        const d = DIRS[code - 1];
        if (!d) return false;
        out[0] = d[0];
        out[1] = d[1];
        return true;
    }

    distanceAt(tx, tz) {
        if (!this._dist) return -1;
        const idx = this.indexOf(tx, tz);
        if (idx < 0) return -1;
        return this._dist[idx];
    }

    /** 该瓦片是否可达目标 */
    isReachable(tx, tz) {
        return this.distanceAt(tx, tz) >= 0;
    }

    clear() {
        if (this._dir) this._dir.fill(FLOW_NONE);
        if (this._dist) this._dist.fill(-1);
        this.ready = false;
        this.version = -1;
    }
}