/**
 * Entity —— 所有游戏对象的基类（含 Unit / Structure 两个抽象分支）
 *
 * 继承结构：
 *   Entity
 *    ├─ Unit       可移动单位：Hero / Minion / Monster
 *    └─ Structure  固定建筑：WarTower / Base / DefenseTower
 *
 * 设计约定：
 *  - 实体不持有场景、寻路、经济系统的引用，只通过构造时传入的 ctx 访问，
 *    并且只使用其中稳定的接口（terrain / nav / pathfinder / flowField）。
 *  - 死亡不在这里处理：takeDamage 只修改状态并返回实际伤害，
 *    由 CombatSystem 统一判定死亡、发放奖励、回收对象。避免「回声式」重复结算。
 *  - 所有共享几何体/材质由 EntityFactory 提供，实体自身不 new 材质，
 *    从根上杜绝「每生成一个单位就泄漏一份材质」的问题。
 */

import { TEAM, TILE_SIZE } from '../config/GameConfig.js';
import { clamp } from '../core/MathUtils.js';

let _nextEntityId = 1;

export function resetEntityIds() {
    _nextEntityId = 1;
}

export class Entity {
    constructor(opts = {}) {
        this.id = _nextEntityId++;
        this.type = opts.type || 'entity';
        this.team = opts.team === undefined ? TEAM.NEUTRAL : opts.team;

        this.position = new THREE.Vector3(opts.x || 0, opts.y || 0, opts.z || 0);
        this.radius = opts.radius === undefined ? 0.6 : opts.radius;

        this.maxHp = Math.max(1, opts.maxHp === undefined ? 100 : opts.maxHp);
        this.hp = this.maxHp;
        this.armor = clamp(opts.armor || 0, 0, 0.85);

        this.alive = true;
        this.removed = false;   // 由系统在清理阶段置位并从数组移除

        this.shield = 0;
        this.shieldTimer = 0;
        this.slowFactor = 1;
        this.slowTimer = 0;
        this.stunTimer = 0;
        this.hitFlash = 0;

        this.mesh = null;
        this.healthBar = null;
        this._healthBarFill = null;
        this._healthBarVisible = false;

        this.ctx = opts.ctx || null;
        this.onDeath = null;    // 由生成方注入的回调

        this.groundY = this.position.y;
        this.facing = 0;
    }

    get isAlive() { return this.alive; }
    get isStructure() { return false; }
    get isUnit() { return false; }
    get isFlying() { return false; }
    get isHero() { return false; }
    get isMinion() { return false; }
    get isMonster() { return false; }
    get isBase() { return false; }
    get isWarTower() { return false; }
    get isDefenseTower() { return false; }

    get hpRatio() {
        return this.maxHp > 0 ? clamp(this.hp / this.maxHp, 0, 1) : 0;
    }

    /** 是否处于无法行动状态 */
    get isStunned() { return this.stunTimer > 0; }

    /* ------------------------------ 生命值 ------------------------------ */

    /**
     * 造成伤害。
     * @param {number} amount 原始伤害
     * @param {Entity|null} source 伤害来源
     * @returns {number} 实际造成的伤害
     */
    takeDamage(amount, source = null) {
        if (!this.alive) return 0;
        const raw = Number(amount);
        if (!Number.isFinite(raw) || raw <= 0) return 0;

        let damage = raw * (1 - this.armor);

        // 护盾优先吸收
        if (this.shield > 0) {
            const absorbed = Math.min(this.shield, damage);
            this.shield -= absorbed;
            damage -= absorbed;
            if (this.shield <= 0) {
                this.shield = 0;
                this.shieldTimer = 0;
            }
        }

        if (damage <= 0) {
            this.hitFlash = 0.09;
            return 0;
        }

        this.hp -= damage;
        this.hitFlash = 0.12;
        if (this.hp < 0) this.hp = 0;
        if (this.hp === 0) this.alive = false;

        this._lastDamageSource = source || null;
        return damage;
    }

    heal(amount) {
        if (!this.alive) return 0;
        const before = this.hp;
        this.hp = Math.min(this.maxHp, this.hp + Math.max(0, amount));
        return this.hp - before;
    }

    addShield(amount, duration) {
        if (!this.alive) return;
        this.shield = Math.max(this.shield, amount);
        this.shieldTimer = Math.max(this.shieldTimer, duration);
    }

    applySlow(factor, duration) {
        if (!this.alive) return;
        const f = clamp(factor, 0.05, 1);
        // 取更强的减速效果，避免多次减速叠加成完全定身
        if (f < this.slowFactor || this.slowTimer <= 0) this.slowFactor = f;
        this.slowTimer = Math.max(this.slowTimer, duration);
    }

    applyStun(duration) {
        if (!this.alive) return;
        this.stunTimer = Math.max(this.stunTimer, duration);
    }

    /* ------------------------------ 每帧状态 ------------------------------ */

    /** 处理增益/减益计时与受击反馈，子类的 update 应先调用它 */
    updateStatus(dt) {
        if (this.slowTimer > 0) {
            this.slowTimer -= dt;
            if (this.slowTimer <= 0) {
                this.slowTimer = 0;
                this.slowFactor = 1;
            }
        }
        if (this.stunTimer > 0) this.stunTimer -= dt;
        if (this.shieldTimer > 0) {
            this.shieldTimer -= dt;
            if (this.shieldTimer <= 0) {
                this.shieldTimer = 0;
                this.shield = 0;
            }
        }
        if (this.hitFlash > 0) this.hitFlash -= dt;
    }

    /** 受击缩放反馈（复用缩放而非改材质，避免为单位克隆材质） */
    updateHitFeedback() {
        if (!this.mesh) return;
        if (this.hitFlash > 0) {
            const s = 1 + Math.min(0.25, this.hitFlash * 1.4);
            this.mesh.scale.setScalar(s);
        } else if (this.mesh.scale.x !== 1) {
            this.mesh.scale.setScalar(1);
        }
    }

    /* ------------------------------ 血条 ------------------------------ */

    attachHealthBar(shared, opts = {}) {
        if (!shared || !shared.healthBarGeo) return;
        const THREE = window.THREE;

        const width = opts.width || 1.1;
        const y = opts.y || 1.9;

        const group = new THREE.Group();
        const bg = new THREE.Mesh(shared.healthBarGeo, shared.healthBarBg);
        bg.scale.set(width, 1, 1);

        const fill = new THREE.Mesh(shared.healthBarGeo, shared.healthBarFillFor(this.team));
        fill.scale.set(width, 1, 1);
        fill.position.z = 0.01;

        group.add(bg);
        group.add(fill);
        group.position.y = y;
        group.renderOrder = 50;

        this.mesh.add(group);
        this.healthBar = group;
        this._healthBarFill = fill;
        this._healthBarWidth = width;
        this._healthBarBg = bg;
        this._healthBarVisible = true;
        this.updateHealthBar();
    }

    updateHealthBar() {
        if (!this._healthBarFill) return;
        const ratio = this.hpRatio + (this.shield > 0 ? Math.min(0.35, this.shield / this.maxHp) : 0);
        const r = clamp(ratio, 0, 1);
        const width = this._healthBarWidth || 1.1;
        this._healthBarFill.scale.x = Math.max(0.001, width * r);
        // 左对齐：把填充块向左平移，使缩放锚点落在左端
        this._healthBarFill.position.x = -(width * (1 - r)) * 0.5;
        if (this._healthBarBg) this._healthBarBg.scale.x = width;
    }

    /** 血条始终面向摄像机 */
    billboardHealthBar(camera) {
        if (!this.healthBar || !camera) return;
        this.healthBar.quaternion.copy(camera.quaternion);
    }

    setHealthBarVisible(visible) {
        if (!this.healthBar) return;
        if (this._healthBarVisible === visible) return;
        this._healthBarVisible = visible;
        this.healthBar.visible = visible;
    }

    /* ------------------------------ 距离 ------------------------------ */

    /** 与目标的平面距离（中心到中心） */
    distanceTo(entity) {
        if (!entity || !entity.position) return Infinity;
        const dx = entity.position.x - this.position.x;
        const dz = entity.position.z - this.position.z;
        return Math.hypot(dx, dz);
    }

    /**
     * 与目标的「可攻击距离」。
     * 建筑体积大，直接比中心距离会让近战永远够不到，
     * 因此减去建筑半径的一部分作为补偿。
     */
    distanceToEntity(entity) {
        if (!entity || !entity.position) return Infinity;
        const dx = entity.position.x - this.position.x;
        const dz = entity.position.z - this.position.z;
        const d = Math.hypot(dx, dz);
        return Math.max(0, d - (entity.isStructure ? entity.radius * 0.8 : 0));
    }

    /* ------------------------------ 死亡与生命周期 ------------------------------ */

    update() { /* 子类实现 */ }

    /** 把逻辑坐标同步到渲染对象 */
    syncMesh() {
        if (!this.mesh) return;
        this.mesh.position.set(this.position.x, this.groundY, this.position.z);
        this.mesh.rotation.y = this.facing;
    }

    /** 从场景移除。几何体/材质为共享资源，默认不销毁 */
    dispose() {
        if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
        this.mesh = null;
        this.healthBar = null;
        this._healthBarFill = null;
        this._healthBarBg = null;
        this.alive = false;
        this.removed = true;
    }
}

/* ============================== Unit ============================== */

export class Unit extends Entity {
    constructor(opts = {}) {
        super(opts);

        this.moveSpeed = opts.moveSpeed === undefined ? 6 : opts.moveSpeed;
        this.attackRange = opts.attackRange === undefined ? 2 : opts.attackRange;
        this.attackInterval = opts.attackInterval === undefined ? 1 : opts.attackInterval;
        this.damage = opts.damage === undefined ? 10 : opts.damage;
        this.lastAttack = 0;

        this.path = null;       // 世界坐标路点数组
        this.pathIndex = 0;
        this.destination = null;
        this.repathTimer = 0;
        this.blockedTime = 0;

        this.facingTarget = null;
        this.terrain = opts.ctx ? opts.ctx.terrain : null;
        this.nav = opts.ctx ? opts.ctx.nav : null;
    }

    get isUnit() { return true; }
    get isFlying() { return !!this.flying; }

    /** 考虑减速/眩晕后的实际速度 */
    get currentSpeed() {
        if (this.stunTimer > 0) return 0;
        return Math.max(0, this.moveSpeed * this.slowFactor);
    }

    get hasDestination() {
        return this.path !== null && this.pathIndex < this.path.length;
    }

    /* ------------------------------ 移动 ------------------------------ */

    /** 设置寻路目标（世界坐标） */
    setDestination(x, z, pathfinder) {
        this.destination = { x, z };
        this.path = null;
        this.pathIndex = 0;
        this.repathTimer = 0;

        if (!pathfinder) {
            this.path = [{ x, z }];
            return true;
        }
        const path = pathfinder.findPathWorld(this.position.x, this.position.z, x, z);
        if (path && path.length > 0) {
            this.path = path;
            return true;
        }
        // 寻路失败时退化为直线目标，避免单位「站住不动」
        this.path = [{ x, z }];
        return false;
    }

    clearDestination() {
        this.destination = null;
        this.path = null;
        this.pathIndex = 0;
    }

    /** 沿路径前进，返回是否已到达 */
    followPath(dt) {
        if (!this.path) return true;
        const speed = this.currentSpeed;
        if (speed <= 0) return false;

        let remaining = speed * dt;
        let guard = 0;

        while (remaining > 0 && this.pathIndex < this.path.length && guard++ < 32) {
            const wp = this.path[this.pathIndex];
            const dx = wp.x - this.position.x;
            const dz = wp.z - this.position.z;
            const d = Math.hypot(dx, dz);

            if (d < 0.35) {
                this.pathIndex++;
                continue;
            }

            const step = Math.min(remaining, d);
            const ux = dx / d;
            const uz = dz / d;
            this.faceTowards(this.position.x + ux * 10, this.position.z + uz * 10, dt);

            const moved = this.tryMove(ux * step, uz * step);
            if (!moved) {
                // 被挡住：略微侧向滑动，避免原地卡死
                const slid = this.tryMove(-uz * step * 0.6, ux * step * 0.6)
                    || this.tryMove(uz * step * 0.6, -ux * step * 0.6);
                if (!slid) {
                    this.blockedTime += dt;
                    break;
                }
            } else {
                this.blockedTime = 0;
            }
            remaining -= step;
        }

        if (this.pathIndex >= this.path.length) {
            this.path = null;
            this.pathIndex = 0;
            return true;
        }
        return false;
    }

    /**
     * 尝试位移；先整体移动，失败则分轴滑动。
     * 这让单位沿墙壁滑行而不是硬生生卡住。
     */
    tryMove(dx, dz) {
        if (dx === 0 && dz === 0) return true;
        const px = this.position.x;
        const pz = this.position.z;

        if (this.canStand(px + dx, pz + dz)) {
            this.position.x = px + dx;
            this.position.z = pz + dz;
            return true;
        }
        if (this.canStand(px + dx, pz)) {
            this.position.x = px + dx;
            return true;
        }
        if (this.canStand(px, pz + dz)) {
            this.position.z = pz + dz;
            return true;
        }
        return false;
    }

    canStand(x, z) {
        if (this.flying) return true;
        if (!this.nav) return true;
        return this.nav.isWalkable(Math.floor(x / TILE_SIZE), Math.floor(z / TILE_SIZE));
    }

    /** 无视寻路，直接朝某点直线移动（追击用） */
    moveTowards(x, z, dt) {
        const speed = this.currentSpeed;
        if (speed <= 0) return false;
        const dx = x - this.position.x;
        const dz = z - this.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.001) return true;
        const step = Math.min(speed * dt, d);
        this.faceTowards(x, z, dt);
        this.tryMove((dx / d) * step, (dz / d) * step);
        return d - step < 0.3;
    }

    /** 平滑转向 */
    faceTowards(x, z, dt) {
        const dx = x - this.position.x;
        const dz = z - this.position.z;
        if (Math.abs(dx) < 0.0001 && Math.abs(dz) < 0.0001) return;
        const target = Math.atan2(dx, dz);
        let diff = target - this.facing;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const turn = Math.min(1, dt * 9);
        this.facing += diff * turn;
    }

    /** 把单位贴合地形高度 */
    updateGroundHeight() {
        if (!this.terrain) return;
        const h = this.terrain.heightAt(this.position.x, this.position.z);
        const target = this.flying ? h + (this.altitude || 3) : h;
        // 平滑贴地，避免高地起伏时视觉抖动
        this.groundY += (target - this.groundY) * 0.35;
    }

    update(dt) {
        this.updateStatus(dt);
        if (this.hasDestination && this.stunTimer <= 0) {
            this.followPath(dt);
        }
        this.updateGroundHeight();
    }
}

/* ============================== Structure ============================== */

export class Structure extends Entity {
    constructor(opts = {}) {
        super(opts);
        this.blockRadiusTiles = opts.blockRadiusTiles === undefined ? 2 : opts.blockRadiusTiles;
        this._blockedTiles = null;
        this.nav = opts.ctx ? opts.ctx.nav : null;
        this.buildProgress = 1;
    }

    get isStructure() { return true; }

    /** 把建筑压在导航网格上（会触发流场失效） */
    occupy() {
        if (!this.nav || this._blockedTiles) return;
        this._blockedTiles = this.nav.blockCircle(this.position.x, this.position.z, this.blockRadiusTiles);
    }

    /** 解除对导航网格的占用 */
    release() {
        if (!this.nav || !this._blockedTiles) return;
        this.nav.releaseTiles(this._blockedTiles);
        this._blockedTiles = null;
    }

    dispose() {
        this.release();
        super.dispose();
    }
}