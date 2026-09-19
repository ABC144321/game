/**
 * Terrain —— 程序化地形（无限地图的数据源）
 *
 * 核心思想：地形高度是「世界坐标的纯函数」。
 * 因此分块无论被卸载多少次、何时重新生成，结果永远一致（确定性），
 * 这是无限地图能稳定工作的前提。
 *
 * 两层缓存：
 *  1. tileHeightCache：瓦片中心高度的记忆化，避免相邻瓦片重复计算噪声。
 *  2. tileInfoCache：瓦片完整信息（高度/坡度/类型/通行性/植被）。
 * 两者都是有界缓存，长时间游玩不会无限吃内存。
 */

import { TERRAIN, TILE_SIZE, collectFlattenAreas } from '../config/GameConfig.js';
import { fbm2, clamp, smoothstep, hash2i, BoundedMap, tileKey } from '../core/MathUtils.js';

export const TILE_WATER = 0;
export const TILE_SAND = 1;
export const TILE_GRASS = 2;
export const TILE_CLIFF = 3;
export const TILE_SNOW = 4;

export const PROP_NONE = 0;
export const PROP_TREE = 1;
export const PROP_ROCK = 2;

const INDEX_CELL = 64; // 空间哈希单元尺寸（米）

const TILE_COLORS = {
    [TILE_WATER]: [0.15, 0.30, 0.50],
    [TILE_SAND]: [0.78, 0.71, 0.52],
    [TILE_GRASS]: [0.29, 0.46, 0.27],
    [TILE_CLIFF]: [0.42, 0.42, 0.45],
    [TILE_SNOW]: [0.90, 0.93, 0.97]
};

export class Terrain {
    constructor(seed = TERRAIN.seed) {
        this.seed = seed | 0;
        this._areas = collectFlattenAreas().map((a) => ({
            x: a.x,
            z: a.z,
            radius: Math.max(0.5, a.radius),
            height: a.height,
            strength: clamp(a.strength == null ? 1 : a.strength, 0, 1),
            propRadius: Math.max(0.5, a.radius) + 3
        }));
        this._cellIndex = new Map();
        this._buildSpatialIndex();

        this.tileHeightCache = new BoundedMap(220000, 0.15);
        this.tileInfoCache = new BoundedMap(150000, 0.15);

        // 统计（调试面板用）
        this.stats = { heightCalls: 0, tileComputes: 0 };
    }

    /* ------------------------------ 空间索引 ------------------------------ */

    _buildSpatialIndex() {
        this._cellIndex.clear();
        for (let i = 0; i < this._areas.length; i++) {
            const a = this._areas[i];
            const r = Math.max(a.radius, a.propRadius);
            const x0 = Math.floor((a.x - r) / INDEX_CELL);
            const x1 = Math.floor((a.x + r) / INDEX_CELL);
            const z0 = Math.floor((a.z - r) / INDEX_CELL);
            const z1 = Math.floor((a.z + r) / INDEX_CELL);
            for (let cx = x0; cx <= x1; cx++) {
                for (let cz = z0; cz <= z1; cz++) {
                    const key = tileKey(cx, cz);
                    let bucket = this._cellIndex.get(key);
                    if (!bucket) {
                        bucket = [];
                        this._cellIndex.set(key, bucket);
                    }
                    bucket.push(a);
                }
            }
        }
    }

    /** 返回坐标附近的整平区域（通常 0~8 个） */
    _nearAreas(wx, wz) {
        const key = tileKey(Math.floor(wx / INDEX_CELL), Math.floor(wz / INDEX_CELL));
        const bucket = this._cellIndex.get(key);
        return bucket || null;
    }

    /* ------------------------------ 高度场 ------------------------------ */

    /** 未受整平影响的原始高度 */
    _rawHeight(wx, wz) {
        const n1 = fbm2(wx * TERRAIN.baseFrequency, wz * TERRAIN.baseFrequency, this.seed, TERRAIN.octaves, 2.0, 0.5);
        let h = (n1 * 2 - 1) * TERRAIN.amplitude;

        const n2 = fbm2(wx * TERRAIN.detailFrequency, wz * TERRAIN.detailFrequency, (this.seed + 7777) | 0, 2, 2.0, 0.5);
        h += (n2 * 2 - 1) * TERRAIN.detailAmplitude;

        // 中心区域更平坦：出生点附近便于开局展开
        const distCenter = Math.sqrt(wx * wx + wz * wz);
        const openness = smoothstep((distCenter - 55) / 95);
        h *= 0.35 + 0.65 * openness;

        return h;
    }

    /** 世界坐标处的地面高度（含兵线/基地整平） */
    heightAt(wx, wz) {
        this.stats.heightCalls++;
        let h = this._rawHeight(wx, wz);

        const areas = this._nearAreas(wx, wz);
        if (areas) {
            for (let i = 0; i < areas.length; i++) {
                const a = areas[i];
                const dx = wx - a.x;
                const dz = wz - a.z;
                const d2 = dx * dx + dz * dz;
                const r2 = a.radius * a.radius;
                if (d2 >= r2) continue;
                const t = 1 - Math.sqrt(d2) / a.radius;
                const w = smoothstep(t) * a.strength;
                h += (a.height - h) * w;
            }
        }
        return h;
    }

    /** 瓦片中心高度（记忆化） */
    tileHeight(tx, tz) {
        const key = tileKey(tx, tz);
        const cached = this.tileHeightCache.get(key);
        if (cached !== undefined) return cached;

        const wx = tx * TILE_SIZE + TILE_SIZE * 0.5;
        const wz = tz * TILE_SIZE + TILE_SIZE * 0.5;
        const h = this.heightAt(wx, wz);
        this.tileHeightCache.set(key, h);
        return h;
    }

    /* ------------------------------ 瓦片信息 ------------------------------ */

    /**
     * 取得瓦片完整信息（记忆化）。
     * @returns {{h:number, slope:number, kind:number, walkable:boolean, prop:number, color:number[]}}
     */
    tileInfo(tx, tz) {
        const key = tileKey(tx, tz);
        const cached = this.tileInfoCache.get(key);
        if (cached !== undefined) return cached;

        const info = this._computeTile(tx, tz);
        this.tileInfoCache.set(key, info);
        return info;
    }

    /** 瓦片是否可通行（不含动态建筑阻挡） */
    isWalkable(tx, tz) {
        const info = this.tileInfo(tx, tz);
        return !!info && info.walkable;
    }

    _computeTile(tx, tz) {
        this.stats.tileComputes++;
        const h = this.tileHeight(tx, tz);

        const hLeft = this.tileHeight(tx - 1, tz);
        const hRight = this.tileHeight(tx + 1, tz);
        const hUp = this.tileHeight(tx, tz - 1);
        const hDown = this.tileHeight(tx, tz + 1);
        const slope = Math.max(Math.abs(hRight - hLeft), Math.abs(hDown - hUp)) * 0.5;

        let kind;
        if (h < TERRAIN.waterLevel) kind = TILE_WATER;
        else if (h < TERRAIN.shoreLevel) kind = TILE_SAND;
        else if (h > TERRAIN.walkMaxHeight + 1.7) kind = TILE_SNOW;
        else if (h > TERRAIN.walkMaxHeight) kind = TILE_CLIFF;
        else kind = TILE_GRASS;

        let walkable = true;
        if (kind === TILE_WATER || kind === TILE_CLIFF || kind === TILE_SNOW) walkable = false;
        else if (slope > TERRAIN.maxSlope) walkable = false;

        const prop = walkable ? this._computeProp(tx, tz, kind) : PROP_NONE;
        if (prop !== PROP_NONE) walkable = false;

        // 颜色：在基础色上叠加轻微噪声，避免大片纯色
        const base = TILE_COLORS[kind] || TILE_COLORS[TILE_GRASS];
        const jitter = (hash2i(tx, tz, this.seed + 31) - 0.5) * 0.09;
        const color = [
            clamp(base[0] + jitter, 0, 1),
            clamp(base[1] + jitter, 0, 1),
            clamp(base[2] + jitter, 0, 1)
        ];

        return { h, slope, kind, walkable, prop, color, tx, tz };
    }

    /** 该瓦片是否位于「禁止生成植被」的保护带内（兵线、基地、营地等） */
    isPropExcluded(wx, wz) {
        const areas = this._nearAreas(wx, wz);
        if (!areas) return false;
        for (let i = 0; i < areas.length; i++) {
            const a = areas[i];
            const dx = wx - a.x;
            const dz = wz - a.z;
            if (dx * dx + dz * dz < a.propRadius * a.propRadius) return true;
        }
        return false;
    }

    _computeProp(tx, tz, kind) {
        const wx = tx * TILE_SIZE + TILE_SIZE * 0.5;
        const wz = tz * TILE_SIZE + TILE_SIZE * 0.5;
        if (this.isPropExcluded(wx, wz)) return PROP_NONE;
        if (kind !== TILE_GRASS && kind !== TILE_SAND) return PROP_NONE;

        const r = hash2i(tx, tz, this.seed + 991);
        if (r < TERRAIN.treeDensity) return PROP_TREE;
        if (r < TERRAIN.treeDensity + TERRAIN.rockDensity) return PROP_ROCK;
        return PROP_NONE;
    }

    /** 清空缓存（切换世界种子时使用） */
    clearCache() {
        this.tileHeightCache.clear();
        this.tileInfoCache.clear();
    }

    /** 计算若干坐标的包围盒（流场边界用） */
    static boundsOf(points, paddingTiles) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of points) {
            if (!p) continue;
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
        }
        if (!Number.isFinite(minX)) {
            minX = -64; maxX = 64; minZ = -64; maxZ = 64;
        }
        const pad = paddingTiles * TILE_SIZE;
        return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
    }
}