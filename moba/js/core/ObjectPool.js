/**
 * ObjectPool —— 通用对象池
 *
 * 目的：弹道、特效粒子这类「高频创建/销毁」的对象如果每帧 new，
 * 会造成大量 GC 停顿。对象池把它们复用起来。
 *
 * 防错设计：
 * - 内部用 Set 记录「已借出」对象，重复 release 会被拒绝并告警，
 *   避免同一个对象被两次归还后又被两个持有者同时拿到（经典双释放 Bug）。
 * - 池容量有上限，超出部分直接交给 GC，不会无限膨胀。
 */
export class ObjectPool {
    /**
     * @param {object} opts
     * @param {() => any} opts.create   创建新对象
     * @param {(obj:any) => void} [opts.reset]   归还时重置对象状态
     * @param {(obj:any) => void} [opts.dispose] 超容量销毁时释放底层资源
     * @param {number} [opts.initial]   预创建数量
     * @param {number} [opts.max]       池中保留的空闲对象上限
     */
    constructor({ create, reset, dispose, initial = 0, max = 256 } = {}) {
        if (typeof create !== 'function') {
            throw new TypeError('ObjectPool 需要一个 create 工厂函数');
        }
        this._create = create;
        this._reset = typeof reset === 'function' ? reset : null;
        this._dispose = typeof dispose === 'function' ? dispose : null;
        this._max = Math.max(1, max | 0);

        this._free = [];
        this._active = new Set();

        this.createdCount = 0;
        this.acquiredCount = 0;
        this.releasedCount = 0;

        const pre = Math.max(0, Math.min(initial | 0, this._max));
        for (let i = 0; i < pre; i++) {
            this._free.push(this._create());
            this.createdCount++;
        }
    }

    get freeCount() { return this._free.length; }
    get activeCount() { return this._active.size; }

    acquire() {
        let obj;
        if (this._free.length > 0) {
            obj = this._free.pop();
        } else {
            obj = this._create();
            this.createdCount++;
        }
        this._active.add(obj);
        this.acquiredCount++;
        return obj;
    }

    /** 归还对象；重复归还或归还非本池对象会被忽略并告警 */
    release(obj) {
        if (!obj) return false;
        if (!this._active.has(obj)) {
            console.warn('[ObjectPool] 检测到重复归还或非本池对象，已忽略');
            return false;
        }
        this._active.delete(obj);
        this.releasedCount++;

        if (this._reset) {
            try { this._reset(obj); } catch (err) { console.error('[ObjectPool] reset 失败', err); }
        }

        if (this._free.length >= this._max) {
            if (this._dispose) {
                try { this._dispose(obj); } catch (err) { console.error('[ObjectPool] dispose 失败', err); }
            }
            return true;
        }
        this._free.push(obj);
        return true;
    }

    /** 回收全部借出对象（用于重置关卡） */
    releaseAll() {
        for (const obj of Array.from(this._active)) this.release(obj);
    }

    /** 彻底清空池并释放资源 */
    clear() {
        this.releaseAll();
        for (const obj of this._free) {
            if (this._dispose) {
                try { this._dispose(obj); } catch (err) { console.error('[ObjectPool] dispose 失败', err); }
            }
        }
        this._free.length = 0;
    }

    stats() {
        return {
            free: this._free.length,
            active: this._active.size,
            created: this.createdCount,
            acquired: this.acquiredCount,
            released: this.releasedCount
        };
    }
}