/**
 * Monster —— 塔防怪物
 *
 * 行为：从裂隙出发，沿「流场」涌向玩家基地；途中遇到可攻击目标就停下输出。
 *
 * 流场 + A* 的双保险设计（防卡死的关键）：
 *   1. 正常情况下读流场方向，O(1) 定位下一步，100 只怪物也只有一次 BFS 成本；
 *   2. 流场不可用（例如裂隙被完全封死、目标暂不可达）→ 退化为 A* 精确寻路；
 *   3. 依然走不动（被建筑夹住）→ 攻击最近的敌方建筑，用「拆墙」而不是「卡住」来破局。
 *   三层兜底保证任何情况下都不会出现「怪物集体卡在角落」的经典 Bug。
 *
 * 飞行怪物跳过导航网格，直线飞向基地，为塔防增加需要专门应对的威胁。
 */

import { MONSTER_TYPES, TILE_SIZE } from '../config/GameConfig.js';
import { Unit } from './Entity.js';

export class Monster extends Unit {
    constructor(opts = {}) {
        super(opts);

        const cfg = MONSTER_TYPES[opts.monsterType] || MONSTER_TYPES.grunt;
        this.cfg = cfg;
        this.monsterType = cfg.id;
        this.monsterName = opts.displayName || cfg.name;

        this.maxHp = cfg.maxHp;
        this.hp = this.maxHp;
        this.damage = cfg.damage;
        this.moveSpeed = cfg.moveSpeed;
        this.attackRange = cfg.attackRange;
        this.attackInterval = cfg.attackInterval;
        this.radius = cfg.radius;
        this.armor = cfg.armor || 0;

        this.flying = !!cfg.flying;
        this.altitude = cfg.altitude || 0;
        this.aggroRange = Math.max(6, cfg.attackRange + 4);

        this.respawnable = false;
        this.isElite = cfg.id === 'tank' || cfg.id === 'boss';
        this.goldValue = opts.goldValue || 16;
        this.scoreValue = opts.scoreValue || 10;
        this.fromCamp = !!opts.fromCamp;

        this.target = null;
        this.retargetTimer = 0;
        this.stuckTimer = 0;
        this.lastX = this.position.x;
        this.lastZ = this.position.z;
        this.repathTimer = 0;
        this._flow = [0, 0];
    }

    get isMonster() { return true; }

    static buildMesh(shared, cfg, showEyes = true) {
        const THREE = window.THREE;
        const group = new THREE.Group();
        const mat = shared.monsterBody(cfg.id);

        const bodyH = cfg.radius * 1.9;
        const body = new THREE.Mesh(shared.geo('box'), mat);
        body.scale.set(cfg.radius * 1.5, bodyH, cfg.radius * 1.1);
        body.position.y = bodyH * 0.5;
        body.castShadow = true;
        group.add(body);

        const head = new THREE.Mesh(shared.geo('sphereLow'), mat);
        head.scale.setScalar(cfg.radius * 0.62);
        head.position.y = bodyH + cfg.radius * 0.42;
        group.add(head);

        if (showEyes) {
            const eyeMat = shared.material('eye', () => new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
            const eye = new THREE.Mesh(shared.geo('sphereLow'), eyeMat);
            eye.scale.setScalar(cfg.radius * 0.13);
            eye.position.set(cfg.radius * 0.22, bodyH + cfg.radius * 0.5, cfg.radius * 0.5);
            group.add(eye);
            const eye2 = eye.clone();
            eye2.position.x = -cfg.radius * 0.22;
            group.add(eye2);
        }

        if (cfg.id === 'boss') {
            const crown = new THREE.Mesh(shared.geo('cone'), shared.transparentGlow(0xffc85a, 0.8));
            crown.scale.set(cfg.radius * 0.6, cfg.radius * 0.9, cfg.radius * 0.6);
            crown.position.y = bodyH + cfg.radius * 1.2;
            crown.userData.isDetail = true;
            group.add(crown);
        }

        if (cfg.id === 'flying') {
            const ring = new THREE.Mesh(shared.geo('ring'), shared.transparentGlow(0x9fe0ff, 0.5));
            ring.rotation.x = -Math.PI / 2;
            ring.scale.setScalar(cfg.radius * 1.8);
            ring.position.y = -cfg.radius * 0.4;
            ring.userData.isDetail = true;
            group.add(ring);
        }

        return group;
    }

    /* ------------------------------ 目标选择 ------------------------------ */

    _pickTarget() {
        const world = this.ctx ? this.ctx.world : null;
        if (!world) return null;

        // 野怪：只打靠近自己的敌人
        if (this.fromCamp) {
            return world.findNearestEnemyUnit(this, this.aggroRange, { includeStructures: false });
        }

        // 优先打挡路的敌方建筑（含玩家建造的防御塔）
        const blocked = world.findNearestEnemyStructure(this, this.attackRange + 0.8);
        if (blocked) return blocked;

        // 其次打进入攻击范围的敌方单位（英雄/小兵）
        const unit = world.findNearestEnemyUnit(this, this.attackRange + 0.6, { includeStructures: false });
        if (unit) return unit;

        return null;
    }

    _attack(target) {
        const now = performance.now();
        if (now - this.lastAttack < this.attackInterval * 1000) return;
        this.lastAttack = now;

        this.faceTowards(target.position.x, target.position.z, 1);

        const combat = this.ctx ? this.ctx.combat : null;
        if (!combat) return;

        // 重甲/首领的攻击带一点范围伤害，逼迫玩家分散站位
        const splash = (this.monsterType === 'boss') ? 4.5 : 0;
        combat.dealDamage(target, this.damage, this, { splash });
    }

    /* ------------------------------ 推进 ------------------------------ */

    _followFlowOrPath(dt) {
        const world = this.ctx ? this.ctx.world : null;
        if (!world) return;

        const base = world.baseFor(1); // 怪物统一进攻玩家基地
        if (!base) return;

        const distToBase = Math.hypot(
            base.position.x - this.position.x,
            base.position.z - this.position.z
        );
        // 已经贴到基地：直接攻击
        if (distToBase < base.radius + this.attackRange + 1) {
            this.moveTowards(base.position.x, base.position.z, dt);
            return;
        }

        // 飞行单位无视地形
        if (this.flying) {
            this.moveTowards(base.position.x, base.position.z, dt);
            return;
        }

        const flow = this.ctx.flowField;
        let steered = false;

        if (flow && flow.ready) {
            const tx = Math.floor(this.position.x / TILE_SIZE);
            const tz = Math.floor(this.position.z / TILE_SIZE);
            if (flow.readFlow(tx, tz, this._flow)) {
                const targetX = (tx + this._flow[0]) * TILE_SIZE + TILE_SIZE * 0.5;
                const targetZ = (tz + this._flow[1]) * TILE_SIZE + TILE_SIZE * 0.5;
                this.moveTowards(targetX, targetZ, dt);
                steered = true;
            }
        }

        if (!steered) {
            // 流场失效：退化为 A* 精确定位
            this.repathTimer -= dt;
            if (this.repathTimer <= 0 || !this.hasDestination) {
                this.repathTimer = 3;
                this.setDestination(base.position.x, base.position.z, this.ctx.pathfinder);
            }
            if (this.hasDestination) {
                this.followPath(dt);
                steered = true;
            }
        }

        if (!steered) {
            // 最后一层兜底：直线冲向基地（tryMove 仍会处理障碍滑行）
            this.moveTowards(base.position.x, base.position.z, dt);
        }
    }

    update(dt) {
        if (!this.alive) return;

        this.updateStatus(dt);

        if (this.stunTimer > 0) {
            this.updateGroundHeight();
            return;
        }

        this.retargetTimer -= dt;
        if (this.retargetTimer <= 0 || !this.target || !this.target.alive) {
            this.retargetTimer = 0.35;
            this.target = this._pickTarget();
        }

        if (this.target && this.target.alive) {
            const d = this.distanceToEntity(this.target);
            if (d <= this.attackRange + 0.35) {
                this._attack(this.target);
            } else {
                this.moveTowards(this.target.position.x, this.target.position.z, dt);
            }
        } else {
            this._followFlowOrPath(dt);
        }

        this.updateGroundHeight();

        // 卡死检测：位置几乎没变时启动兜底策略
        const moved = Math.hypot(this.position.x - this.lastX, this.position.z - this.lastZ);
        if (moved < 0.02 && (!this.target || !this.target.alive)) {
            this.stuckTimer += dt;
            if (this.stuckTimer > 2.5) {
                this.stuckTimer = 0;
                this._breakout();
            }
        } else {
            this.stuckTimer = 0;
        }
        this.lastX = this.position.x;
        this.lastZ = this.position.z;
    }

    /** 破局：攻击附近最近的敌方建筑；没有则强制重新寻路 */
    _breakout() {
        const world = this.ctx ? this.ctx.world : null;
        if (!world) return;

        const structure = world.findNearestEnemyStructure(this, 26);
        if (structure) {
            this.target = structure;
            this.retargetTimer = 2.0;
            return;
        }
        this.repathTimer = 0;
        this.path = null;
        if (this.ctx.pathfinder) {
            this.setDestination(
                world.baseFor(1).position.x,
                world.baseFor(1).position.z,
                this.ctx.pathfinder
            );
        }
    }
}