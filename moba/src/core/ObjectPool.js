// 对象池 - 减少对象创建/销毁开销，防止内存泄漏
class ObjectPool {
    constructor(factoryFn, initialSize = 10, maxSize = 100) {
        this._factory = factoryFn;
        this._maxSize = maxSize;
        this._pool = [];
        this._active = new Set();
        
        // 预创建对象
        for (let i = 0; i < initialSize; i++) {
            this._pool.push(this._factory());
        }
    }

    acquire() {
        let obj;
        if (this._pool.length > 0) {
            obj = this._pool.pop();
        } else if (this._active.size < this._maxSize) {
            obj = this._factory();
        } else {
            // 池满，返回 null 调用方需处理
            console.warn('ObjectPool exhausted, returning null');
            return null;
        }
        this._active.add(obj);
        return obj;
    }

    release(obj) {
        if (!obj) return;
        if (this._active.has(obj)) {
            this._active.delete(obj);
            // 重置对象状态
            if (typeof obj.reset === 'function') {
                obj.reset();
            }
            this._pool.push(obj);
        }
    }

    releaseAll() {
        this._active.forEach(obj => {
            if (typeof obj.reset === 'function') {
                obj.reset();
            }
            this._pool.push(obj);
        });
        this._active.clear();
    }

    get activeCount() { return this._active.size; }
    get poolCount() { return this._pool.length; }
    get totalSize() { return this._active.size + this._pool.length; }
}

// 通用游戏对象池管理器
class PoolManager {
    constructor() {
        this._pools = new Map();
    }

    createPool(name, factoryFn, initialSize, maxSize) {
        const pool = new ObjectPool(factoryFn, initialSize, maxSize);
        this._pools.set(name, pool);
        return pool;
    }

    getPool(name) {
        return this._pools.get(name);
    }

    acquire(name) {
        const pool = this._pools.get(name);
        return pool ? pool.acquire() : null;
    }

    release(name, obj) {
        const pool = this._pools.get(name);
        if (pool) pool.release(obj);
    }

    releaseAll() {
        this._pools.forEach(pool => pool.releaseAll());
    }

    clear() {
        this._pools.clear();
    }
}

window.ObjectPool = ObjectPool;
window.PoolManager = PoolManager;