/**
 * Hero —— 英雄单位（玩家或 AI 控制）
 *
 * 职责边界：
 *  - 只负责「自身状态 + 技能释放 + 普攻」，不搜索全局目标池的实现细节，
 *    目标查询统一委托给 ctx.world（World 内置空间网格，避免 O(n^2)）。
 *  - 伤害结算委托给 ctx.combat，视觉表现委托给 ctx.effects。
 *    这样英雄逻辑不依赖具体系统实现，便于替换。
 *
 * 技能系统：数据驱动。GameConfig 里每个技能声明 type，
 * 这里用 _ABILITY_HANDLERS 分发表执行，新增技能只需加一个处理器。
 */

import { HEROES, TEAM, ECONOMY } from '../config/GameConfig.js';
import { Unit } from './Entity.js';
import { clamp } from '../core/MathUtils.js';

const MAX_LEVEL = 15;

export class Hero extends Unit {
    constructor(opts = {}) {
        super(opts);

        const cfg = HEROES[opts.heroId];
        if (!cfg) throw new Error(`未知英雄: ${opts.heroId}`);

        this.heroId = cfg.id;
        this.cfg = cfg;
        this.heroName = cfg.name;
        this.role = cfg.role;
        this.isPlayer = !!opts.isPlayer;
        this.respawnable = true;

        this.baseMaxHp = cfg.maxHp;
        this.baseDamage = cfg.damage;
        this.baseMoveSpeed = cfg.moveSpeed;
        this.hpRegen = cfg.hpRegen;
        this.ranged = !!cfg.ranged;
        this.projectileColor = cfg.projectileColor || 0xffffff;

        this.moveSpeed = cfg.moveSpeed;
        this.damage = cfg.damage;
        this.attackRange = cfg.attackRange;
        this.attackInterval = cfg.attackInterval;
        this.radius = cfg.radius;
        this.armor = cfg.armor || 0;

        this.level = 1;
        this.xp = 0;

        // 金币升级带来的倍率
        this.upgrades = { damage: 0, maxHp: 0, moveSpeed: 0, cooldown: 0 };
        this.damageMul = 1;
        this.hpMul = 1;
        this.speedMul = 1;
        this.cdMul = 1;

        this.abilities = cfg.abilities.map((a) => ({
            data: a,
            remaining: 0,
            // 每秒冷却进度，供 UI 画环形进度
            progress: 1
        }));

        this.attackTarget = null;
        this.forcedTarget = null;
        this.attackMovePoint = null;
        this.respawnTimer = 0;
        this.respawnDelay = 0;

        this.kills = 0;
        this.deaths = 0;

        this.applyUpgradesToStats();
        this.hp = this.maxHp;
    }

    get isHero() { return true; }

    /* ------------------------------ 建模 ------------------------------ */

    /**
     * 构建英雄模型。使用共享几何体 + scale，不产生额外几何体。
     */
    static buildMesh(shared, cfg, team) {
        const THREE = window.THREE;
        const group = new THREE.Group();

        const bodyMat = shared.heroBody(cfg.id, cfg.color);
        const accentMat = shared.heroAccent(cfg.id, cfg.accent);
        const skinMat = shared.heroSkin();
        const metalMat = shared.material('gunMetal', () => new THREE.MeshLambertMaterial({ color: 0x2b2f36 }));

        const body = new THREE.Mesh(shared.geo('box'), bodyMat);
        body.scale.set(0.74, 0.98, 0.52);
        body.position.y = 0.62;
        body.castShadow = true;
        group.add(body);

        const shoulders = new THREE.Mesh(shared.geo('box'), accentMat);
        shoulders.scale.set(0.92, 0.16, 0.56);
        shoulders.position.y = 1.02;
        group.add(shoulders);

        const head = new THREE.Mesh(shared.geo('sphere'), skinMat);
        head.scale.setScalar(0.26);
        head.position.y = 1.34;
        head.castShadow = true;
        group.add(head);

        const helmet = new THREE.Mesh(shared.geo('cone'), bodyMat);
        helmet.scale.set(0.3, 0.26, 0.3);
        helmet.position.y = 1.5;
        group.add(helmet);

        // 武器：远程职业枪管更细长
        const weapon = new THREE.Mesh(shared.geo('box'), metalMat);
        if (cfg.ranged) {
            weapon.scale.set(0.1, 0.1, 1.05);
            weapon.position.set(0.4, 0.86, 0.28);
        } else {
            weapon.scale.set(0.11, 0.11, 0.86);
            weapon.position.set(0.42, 0.78, 0.2);
        }
        group.add(weapon);

        const arm = new THREE.Mesh(shared.geo('box'), bodyMat);
        arm.scale.set(0.16, 0.5, 0.16);
        arm.position.set(0.38, 0.78, 0.06);
        group.add(arm);

        // 脚下阵营光环：MOBA 必备的敌我识别手段
        const ring = new THREE.Mesh(shared.geo('ring'), shared.transparentGlow(
            team === TEAM.PLAYER ? 0x4ea6ff : 0xff5a5a, 0.55
        ));
        ring.rotation.x = -Math.PI / 2;
        ring.scale.setScalar(cfg.radius * 1.7);
        ring.position.y = 0.06;
        ring.userData.isDetail = true;   // 远距离 LOD 会隐藏
        group.add(ring);

        return group;
    }

    /* ------------------------------ 属性成长 ------------------------------ */

    applyUpgradesToStats() {
        const list = ECONOMY.heroUpgrades;
        let damageMul = 1;
        let hpMul = 1;
        let speedMul = 1;
        let cdMul = 1;
        for (const up of list) {
            const lv = this.upgrades[up.key] || 0;
            if (lv <= 0) continue;
            if (up.key === 'damage') damageMul = 1 + up.step * lv;
            else if (up.key === 'maxHp') hpMul = 1 + up.step * lv;
            else if (up.key === 'moveSpeed') speedMul = 1 + up.step * lv;
            else if (up.key === 'cooldown') cdMul = 1 / (1 + up.step * lv);
        }

        // 等级成长
        const lvBonus = 1 + (this.level - 1) * 0.045;
        const hpBonus = 1 + (this.level - 1) * 0.06;

        this.damageMul = damageMul * lvBonus;
        this.hpMul = hpMul * hpBonus;
        this.speedMul = speedMul;
        this.cdMul = cdMul;

        const oldMax = this.maxHp;
        this.maxHp = Math.round(this.baseMaxHp * this.hpMul);
        this.damage = this.baseDamage * this.damageMul;
        this.moveSpeed = this.baseMoveSpeed * this.speedMul;

        if (this.maxHp > oldMax) this.hp += (this.maxHp - oldMax);
        this.hp = clamp(this.hp, 0, this.maxHp);
    }

    gainXp(amount) {
        if (!Number.isFinite(amount) || amount <= 0) return;
        this.xp += amount;
        const needed = this.level * 120;
        while (this.level < MAX_LEVEL && this.xp >= needed) {
            this.xp -= needed;
            this.level++;
            this.applyUpgradesToStats();
            if (this.alive) this.hp = this.maxHp;
            if (this.ctx && this.ctx.bus) {
                this.ctx.bus.emit('hero:levelUp', { hero: this });
            }
        }
    }

    /** 购买金币升级，返回是否成功 */
    applyUpgrade(key) {
        const def = ECONOMY.heroUpgrades.find((u) => u.key === key);
        if (!def) return { ok: false, reason: '未知升级项' };
        const lv = this.upgrades[key] || 0;
        if (lv >= def.maxLevel) return { ok: false, reason: '已达上限' };
        const cost = Math.round(def.base * Math.pow(def.growth, lv));
        return { ok: true, cost, def };
    }

    commitUpgrade(key) {
        this.upgrades[key] = (this.upgrades[key] || 0) + 1;
        this.applyUpgradesToStats();
        if (key === 'maxHp') this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.15);
    }

    upgradeCost(key) {
        const def = ECONOMY.heroUpgrades.find((u) => u.key === key);
        if (!def) return Infinity;
        const lv = this.upgrades[key] || 0;
        if (lv >= def.maxLevel) return Infinity;
        return Math.round(def.base * Math.pow(def.growth, lv));
    }

    /* ------------------------------ 技能 ------------------------------ */

    get abilityCooldownMultiplier() {
        return this.cdMul;
    }

    canCast(index) {
        if (!this.alive || this.stunTimer > 0) return false;
        const slot = this.abilities[index];
        if (!slot) return false;
        return slot.remaining <= 0;
    }

    /**
     * 释放技能。
     * @param {number} index 技能槽
     * @param {number} aimX 目标点 X
     * @param {number} aimZ 目标点 Z
     * @returns {boolean} 是否成功释放
     */
    castAbility(index, aimX, aimZ) {
        const slot = this.abilities[index];
        if (!slot || !this.canCast(index)) return false;

        const data = slot.data;
        const handler = _ABILITY_HANDLERS[data.type];
        if (!handler) {
            console.warn(`[Hero] 未实现的技能类型: ${data.type}`);
            return false;
        }

        // 目标点限制在施法距离内
        let tx = aimX;
        let tz = aimZ;
        if (data.range > 0) {
            const dx = aimX - this.position.x;
            const dz = aimZ - this.position.z;
            const d = Math.hypot(dx, dz);
            const maxRange = data.range;
            if (d > maxRange && d > 0.0001) {
                tx = this.position.x + (dx / d) * maxRange;
                tz = this.position.z + (dz / d) * maxRange;
            }
        } else {
            tx = this.position.x;
            tz = this.position.z;
        }

        const ok = handler(this, data, tx, tz);
        if (!ok) return false;

        slot.remaining = data.cooldown * this.abilityCooldownMultiplier;
        slot.progress = 0;
        this.clearDestination();
        this.forcedTarget = null;

        if (this.ctx && this.ctx.bus) {
            this.ctx.bus.emit('hero:cast', { hero: this, ability: data, x: tx, z: tz });
        }
        return true;
    }

    /** 技能就绪进度 0..1，供 UI 显示 */
    abilityProgress(index) {
        const slot = this.abilities[index];
        if (!slot) return 1;
        const total = slot.data.cooldown * this.abilityCooldownMultiplier;
        if (total <= 0) return 1;
        return clamp(1 - slot.remaining / total, 0, 1);
    }

    /* ------------------------------ 普攻 ------------------------------ */

    /** 选定攻击目标：优先强制目标，其次最近敌方单位，最后敌方建筑 */
    acquireTarget() {
        const world = this.ctx ? this.ctx.world : null;
        if (!world) return null;

        if (this.forcedTarget && this.forcedTarget.alive && this.distanceToEntity(this.forcedTarget) <= this.attackRange + 1.5) {
            return this.forcedTarget;
        }

        const range = this.attackRange;
        const unit = world.findNearestEnemyUnit(this, range, { includeStructures: false });
        if (unit) return unit;

        return world.findNearestEnemyStructure(this, range);
    }

    performAttack(target) {
        if (!target || !target.alive) return;
        const now = performance.now();
        const interval = this.attackInterval * 1000;
        if (now - this.lastAttack < interval) return;
        this.lastAttack = now;

        this.faceTowards(target.position.x, target.position.z, 1);

        const combat = this.ctx ? this.ctx.combat : null;
        if (!combat) return;

        if (this.ranged) {
            combat.spawnProjectile({
                source: this,
                target,
                x: this.position.x,
                y: this.groundY + 1.05,
                z: this.position.z,
                speed: 46,
                damage: this.damage,
                color: this.projectileColor,
                homing: true
            });
        } else {
            combat.dealDamage(target, this.damage, this);
            if (this.ctx.effects) {
                this.ctx.effects.slash(
                    (this.position.x + target.position.x) * 0.5,
                    this.groundY + 1.0,
                    (this.position.z + target.position.z) * 0.5,
                    this.facing
                );
            }
        }
    }

    /* ------------------------------ 死亡与复活 ------------------------------ */

    handleDeath() {
        this.deaths++;
        this.alive = false;
        this.attackTarget = null;
        this.forcedTarget = null;
        this.clearDestination();
        this.respawnDelay = 8 + this.level * 1.2;
        this.respawnTimer = this.respawnDelay;
        this.shield = 0;
        this.slowTimer = 0;
        this.slowFactor = 1;
        this.stunTimer = 0;
        if (this.mesh) this.mesh.visible = false;
        if (this.healthBar) this.healthBar.visible = false;
    }

    respawn() {
        const world = this.ctx ? this.ctx.world : null;
        const base = world ? world.baseFor(this.team) : null;
        if (base) {
            const angle = Math.random() * Math.PI * 2;
            const r = 6 + Math.random() * 3;
            this.position.set(base.position.x + Math.cos(angle) * r, 0, base.position.z + Math.sin(angle) * r);
        }
        this.groundY = 0;
        this.hp = this.maxHp;
        this.alive = true;
        this.removed = false;
        this.respawnTimer = 0;
        for (const slot of this.abilities) {
            slot.remaining = 0;
            slot.progress = 1;
        }
        this.updateGroundHeight();
        if (this.mesh) this.mesh.visible = true;
        if (this.healthBar) this.healthBar.visible = true;
    }

    /* ------------------------------ 每帧 ------------------------------ */

    update(dt) {
        if (!this.alive) {
            if (this.respawnTimer > 0) {
                this.respawnTimer -= dt;
                if (this.respawnTimer <= 0) this.respawn();
            }
            return;
        }

        this.updateStatus(dt);

        // 冷却
        for (const slot of this.abilities) {
            if (slot.remaining > 0) {
                slot.remaining -= dt;
                if (slot.remaining <= 0) slot.remaining = 0;
                slot.progress = this.abilityProgress(this.abilities.indexOf(slot));
            }
        }

        // 生命回复
        if (this.hp < this.maxHp) this.heal(this.hpRegen * dt);

        if (this.stunTimer > 0) {
            this.updateGroundHeight();
            return;
        }

        // 移动
        if (this.hasDestination) {
            const arrived = this.followPath(dt);
            if (arrived) {
                this.clearDestination();
                if (this.attackMovePoint) this.attackMovePoint = null;
            }
        }

        // 攻击
        const target = this.acquireTarget();
        this.attackTarget = target;
        if (target) {
            const d = this.distanceToEntity(target);
            if (d <= this.attackRange + 0.4) {
                this.performAttack(target);
            } else if (!this.hasDestination) {
                // 目标超出射程但视野内：自动靠近（追击）
                this.moveTowards(target.position.x, target.position.z, dt);
            }
        }

        this.updateGroundHeight();
    }
}

/* ============================== 技能处理器 ============================== */

/**
 * 每个处理器签名：(hero, data, tx, tz) => boolean
 * 返回 false 表示释放失败（不进入冷却）。
 */
const _ABILITY_HANDLERS = {
    /** 突进：向目标点冲刺，对沿途与落点敌人造成伤害 */
    dash(hero, data, tx, tz) {
        const combat = hero.ctx ? hero.ctx.combat : null;
        if (!combat) return false;

        const dx = tx - hero.position.x;
        const dz = tz - hero.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.2) return false;

        const dirX = dx / dist;
        const dirZ = dz / dist;

        // 分步推进，遇到不可通行地形就停在原地，避免穿墙
        const stepLen = 0.6;
        let travelled = 0;
        while (travelled < dist) {
            const step = Math.min(stepLen, dist - travelled);
            const nx = hero.position.x + dirX * step;
            const nz = hero.position.z + dirZ * step;
            if (!hero.canStand(nx, nz)) break;
            hero.position.x = nx;
            hero.position.z = nz;
            travelled += step;
        }
        hero.facing = Math.atan2(dirX, dirZ);
        hero.updateGroundHeight();

        // 对沿途敌人造成伤害
        if (data.damage > 0) {
            const victims = hero.ctx.world.queryEnemiesNear(
                hero.position.x, hero.position.z, (data.radius || 3) + 1.6, hero.team
            );
            for (const v of victims) {
                combat.dealDamage(v, data.damage * hero.damageMul, hero);
                if (data.stun) v.applyStun(data.stun);
            }
        }

        if (hero.ctx.effects) {
            hero.ctx.effects.ring(hero.position.x, hero.groundY + 0.3, hero.position.z, data.radius || 3, data.color || 0x9fd8ff);
        }
        return true;
    },

    /** 以自身为中心的圆形范围伤害 */
    aoeSelf(hero, data) {
        const combat = hero.ctx ? hero.ctx.combat : null;
        if (!combat) return false;

        const victims = hero.ctx.world.queryEnemiesNear(
            hero.position.x, hero.position.z, data.radius, hero.team
        );
        for (const v of victims) {
            combat.dealDamage(v, data.damage * hero.damageMul, hero);
            if (data.stun) v.applyStun(data.stun);
        }
        if (hero.ctx.effects) {
            hero.ctx.effects.explosion(hero.position.x, hero.groundY + 0.4, hero.position.z, data.radius, 0xffd27a);
        }
        return true;
    },

    /** 指定点范围伤害（可多段） */
    aoePoint(hero, data, tx, tz) {
        const combat = hero.ctx ? hero.ctx.combat : null;
        if (!combat) return false;

        const ticks = Math.max(1, data.ticks || 1);
        const perTick = data.damage * hero.damageMul / ticks;

        const apply = () => {
            if (!combat.isRunning()) return;
            const victims = hero.ctx.world.queryEnemiesNear(tx, tz, data.radius, hero.team);
            for (const v of victims) combat.dealDamage(v, perTick, hero);
            if (hero.ctx.effects) {
                // 爆炸高度取目标点地形高度，而非施法者所在位置
                const ty = hero.ctx.terrain ? hero.ctx.terrain.heightAt(tx, tz) : hero.groundY;
                hero.ctx.effects.explosion(tx, ty + 0.3, tz, data.radius * 0.7, data.color || 0xffb347);
            }
        };

        apply();
        if (ticks > 1) {
            for (let i = 1; i < ticks; i++) {
                hero.ctx.world.schedule(i * 0.35, apply);
            }
        }
        return true;
    },

    /** 直线穿透弹道 */
    line(hero, data, tx, tz) {
        const combat = hero.ctx ? hero.ctx.combat : null;
        if (!combat) return false;

        const dx = tx - hero.position.x;
        const dz = tz - hero.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.0001) return false;

        const dirX = dx / d;
        const dirZ = dz / d;

        const victims = hero.ctx.world.queryEnemiesNear(
            hero.position.x + dirX * d * 0.5,
            hero.position.z + dirZ * d * 0.5,
            d * 0.5 + (data.radius || 1.5),
            hero.team
        );

        for (const v of victims) {
            // 判断是否落在直线走廊内
            const vx = v.position.x - hero.position.x;
            const vz = v.position.z - hero.position.z;
            const proj = vx * dirX + vz * dirZ;
            if (proj < -0.5 || proj > d + 1) continue;
            const perp = Math.abs(vx * (-dirZ) + vz * dirX);
            if (perp > (data.radius || 1.5) + (v.radius || 0.5)) continue;
            combat.dealDamage(v, data.damage * hero.damageMul, hero);
        }

        if (hero.ctx.effects) {
            hero.ctx.effects.beam(
                hero.position.x, hero.groundY + 1.0, hero.position.z,
                tx, hero.groundY + 1.0, tz,
                data.color || 0xcfffe0
            );
        }
        return true;
    },

    /** 位移（闪现） */
    blink(hero, data, tx, tz) {
        const before = { x: hero.position.x, z: hero.position.z };
        if (hero.canStand(tx, tz)) {
            hero.position.x = tx;
            hero.position.z = tz;
        } else {
            // 目标点不可站立时，回退到半程
            const mx = (before.x + tx) * 0.5;
            const mz = (before.z + tz) * 0.5;
            if (hero.canStand(mx, mz)) {
                hero.position.x = mx;
                hero.position.z = mz;
            }
        }
        hero.updateGroundHeight();
        if (hero.ctx.effects) {
            hero.ctx.effects.ring(before.x, hero.groundY + 0.4, before.z, 2.2, 0x9fe8ff);
            hero.ctx.effects.ring(hero.position.x, hero.groundY + 0.4, hero.position.z, 2.2, 0x9fe8ff);
        }
        return true;
    },

    /** 护盾 */
    shield(hero, data) {
        hero.addShield(data.shield, data.duration);
        if (hero.ctx.effects) {
            hero.ctx.effects.ring(hero.position.x, hero.groundY + 0.6, hero.position.z, hero.radius * 2.4, 0x7fd4ff);
        }
        return true;
    },

    /** 减速区域 */
    slowZone(hero, data, tx, tz) {
        const combat = hero.ctx ? hero.ctx.combat : null;
        if (!combat) return false;
        const x = data.selfCentered ? hero.position.x : tx;
        const z = data.selfCentered ? hero.position.z : tz;
        combat.spawnZone({
            x, z,
            radius: data.radius,
            duration: data.duration,
            team: hero.team,
            slow: data.slow,
            damagePerSecond: data.damage ? data.damage * hero.damageMul / Math.max(0.5, data.duration) : 0,
            color: data.color || 0x9fe8ff,
            source: hero
        });
        return true;
    }
};