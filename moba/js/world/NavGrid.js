/**
 * NavGrid —— 导航网格
 *
 * 在「地形通行性」之上叠加一层「动态阻挡」（建筑、防御塔），
 * 对寻路系统只暴露 isWalkable 一个接口，实现地形与建筑的解耦。
 *
 * 动态阻挡使用引用计数：多个建筑压在同一瓦片上时，
 * 只有最后一个移除才真正解除阻挡，避免「拆一个塔把别人的阻挡也清了」的 Bug。
 */

import { TILE_SIZE } from '../config/GameConfig.js';
import { tileKey, keyToTile } from '../core/MathUtils.js';

export class NavGrid {
    /** @param {import('./Terrain.js').Terrain} terrain */
    constructor(terrain) {
        this.terrain = terrain;
        /** @type {Map<number, number>} 瓦片键 -> 阻挡引用计数 */
        this._blockers = new Map();
        /** 每次动态阻挡变化时自增，寻路系统据此判断缓存是否失效 */
        this.version = 1;
    }

    /* ------------------------------ 坐标转换 ------------------------------ */

    static worldToTile(w) {
        return Math.floor(w / TILE_SIZE);
    }

    static tileCenter(t) {
        return t * TILE_SIZE + TILE_SIZE * 0.5;
    }

    static worldToTileXZ(x, z) {
        return { tx: Math.floor(x / TILE_SIZE), tz: Math.floor(z / TILE_SIZE) };
    }

    /* ------------------------------ 通行性查询 ------------------------------ */

    /** 地形本身的通行性（忽略建筑） */
    isTerrainWalkable(tx, tz) {
        const info = this.terrain.tileInfo(tx, tz);
        return !!(info && info.walkable);
    }

    /** 综合通行性：地形 + 动态阻挡 */
    isWalkable(tx, tz) {
        if (this._blockers.size > 0 && this._blockers.has(tileKey(tx, tz))) return false;
        return this.isTerrainWalkable(tx, tz);
    }

    /* ------------------------------ 动态阻挡 ------------------------------ */

    addBlocker(tx, tz) {
        const key = tileKey(tx, tz);
        const next = (this._blockers.get(key) || 0) + 1;
        this._blockers.set(key, next);
        this.version++;
    }

    removeBlocker(tx, tz) {
        const key = tileKey(tx, tz);
        const cur = this._blockers.get(key);
        if (cur === undefined) return;
        if (cur <= 1) this._blockers.delete(key);
        else this._blockers.set(key, cur - 1);
        this.version++;
    }

    isDynamicallyBlocked(tx, tz) {
        return this._blockers.has(tileKey(tx, tz));
    }

    /**
     * 以世界坐标为中心，把半径 radiusTiles 内的瓦片标记为阻挡。
     * @returns {number[]} 被标记的瓦片键，用于之后释放
     */
    blockCircle(worldX, worldZ, radiusTiles) {
        const keys = [];
        const r = Math.max(0, radiusTiles);
        const center = NavGrid.worldToTileXZ(worldX, worldZ);
        const span = Math.ceil(r) + 1;
        for (let dz = -span; dz <= span; dz++) {
            for (let dx = -span; dx <= span; dx++) {
                if (dx * dx + dz * dz > r * r) continue;
                const tx = center.tx + dx;
                const tz = center.tz + dz;
                this.addBlocker(tx, tz);
                keys.push(tileKey(tx, tz));
            }
        }
        return keys;
    }

    /** 释放 blockCircle 返回的瓦片键 */
    releaseTiles(keys) {
        if (!Array.isArray(keys)) return;
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const cur = this._blockers.get(key);
            if (cur === undefined) continue;
            if (cur <= 1) this._blockers.delete(key);
            else this._blockers.set(key, cur - 1);
        }
        this.version++;
    }

    /* ------------------------------ 辅助查询 ------------------------------ */

    /**
     * 螺旋搜索最近的可行走瓦片。
     * @returns {{tx:number,tz:number,distance:number}|null}
     */
    findNearestWalkable(tx, tz, maxRadius = 8) {
        if (this.isWalkable(tx, tz)) return { tx, tz, distance: 0 };
        const max = Math.max(1, maxRadius | 0);
        for (let r = 1; r <= max; r++) {
            // 只遍历环上的瓦片，比遍历整块方阵便宜得多
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
                    const nx = tx + dx;
                    const nz = tz + dz;
                    if (this.isWalkable(nx, nz)) return { tx: nx, tz: nz, distance: r };
                }
            }
        }
        return null;
    }

    /** 稀疏采样一圈可行走点（生成位置用） */
    hasAnyWalkableNear(tx, tz, radius) {
        return this.findNearestWalkable(tx, tz, radius) !== null;
    }

    /** 统计当前阻挡瓦片数量（调试用） */
    get blockerCount() {
        return this._blockers.size;
    }

    clearDynamic() {
        if (this._blockers.size === 0) return;
        this._blockers.clear();
        this.version++;
    }
}

export { keyToTile };