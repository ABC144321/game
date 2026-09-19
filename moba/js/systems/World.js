/**
 * World —— 实体容器 + 查询中心 + 定时器
 *
 * 为什么需要它？
 *   如果每个单位都自己持有 entities 数组并互相遍历，模块之间会形成网状耦合，
 *   新增一种单位就要改动多处。World 把「谁在哪里」这件事收敛到一处，
 *   实体只需要向 ctx.world 提问，不关心数据是怎么组织的。
 *
 * 更新顺序（顺序本身就是一类 Bug 的来源）：
 *   1. 重建空间网格（保证本帧查询看到的是最新位置）
 *   2. 更新全部实体
 *   3. 统一清理死亡实体 —— 绝不在遍历过程中修改数组
 *   4. 推进定时器
 */

import { TEAM } from '../config/GameConfig.js';
import { SpatialGrid } from './SpatialGrid.js';

export class World {
    constructor(opts = {}) {
        this.scene = opts.scene || null;
        this.terrain = opts.terrain || null;
        this.nav = opts.nav || null;
        this.pathfinder = opts.pathfinder || null;
        this.flowField = opts.flowField || null;
        this.bus = opts.bus || null;

        this.heroes = [];
        this.minions = [];
        this.monsters = [];
        this.structures = [];
        this.units = [];       // heroes + minions + monsters
        this.all = [];         // units + structures

        /** @type {{PLAYER: import('../entities/Structures.js').Base|null, ENEMY: any}} */
        this.bases = { [TEAM.PLAYER]: null, [TEAM.ENEMY]: null };

        this.spatial = new SpatialGrid(16);
        this._timers = [];
        this._entitiesSpawned = 0;
        this._entitiesDestroyed = 0;

        // 复用的查询缓冲，避免每次查询都新建数组
        this._scratch = [];
    }

    /* ------------------------------ 增删 ------------------------------ */

    add(entity) {
        if (!entity) return null;
        if (entity.isStructure) {
            this.structures.push(entity);
            if (entity.isBase) this.bases[entity.team] = entity;
        } else if (entity.isUnit) {
            this.units.push(entity);
            // 按类型归类，便于各系统分别迭代
            if (entity.isHero) this.heroes.push(entity);
            else if (entity.isMonster) this.monsters.push(entity);
            else this.minions.push(entity);
        }
        this.all.push(entity);
        this._entitiesSpawned++;
        if (this.scene && entity.mesh) this.scene.add(entity.mesh);
        if (this.bus) this.bus.emit('entity:spawned', { entity });
        return entity;
    }

    /** 标记为待销毁；真正的移除发生在 cleanup() */
    destroy(entity) {
        if (!entity || entity.removed) return;
        entity.removed = true;
    }

    _removeFromList(list, entity) {
        const idx = list.indexOf(entity);
        if (idx >= 0) list.splice(idx, 1);
    }

    cleanup() {
        for (let i = this.all.length - 1; i >= 0; i--) {
            const e = this.all[i];
            if (!e || !e.removed) continue;

            this._removeFromList(this.all, e);
            this._removeFromList(this.units, e);
            this._removeFromList(this.structures, e);
            this._removeFromList(this.heroes, e);
            this._removeFromList(this.minions, e);
            this._removeFromList(this.monsters, e);

            if (e.isBase) {
                if (this.bases[e.team] === e) this.bases[e.team] = null;
            }

            e.dispose();
            this._entitiesDestroyed++;
        }
    }

    /* ------------------------------ 每帧 ------------------------------ */

    update(dt) {
        this.spatial.rebuild(this.units);
        for (let i = 0; i < this.structures.length; i++) this.spatial.insert(this.structures[i]);

        // 先单位后建筑：建筑本帧就能命中刚刚被更新的单位状态
        for (let i = 0; i < this.units.length; i++) {
            const u = this.units[i];
            if (!u) continue;
            u.update(dt);
        }
        for (let i = 0; i < this.structures.length; i++) {
            const s = this.structures[i];
            if (!s) continue;
            s.update(dt);
        }

        this.cleanup();
        this._tickTimers(dt);
    }

    /** 只做视觉同步（渲染阶段调用，频率高于逻辑更新） */
    syncMeshes() {
        for (let i = 0; i < this.units.length; i++) {
            const u = this.units[i];
            if (u && u.alive) u.syncMesh();
        }
        for (let i = 0; i < this.structures.length; i++) {
            const s = this.structures[i];
            if (s) s.syncMesh();
        }
    }

    /* ------------------------------ 定时器 ------------------------------ */

    /** 延时执行；返回取消函数。用于技能多段伤害、波次调度等 */
    schedule(delay, fn) {
        if (typeof fn !== 'function') return () => {};
        const timer = { remaining: Math.max(0, delay), fn, cancelled: false };
        this._timers.push(timer);
        return () => { timer.cancelled = true; };
    }

    _tickTimers(dt) {
        if (this._timers.length === 0) return;
        for (let i = this._timers.length - 1; i >= 0; i--) {
            const t = this._timers[i];
            if (!t || t.cancelled) {
                this._timers.splice(i, 1);
                continue;
            }
            t.remaining -= dt;
            if (t.remaining > 0) continue;
            this._timers.splice(i, 1);
            try {
                t.fn();
            } catch (err) {
                console.error('[World] 定时器回调出错', err);
            }
        }
        // 兜底：定时器数量异常增长时告警（正常情况下远小于该值）
        if (this._timers.length > 2000) {
            console.warn('[World] 定时器数量异常，已清空以防内存增长');
            this._timers.length = 0;
        }
    }

    clearTimers() {
        for (const t of this._timers) t.cancelled = true;
        this._timers.length = 0;
    }

    /* ------------------------------ 查询 ------------------------------ */

    static isHostile(a, b) {
        if (!a || !b) return false;
        return a.team !== b.team;
    }

    baseFor(team) {
        return this.bases[team] || null;
    }

    /** 收集半径内的敌对单位/建筑 */
    queryEnemiesNear(x, z, radius, team, opts = {}) {
        const includeStructures = opts.includeStructures !== false;
        const buffer = [];
        this.spatial.queryCircle(x, z, radius, buffer);

        const out = [];
        for (let i = 0; i < buffer.length; i++) {
            const e = buffer[i];
            if (!e || !e.alive) continue;
            if (e.team === team) continue;
            if (!includeStructures && e.isStructure) continue;
            if (!this._passesFilter(e, opts)) continue;
            out.push(e);
        }
        return out;
    }

    queryAlliesNear(x, z, radius, team) {
        const buffer = [];
        this.spatial.queryCircle(x, z, radius, buffer);
        const out = [];
        for (let i = 0; i < buffer.length; i++) {
            const e = buffer[i];
            if (!e || !e.alive) continue;
            if (e.team !== team) continue;
            if (e.isStructure) continue;
            out.push(e);
        }
        return out;
    }

    _passesFilter(e, opts) {
        if (opts.excludeFlying && e.isFlying) return false;
        if (opts.onlyStructures && !e.isStructure) return false;
        if (opts.onlyUnits && e.isStructure) return false;
        return true;
    }

    /** 最近的敌对单位（不含建筑） */
    findNearestEnemyUnit(from, range, opts = {}) {
        const buffer = [];
        this.spatial.queryCircle(from.position.x, from.position.z, range, buffer);

        let best = null;
        let bestDist = Infinity;
        for (let i = 0; i < buffer.length; i++) {
            const e = buffer[i];
            if (!e || !e.alive || e === from) continue;
            if (e.team === from.team) continue;
            if (e.isStructure) continue;
            if (opts.excludeFlying && e.isFlying) continue;

            const dx = e.position.x - from.position.x;
            const dz = e.position.z - from.position.z;
            const d = dx * dx + dz * dz;
            if (d < bestDist) {
                bestDist = d;
                best = e;
            }
        }
        return best;
    }

    /** 最近的敌对建筑 */
    findNearestEnemyStructure(from, range) {
        const buffer = [];
        this.spatial.queryCircle(from.position.x, from.position.z, range, buffer);

        let best = null;
        let bestDist = Infinity;
        for (let i = 0; i < buffer.length; i++) {
            const e = buffer[i];
            if (!e || !e.alive || e === from) continue;
            if (e.team === from.team) continue;
            if (!e.isStructure) continue;

            const dx = e.position.x - from.position.x;
            const dz = e.position.z - from.position.z;
            // 建筑体积大，用「到边缘的距离」比较更符合直觉
            const d = Math.max(0, Math.hypot(dx, dz) - e.radius);
            if (d < bestDist) {
                bestDist = d;
                best = e;
            }
        }
        return best;
    }

    /** 最近的敌对目标（单位优先，其次建筑） */
    findNearestEnemy(from, range) {
        const unit = this.findNearestEnemyUnit(from, range);
        if (unit) return unit;
        return this.findNearestEnemyStructure(from, range);
    }

    /* ------------------------------ 统计 ------------------------------ */

    stats() {
        return {
            heroes: this.heroes.length,
            minions: this.minions.length,
            monsters: this.monsters.length,
            structures: this.structures.length,
            total: this.all.length,
            spawned: this._entitiesSpawned,
            destroyed: this._entitiesDestroyed,
            timers: this._timers.length,
            gridCells: this.spatial.cellCount
        };
    }

    /** 完全清空（重开局） */
    reset() {
        this.clearTimers();
        for (const e of this.all.slice()) {
            e.dispose();
        }
        this.heroes.length = 0;
        this.minions.length = 0;
        this.monsters.length = 0;
        this.structures.length = 0;
        this.units.length = 0;
        this.all.length = 0;
        this.bases[TEAM.PLAYER] = null;
        this.bases[TEAM.ENEMY] = null;
        this.spatial.clear();
    }
}