/**
 * CombatSystem —— 伤害结算 / 投射物 / 区域效果
 *
 * 唯一的伤害入口。所有系统（英雄技能、塔、怪物、小兵）都通过这里结算，
 * 带来三个好处：
 *   1. 死亡只会在一个地方被判定，杜绝「同帧多次伤害导致重复发奖励」；
 *   2. 护盾、护甲、溅射、减速等规则只实现一次；
 *   3. 掉落/赏金/经验逻辑集中，方便调平衡。
 *
 * 投射物使用对象池，命中判定用线段检测（见 Projectile.js 注释）。
 */

import { EVT } from '../core/EventBus.js';
import { ObjectPool } from '../core/ObjectPool.js';
import { Projectile, segmentPointDistSq } from '../entities/Projectile.js';
import { ECONOMY } from '../config/GameConfig.js';

export class CombatSystem {
    constructor(ctx = {}) {
        this.scene = ctx.scene || null;
        this.world = ctx.world || null;
        this.shared = ctx.shared || null;
        this.bus = ctx.bus || null;
        this.effects = ctx.effects || null;
        this.economy = ctx.economy || null;
        this.terrain = ctx.terrain || null;

        this.active = false;
        this.activeProjectiles = [];
        this.zones = [];

        this.stats = { projectilesSpawned: 0, damageEvents: 0, kills: 0 };

        this.pool = new ObjectPool({
            create: () => new Projectile(this.shared),
            reset: (p) => p.reset(),
            dispose: (p) => p.dispose(),
            initial: 48,
            max: 600
        });

        // 复用缓冲区
        this._hitBuffer = [];
        this._zoneBuffer = [];
    }

    setActive(active) {
        this.active = !!active;
    }

    isRunning() {
        return this.active;
    }

    /* ------------------------------ 投射物 ------------------------------ */

    spawnProjectile(opts) {
        if (!this.scene || !this.shared) return null;
        const p = this.pool.acquire();
        p.init(opts);
        this.scene.add(p.mesh);
        this.activeProjectiles.push(p);
        this.stats.projectilesSpawned++;
        return p;
    }

    _releaseProjectile(index) {
        const p = this.activeProjectiles[index];
        if (!p) return;
        if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
        this.pool.release(p);
        this.activeProjectiles.splice(index, 1);
    }

    clearProjectiles() {
        for (let i = this.activeProjectiles.length - 1; i >= 0; i--) this._releaseProjectile(i);
        this.pool.releaseAll();
    }

    updateProjectiles(dt) {
        for (let i = this.activeProjectiles.length - 1; i >= 0; i--) {
            const p = this.activeProjectiles[i];
            if (!p) {
                this.activeProjectiles.splice(i, 1);
                continue;
            }
            let alive = false;
            try {
                alive = p.update(dt, this);
            } catch (err) {
                console.error('[CombatSystem] 投射物更新异常，已回收', err);
                alive = false;
            }
            if (!alive) {
                if (p.position && this.effects) this.effects.impact(p.position.x, p.position.y, p.position.z, 0xffe0a0);
                this._releaseProjectile(i);
            }
        }
    }

    /**
     * 判定投射物本帧是否命中目标。
     * 使用「上一帧位置 -> 当前位置」这条线段与候选目标求最近距离，
     * 因此即使单帧位移很大也不会穿透。
     * @returns {boolean} 是否命中（命中后投射物应被回收）
     */
    resolveProjectileHit(projectile) {
        const world = this.world;
        if (!world) return false;

        const p = projectile;
        const a = p.prevPosition;
        const b = p.position;

        const midX = (a.x + b.x) * 0.5;
        const midZ = (a.z + b.z) * 0.5;
        const half = Math.hypot(b.x - a.x, b.z - a.z) * 0.5;

        const buffer = this._hitBuffer;
        buffer.length = 0;
        world.spatial.queryCircle(midX, midZ, half + 6, buffer);

        let best = null;
        let bestT = Infinity;

        for (let i = 0; i < buffer.length; i++) {
            const e = buffer[i];
            if (!e || !e.alive || e === p.source) continue;
            if (e.team === p.team) continue;

            const hitR = (e.isStructure ? e.radius * 0.9 : e.radius + 0.35) + p.hitRadiusBonus;
            const rSq = hitR * hitR;

            // 建筑体量大，用中心点线段距离即可；单位取躯干中心
            const cx = e.position.x;
            const cy = (e.isStructure ? e.position.y + e.radius * 0.6 : e.groundY + 0.8);
            const cz = e.position.z;

            const dSq = segmentPointDistSq(a.x, a.y, a.z, b.x, b.y, b.z, cx, cy, cz);
            if (dSq > rSq) continue;

            // 取沿弹道最早命中的那个，避免“穿透近处打远处”
            const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
            const abLenSq = abx * abx + aby * aby + abz * abz;
            let t = 0;
            if (abLenSq > 1e-8) {
                t = ((cx - a.x) * abx + (cy - a.y) * aby + (cz - a.z) * abz) / abLenSq;
                t = Math.max(0, Math.min(1, t));
            }
            if (t < bestT) {
                bestT = t;
                best = e;
            }
        }

        if (!best) {
            // 撞地检测：弹道钻进地形就消失
            if (this.terrain) {
                const groundH = this.terrain.heightAt(b.x, b.z);
                if (b.y <= groundH + 0.15) {
                    if (this.effects) this.effects.impact(b.x, groundH + 0.2, b.z, 0xd8d0b0);
                    return true;
                }
            }
            return false;
        }

        this._applyProjectileDamage(p, best);
        return true;
    }

    _applyProjectileDamage(projectile, target) {
        const splash = projectile.splash;
        const impactX = target.position.x;
        const impactZ = target.position.z;
        const impactY = target.isStructure ? target.position.y + 1.2 : target.groundY + 0.9;

        if (splash > 0) {
            const victims = this.world.queryEnemiesNear(impactX, impactZ, splash, projectile.team);
            for (const v of victims) {
                const isPrimary = v === target;
                const dmg = isPrimary ? projectile.damage : projectile.damage * 0.6;
                this.dealDamage(v, dmg, projectile.source);
                if (projectile.slow > 0) v.applySlow(1 - projectile.slow, projectile.slowDuration);
            }
            if (this.effects) this.effects.explosion(impactX, impactY, impactZ, splash, projectile.mesh ? projectile.mesh.material.color.getHex() : 0xffaa55);
        } else {
            this.dealDamage(target, projectile.damage, projectile.source);
            if (projectile.slow > 0) target.applySlow(1 - projectile.slow, projectile.slowDuration);
            if (this.effects) {
                this.effects.impact(impactX, impactY, impactZ, projectile.mesh ? projectile.mesh.material.color.getHex() : 0xffffff);
            }
        }
    }

    /* ------------------------------ 伤害结算 ------------------------------ */

    /**
     * @param {import('../entities/Entity.js').Entity} target
     * @param {number} amount
     * @param {import('../entities/Entity.js').Entity|null} source
     * @param {object} [opts] { splash }
     * @returns {number} 实际伤害
     */
    dealDamage(target, amount, source = null, opts = {}) {
        if (!this.active) return 0;
        if (!target || !target.alive) return 0;

        const dealt = target.takeDamage(amount, source);
        if (dealt <= 0) return 0;

        this.stats.damageEvents++;
        if (this.bus) {
            this.bus.emit(EVT.ENTITY_DAMAGED, { entity: target, source, amount: dealt });
        }

        // 溅射（近战怪物的范围攻击）
        if (opts.splash > 0) {
            const others = this.world.queryEnemiesNear(target.position.x, target.position.z, opts.splash, target.team);
            for (const v of others) {
                if (v === target) continue;
                v.takeDamage(amount * 0.5, source);
            }
        }

        if (!target.alive) this._handleDeath(target, source);
        return dealt;
    }

    _handleDeath(target, killer) {
        // 防止同一帧内被多个伤害源重复结算
        if (target._deathHandled) return;
        target._deathHandled = true;
        this.stats.kills++;

        if (typeof target.onDeath === 'function') {
            try {
                target.onDeath(killer);
            } catch (err) {
                console.error('[CombatSystem] onDeath 回调出错', err);
            }
        }

        this._awardKill(target, killer);

        if (this.effects) {
            const y = target.isStructure ? target.position.y + 1.5 : target.groundY + 0.7;
            this.effects.explosion(target.position.x, y, target.position.z,
                Math.max(1.5, target.radius * 2), target.isStructure ? 0xffb347 : 0xff7a6a);
        }
        if (this.bus) this.bus.emit(EVT.ENTITY_DIED, { entity: target, killer });

        // 英雄可复活：不销毁；其余实体交给 World 清理
        if (!target.respawnable) this.world.destroy(target);
    }

    _awardKill(target, killer) {
        const economy = this.economy;
        if (!economy) return;

        let gold = target.goldValue;
        let score = target.scoreValue;

        // 按实体类别兜底取值，避免漏配字段导致奖励为 0
        if (gold === undefined || gold === null) {
            if (target.isMonster) gold = ECONOMY.gold.monster;
            else if (target.isMinion) gold = target.bountyGold || ECONOMY.gold.minion;
            else if (target.isHero) gold = ECONOMY.gold.hero;
            else if (target.isStructure) gold = ECONOMY.gold.tower;
            else gold = 0;
        }
        if (score === undefined || score === null) {
            score = target.isHero ? ECONOMY.score.hero : (target.isStructure ? ECONOMY.score.tower : ECONOMY.score.monster);
        }

        // 击杀方阵营获得金币；未指定来源时归一为中立
        const team = killer ? killer.team : 0;
        economy.awardKillGold(team, gold, target);
        economy.awardScore(score);

        // 经验：击杀者附近的友方英雄共享
        if (killer && killer.isHero) killer.gainXp(Math.max(8, Math.round(score * 1.2)));
        this._shareXpNear(target, team, Math.max(10, Math.round(score * 0.8)));
    }

    _shareXpNear(target, team, xp) {
        const world = this.world;
        if (!world) return;
        const allies = world.queryAlliesNear(target.position.x, target.position.z, 26, team);
        for (const a of allies) {
            if (a.isHero) a.gainXp(xp);
        }
    }

    /* ------------------------------ 区域效果 ------------------------------ */

    /**
     * 生成一个持续区域（减速/灼烧）。
     * 视觉与逻辑都在这里维护，避免分散到多个系统。
     */
    spawnZone(opts) {
        if (!this.scene || !this.shared) return null;
        const THREE = window.THREE;

        const mesh = new THREE.Mesh(
            this.shared.geo('ring'),
            new THREE.MeshBasicMaterial({
                color: opts.color || 0x9fe8ff,
                transparent: true,
                opacity: 0.4,
                depthWrite: false,
                side: THREE.DoubleSide
            })
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.scale.setScalar(opts.radius);
        mesh.position.set(opts.x, (this.terrain ? this.terrain.heightAt(opts.x, opts.z) : 0) + 0.12, opts.z);
        this.scene.add(mesh);

        const zone = {
            x: opts.x,
            z: opts.z,
            radius: opts.radius,
            duration: opts.duration,
            remaining: opts.duration,
            team: opts.team,
            slow: opts.slow || 0,
            damagePerSecond: opts.damagePerSecond || 0,
            source: opts.source || null,
            mesh,
            tickTimer: 0,
            tickInterval: 0.25
        };
        this.zones.push(zone);
        return zone;
    }

    updateZones(dt) {
        for (let i = this.zones.length - 1; i >= 0; i--) {
            const z = this.zones[i];
            z.remaining -= dt;
            if (z.remaining <= 0) {
                this._disposeZone(z);
                this.zones.splice(i, 1);
                continue;
            }

            // 呼吸式视觉反馈
            if (z.mesh) {
                const pulse = 1 + Math.sin(z.remaining * 6) * 0.03;
                z.mesh.scale.setScalar(z.radius * pulse);
                z.mesh.material.opacity = 0.18 + 0.25 * (z.remaining / Math.max(0.001, z.duration));
            }

            z.tickTimer -= dt;
            if (z.tickTimer > 0) continue;
            z.tickTimer = z.tickInterval;

            const victims = this.world.queryEnemiesNear(z.x, z.z, z.radius, z.team);
            for (const v of victims) {
                if (z.slow > 0) v.applySlow(1 - z.slow, 0.5);
                if (z.damagePerSecond > 0) {
                    this.dealDamage(v, z.damagePerSecond * z.tickInterval, z.source);
                }
            }
        }
    }

    _disposeZone(zone) {
        if (!zone || !zone.mesh) return;
        if (zone.mesh.parent) zone.mesh.parent.remove(zone.mesh);
        if (zone.mesh.material && typeof zone.mesh.material.dispose === 'function') {
            zone.mesh.material.dispose();
        }
        zone.mesh = null;
    }

    clearZones() {
        for (const z of this.zones) this._disposeZone(z);
        this.zones.length = 0;
    }

    /* ------------------------------ 生命周期 ------------------------------ */

    update(dt) {
        if (!this.active) return;
        this.updateProjectiles(dt);
        this.updateZones(dt);
    }

    reset() {
        this.clearProjectiles();
        this.clearZones();
        this.stats.projectilesSpawned = 0;
        this.stats.damageEvents = 0;
        this.stats.kills = 0;
    }
}