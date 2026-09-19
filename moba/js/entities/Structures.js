/**
 * Structures —— 固定建筑：兵线防御塔 / 基地 / 玩家建造的防御塔
 *
 * 共同点：不可移动、占用导航网格、周期性地自动攻击范围内敌人。
 * 因此抽出 _StructureCombat 这一层共享逻辑，避免三份重复的索敌代码。
 *
 * 关键点：建筑在构造时会 occupy() 导航网格，销毁时 release()，
 * 并让 NavGrid.version 自增，从而通知流场重算 —— 玩家建塔会真实地改变怪物路线。
 */

import { WAR_TOWER, BASE_STRUCTURE, DEFENSE_TOWERS, TEAM, BUILD } from '../config/GameConfig.js';
import { Structure } from './Entity.js';

/* ============================== 共享的战斗逻辑 ============================== */

class CombatStructure extends Structure {
    constructor(opts = {}) {
        super(opts);
        this.attackDamage = opts.attackDamage || 0;
        this.attackRange = opts.attackRange || 0;
        this.attackInterval = opts.attackInterval || 1;
        this.lastAttack = 0;
        this.target = null;
        this.retargetTimer = 0;

        // 供子类定制弹道表现
        this.projectileColor = opts.projectileColor || 0xffffff;
        this.projectileSpeed = opts.projectileSpeed || 44;
        this.projectileHeight = opts.projectileHeight || 2;
        this.splash = opts.splash || 0;
        this.slow = opts.slow || 0;
        this.slowDuration = opts.slowDuration || 0;
    }

    _pickTarget() {
        const world = this.ctx ? this.ctx.world : null;
        if (!world || this.attackRange <= 0) return null;
        return world.findNearestEnemyUnit(this, this.attackRange, { includeStructures: false });
    }

    updateCombat(dt) {
        if (!this.alive || this.attackDamage <= 0 || this.attackRange <= 0) return;

        this.retargetTimer -= dt;
        if (this.retargetTimer <= 0 || !this.target || !this.target.alive) {
            this.retargetTimer = 0.3;
            this.target = this._pickTarget();
        }

        const target = this.target;
        if (!target || !target.alive) return;

        const d = this.distanceToEntity(target);
        if (d > this.attackRange) return;

        this.onTargetAcquired(target);

        const now = performance.now();
        if (now - this.lastAttack < this.attackInterval * 1000) return;
        this.lastAttack = now;
        this.fireAt(target);
    }

    /** 子类可覆写：炮塔转头等表现 */
    onTargetAcquired() { /* 默认无 */ }

    fireAt(target) {
        const combat = this.ctx ? this.ctx.combat : null;
        if (!combat) return;
        combat.spawnProjectile({
            source: this,
            target,
            x: this.position.x,
            y: this.groundY + this.projectileHeight,
            z: this.position.z,
            speed: this.projectileSpeed,
            damage: this.attackDamage,
            color: this.projectileColor,
            homing: true,
            splash: this.splash,
            slow: this.slow,
            slowDuration: this.slowDuration
        });
    }

    update(dt) {
        this.updateStatus(dt);
        this.updateCombat(dt);
        this.updateHitFeedback();
    }
}

/* ============================== 兵线防御塔 ============================== */

export class WarTower extends CombatStructure {
    constructor(opts = {}) {
        super(opts);
        this.towerType = 'war';
        this.tier = opts.tier || 1;
        this.laneId = opts.laneId || 'mid';

        const stats = WAR_TOWER.stats[this.tier] || WAR_TOWER.stats[1];
        this.stats = stats;

        this.maxHp = stats.maxHp;
        this.hp = this.maxHp;
        this.attackDamage = stats.damage;
        this.attackRange = stats.attackRange;
        this.attackInterval = stats.attackInterval;
        this.radius = stats.radius;
        this.blockRadiusTiles = WAR_TOWER.blockTiles;
        this.projectileColor = this.team === TEAM.PLAYER ? 0x7fc4ff : 0xff8a7a;

        this.goldValue = WAR_TOWER.deathGold;
        this.scoreValue = WAR_TOWER.deathScore;
        this.respawnable = false;
    }

    get isWarTower() { return true; }

    static buildMesh(shared, team, tier) {
        const THREE = window.THREE;
        const group = new THREE.Group();
        const shade = (tier - 1) * 0.1;
        const baseMat = shared.teamMaterial('warTowerBase', team, shade);
        const trimMat = shared.teamMaterial('warTowerTrim', team, shade + 0.25);

        const pedestal = new THREE.Mesh(shared.geo('cylinder'), baseMat);
        pedestal.scale.set(2.2, 0.7, 2.2);
        pedestal.position.y = 0.35;
        pedestal.castShadow = true;
        pedestal.receiveShadow = true;
        group.add(pedestal);

        const shaft = new THREE.Mesh(shared.geo('cylinder'), baseMat);
        shaft.scale.set(1.15, 3.0, 1.15);
        shaft.position.y = 2.2;
        shaft.castShadow = true;
        group.add(shaft);

        const crown = new THREE.Mesh(shared.geo('cone'), trimMat);
        crown.scale.set(1.5, 1.4, 1.5);
        crown.position.y = 4.4;
        group.add(crown);

        const crystal = new THREE.Mesh(shared.geo('sphere'), shared.transparentGlow(
            team === TEAM.PLAYER ? 0x8fd4ff : 0xffa08f, 0.85
        ));
        crystal.scale.setScalar(0.5 + tier * 0.1);
        crystal.position.y = 5.1;
        group.add(crystal);

        return group;
    }
}

/* ============================== 基地（Nexus） ============================== */

export class Base extends CombatStructure {
    constructor(opts = {}) {
        super(opts);
        this.structureType = 'base';
        this.maxHp = BASE_STRUCTURE.maxHp;
        this.hp = this.maxHp;
        this.attackDamage = BASE_STRUCTURE.damage;
        this.attackRange = BASE_STRUCTURE.attackRange;
        this.attackInterval = BASE_STRUCTURE.attackInterval;
        this.radius = BASE_STRUCTURE.radius;
        this.blockRadiusTiles = BASE_STRUCTURE.blockTiles;
        this.projectileColor = this.team === TEAM.PLAYER ? 0x8fd4ff : 0xff9a8f;
        this.projectileSpeed = 50;
        this.projectileHeight = 4.4;
        this.scoreValue = BASE_STRUCTURE.deathScore;
        this.respawnable = false;

        this.displayName = opts.displayName || (this.team === TEAM.PLAYER ? '蓝方基地' : '红方基地');
    }

    get isBase() { return true; }

    static buildMesh(shared, team) {
        const THREE = window.THREE;
        const group = new THREE.Group();
        const baseMat = shared.teamMaterial('baseBody', team, 0);
        const trimMat = shared.teamMaterial('baseTrim', team, 0.3);

        const platform = new THREE.Mesh(shared.geo('cylinder'), baseMat);
        platform.scale.set(5.6, 0.8, 5.6);
        platform.position.y = 0.4;
        platform.receiveShadow = true;
        group.add(platform);

        const ring = new THREE.Mesh(shared.geo('cylinder'), trimMat);
        ring.scale.set(4.2, 1.1, 4.2);
        ring.position.y = 1.2;
        group.add(ring);

        const pillarCount = 4;
        for (let i = 0; i < pillarCount; i++) {
            const angle = (i / pillarCount) * Math.PI * 2;
            const pillar = new THREE.Mesh(shared.geo('box'), baseMat);
            pillar.scale.set(0.7, 4.4, 0.7);
            pillar.position.set(Math.cos(angle) * 3.1, 2.9, Math.sin(angle) * 3.1);
            pillar.castShadow = true;
            group.add(pillar);
        }

        // 核心水晶：用八面体，视觉上立刻区别于普通塔
        const coreGeo = shared.material('baseCoreGeo', () => new THREE.MeshLambertMaterial({
            color: team === TEAM.PLAYER ? 0x5ec8ff : 0xff7a6a,
            emissive: team === TEAM.PLAYER ? 0x1b5f8f : 0x8f2b1f,
            emissiveIntensity: 0.6
        }));
        const crystal = new THREE.Mesh(shared.geo('sphere'), coreGeo);
        crystal.scale.set(1.5, 2.6, 1.5);
        crystal.position.y = 4.2;
        group.add(crystal);

        return group;
    }
}

/* ============================== 玩家建造的防御塔 ============================== */

export class DefenseTower extends CombatStructure {
    constructor(opts = {}) {
        super(opts);
        this.structureType = 'defense';
        this.towerId = opts.towerId || 'arrow';
        this.config = DEFENSE_TOWERS[this.towerId];
        if (!this.config) throw new Error(`未知防御塔类型: ${this.towerId}`);

        this.tier = 1;
        this.radius = 1.7;
        this.blockRadiusTiles = 1;
        this.respawnable = false;
        this.turret = null;
        this.turretAngle = 0;
        this.investedGold = opts.investedGold || this.config.cost;

        this.refreshStats();
        this.hp = this.maxHp;
    }

    get isDefenseTower() { return true; }

    refreshStats() {
        const tierStats = this.config.tiers[this.tier - 1] || this.config.tiers[0];
        this.tierStats = tierStats;
        const prevRatio = this.maxHp > 0 ? this.hp / this.maxHp : 1;

        this.maxHp = tierStats.maxHp;
        this.attackDamage = tierStats.damage;
        this.attackRange = tierStats.attackRange;
        this.attackInterval = tierStats.attackInterval;
        this.projectileColor = this.config.projectileColor;
        this.splash = this.config.splash || 0;
        this.slow = this.config.slow || 0;
        this.slowDuration = this.config.slowDuration || 0;
        this.projectileSpeed = this.config.splash ? 34 : 52;

        // 升级时按比例保留当前血量，避免升级反而“回血”
        this.hp = Math.min(this.maxHp, this.maxHp * prevRatio + (this.maxHp - this.maxHp * prevRatio) * 0.35);
    }

    get canUpgrade() {
        return this.tier < this.config.tiers.length;
    }

    get upgradeCost() {
        if (!this.canUpgrade) return Infinity;
        return this.tierStats.upgradeCost;
    }

    get sellValue() {
        return Math.round(this.investedGold * BUILD.refundRatio);
    }

    upgrade() {
        if (!this.canUpgrade) return false;
        this.tier++;
        this.refreshStats();
        return true;
    }

    static buildMesh(shared, towerId, tier) {
        const THREE = window.THREE;
        const group = new THREE.Group();
        const mat = shared.defenseTowerMaterial(towerId, tier);
        const dark = shared.material('gunMetal', () => new THREE.MeshLambertMaterial({ color: 0x2b2f36 }));

        const base = new THREE.Mesh(shared.geo('cylinder'), dark);
        base.scale.set(1.5, 0.5, 1.5);
        base.position.y = 0.25;
        base.receiveShadow = true;
        group.add(base);

        const body = new THREE.Mesh(shared.geo('box'), mat);
        body.scale.set(1.2, 1.5, 1.2);
        body.position.y = 1.25;
        body.castShadow = true;
        group.add(body);

        const turret = new THREE.Group();
        turret.position.y = 2.2 + tier * 0.15;

        if (towerId === 'arrow') {
            const barrel = new THREE.Mesh(shared.geo('box'), dark);
            barrel.scale.set(0.22, 0.22, 1.7);
            barrel.position.z = 0.7;
            turret.add(barrel);
        } else if (towerId === 'cannon') {
            const barrel = new THREE.Mesh(shared.geo('cylinder'), dark);
            barrel.scale.set(0.42, 2.0, 0.42);
            barrel.rotation.x = Math.PI / 2;
            barrel.position.z = 0.85;
            turret.add(barrel);
        } else {
            const crystal = new THREE.Mesh(shared.geo('sphere'), shared.transparentGlow(0xbdf0ff, 0.9));
            crystal.scale.setScalar(0.85 + tier * 0.12);
            turret.add(crystal);
        }

        const head = new THREE.Mesh(shared.geo('cylinder'), mat);
        head.scale.set(0.72, 0.5, 0.72);
        turret.add(head);

        group.add(turret);

        const ring = new THREE.Mesh(shared.geo('ring'), shared.transparentGlow(0x63c8ff, 0.35));
        ring.rotation.x = -Math.PI / 2;
        ring.scale.setScalar(1.6);
        ring.position.y = 0.06;
        ring.userData.isDetail = true;
        group.add(ring);

        group.userData.turret = turret;
        return group;
    }

    /** 炮塔转向目标 */
    onTargetAcquired(target) {
        if (!this.turret || !target) return;
        const dx = target.position.x - this.position.x;
        const dz = target.position.z - this.position.z;
        this.turretAngle = Math.atan2(dx, dz);
    }

    update(dt) {
        super.update(dt);
        if (this.turret) {
            let diff = this.turretAngle - this.turret.rotation.y;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.turret.rotation.y += diff * Math.min(1, dt * 8);
        }
    }
}