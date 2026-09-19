/**
 * MathUtils —— 纯函数数学工具集合
 * 无副作用、无外部依赖，可被任何模块安全引用。
 */

export const TAU = Math.PI * 2;

/** 将值限制在 [min, max] 区间内 */
export function clamp(v, min, max) {
    if (!Number.isFinite(v)) return min;
    return v < min ? min : (v > max ? max : v);
}

/** 线性插值 */
export function lerp(a, b, t) {
    return a + (b - a) * t;
}

/** 平滑阶跃，t 会被裁剪到 [0,1] */
export function smoothstep(t) {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
}

/** 角度转弧度 */
export function deg2rad(d) {
    return d * Math.PI / 180;
}

/** 指数趋近（帧率无关的平滑跟随） */
export function damp(current, target, lambda, dt) {
    return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** 最短角度差，结果在 (-PI, PI] */
export function angleDelta(from, to) {
    let d = (to - from) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
}

/** 二维距离平方 */
export function dist2(ax, az, bx, bz) {
    const dx = ax - bx;
    const dz = az - bz;
    return dx * dx + dz * dz;
}

/** 二维距离 */
export function dist(ax, az, bx, bz) {
    return Math.sqrt(dist2(ax, az, bx, bz));
}

/* ------------------------------------------------------------------ *
 * 确定性随机 / 噪声
 * 地形是「世界坐标的纯函数」，因此分块无论何时重新生成结果都一致，
 * 不会出现卸载重载后地形变化的问题。
 * ------------------------------------------------------------------ */

/** mulberry32 —— 快速可播种伪随机数生成器 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 整数坐标哈希，返回 [0,1) */
export function hash2i(x, y, seed) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** 值噪声（双线性插值），返回 [0,1] */
export function valueNoise2(x, y, seed) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);

    const n00 = hash2i(x0, y0, seed);
    const n10 = hash2i(x0 + 1, y0, seed);
    const n01 = hash2i(x0, y0 + 1, seed);
    const n11 = hash2i(x0 + 1, y0 + 1, seed);

    const a = n00 + (n10 - n00) * ux;
    const b = n01 + (n11 - n01) * ux;
    return a + (b - a) * uy;
}

/** 分形叠加噪声，返回 [0,1] */
export function fbm2(x, y, seed, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    const oct = Math.max(1, octaves | 0);
    for (let i = 0; i < oct; i++) {
        sum += valueNoise2(x * freq, y * freq, (seed + i * 1013) | 0) * amp;
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
}

/* ------------------------------------------------------------------ *
 * 折线工具：用于兵线路径点采样（按弧长均匀取点）
 * ------------------------------------------------------------------ */

const _segCache = new WeakMap();

/** 将折线拆为线段并缓存（同一数组只计算一次） */
export function polylineSegments(points) {
    if (!Array.isArray(points) || points.length < 2) return { segs: [], total: 0 };
    const cached = _segCache.get(points);
    if (cached) return cached;

    const segs = [];
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        if (!a || !b) continue;
        const ax = a[0], az = a[1], bx = b[0], bz = b[1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-6) continue;
        segs.push({ ax, az, bx, bz, len, start: total });
        total += len;
    }
    const result = { segs, total };
    _segCache.set(points, result);
    return result;
}

/** 按弧长比例 t∈[0,1] 取得折线上的点，写入 out=[x,z] */
export function polylinePoint(points, t, out = [0, 0]) {
    const { segs, total } = polylineSegments(points);
    if (segs.length === 0) {
        if (Array.isArray(points) && points[0]) {
            out[0] = points[0][0];
            out[1] = points[0][1];
        }
        return out;
    }
    const d = clamp(t, 0, 1) * total;
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (d <= s.start + s.len) {
            const k = s.len > 0 ? (d - s.start) / s.len : 0;
            out[0] = s.ax + (s.bx - s.ax) * k;
            out[1] = s.az + (s.bz - s.az) * k;
            return out;
        }
    }
    const last = segs[segs.length - 1];
    out[0] = last.bx;
    out[1] = last.bz;
    return out;
}

/** 按弧长比例 t 取得折线切向单位向量，写入 out=[dx,dz] */
export function polylineTangent(points, t, out = [0, 1]) {
    const { segs, total } = polylineSegments(points);
    if (segs.length === 0) {
        out[0] = 0; out[1] = 0;
        return out;
    }
    const d = clamp(t, 0, 1) * total;
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (d <= s.start + s.len) {
            const inv = s.len > 0 ? 1 / s.len : 0;
            out[0] = (s.bx - s.ax) * inv;
            out[1] = (s.bz - s.az) * inv;
            return out;
        }
    }
    const last = segs[segs.length - 1];
    const inv = last.len > 0 ? 1 / last.len : 0;
    out[0] = (last.bx - last.ax) * inv;
    out[1] = (last.bz - last.az) * inv;
    return out;
}

/* ------------------------------------------------------------------ *
 * 有界缓存：防止长期运行导致内存无限增长
 * ------------------------------------------------------------------ */

/**
 * 容量受限的 Map。超出上限时按插入顺序淘汰最旧的一批键值。
 * 用于地形采样缓存、寻路缓存等「可重算」的数据。
 */
export class BoundedMap {
    constructor(maxSize = 200000, evictRatio = 0.1) {
        this.maxSize = Math.max(16, maxSize | 0);
        this.evictRatio = clamp(evictRatio, 0.01, 0.5);
        this._map = new Map();
    }

    get size() { return this._map.size; }

    has(key) { return this._map.has(key); }

    get(key) { return this._map.get(key); }

    set(key, value) {
        if (this._map.has(key)) {
            this._map.set(key, value);
            return this;
        }
        if (this._map.size >= this.maxSize) this._evict();
        this._map.set(key, value);
        return this;
    }

    /** get 不存在时用 factory 计算并写入 */
    getOrCompute(key, factory) {
        const hit = this._map.get(key);
        if (hit !== undefined) return hit;
        const value = factory(key);
        this.set(key, value);
        return value;
    }

    _evict() {
        const removeCount = Math.max(1, Math.floor(this.maxSize * this.evictRatio));
        let removed = 0;
        for (const key of this._map.keys()) {
            this._map.delete(key);
            if (++removed >= removeCount) break;
        }
    }

    clear() { this._map.clear(); }
}

/** 将世界坐标瓦片坐标打包为唯一整数键（支持 ±32767 范围） */
export function tileKey(tx, tz) {
    return ((tx + 32768) & 0xFFFF) * 65536 + ((tz + 32768) & 0xFFFF);
}

/** tileKey 的逆运算 */
export function keyToTile(key) {
    const tz = (key % 65536) - 32768;
    const tx = Math.floor(key / 65536) - 32768;
    return { tx, tz };
}

/** 世界坐标 -> 瓦片坐标 */
export function worldToTile(w, tileSize) {
    return Math.floor(w / tileSize);
}

/** 瓦片坐标 -> 世界坐标（瓦片中心） */
export function tileToWorld(t, tileSize) {
    return t * tileSize + tileSize * 0.5;
}