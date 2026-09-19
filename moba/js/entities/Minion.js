/**
 * Minion —— MOBA 兵线小兵
 *
 * 行为：沿所属兵线的折线路径推进，遇到敌人停下交战，清完继续推进。
 *
 * 为什么不用 A*？
 *   每波 20+ 只小兵，如果每只都跑 A* 会给主线程造成明显抖动。
 *   兵线走廊在地形生成阶段已经被整平，因此沿着「折线路径 + 横向偏移」
 *   推进既稳定又几乎零成本。这与塔防怪物使用流场是同一思路：
 *   把「路径求解」从「每个单位」下移到「预计算」。
 */

import { MINION_TYPES } from '../config/GameConfig.js';
import { Unit } from './Entity.js';
import { polylinePoint, polylineTangent, polylineSegments, clamp } from '../core/MathUtils.js';

const _pt = [0, 0];
const _tan = [0, 0];

export class Minion extends Unit {
    constructor(opts = {}) {
        super(opts);

        const cfg = MINION_TYPES[opts.minionType] || MINION_TYPES.melee;
        this.cfg = cfg;
        this.minionType = cfg.id;
        this.minionName = cfg.name;
        this.ranged = !!cfg.ranged;
        this.structureMultiplier = cfg.structureMultiplier || 1;
        this.bountyGold = cfg.grieveGold || 13;

        this.maxHp = cfg.maxHp;
        this.hp = this.maxHp;
        this.damage = cfg.damage;
        this.moveSpeed = cfg.moveSpeed;
        this.attackRange = cfg.attackRange;
        this.attackInterval = cfg.attackInterval;
        this.radius = cfg.radius;

        this.respawnable = false;
        this.aggroRange = Math.max(7, cfg.attackRange + 5);

        this.laneId = opts.laneId || 'mid';
        this.lanePoints = opts.lanePoints || null;
        this.dir = opts.dir === undefined ? 1 : opts.dir; // 1: 玩家方向, -1: 敌方方向
        this.laneT = this.dir > 0 ? 0 : 1;
        this.lateralOffset = opts.lateralOffset || 0;
        this.laneLength = this.lanePoints ? polylineSegments(this.lanePoints).total : 1;

        this.target = null;
        this.retargetTimer = 0;
    }

    get isMinion() { return true; }

    static buildMesh(shared, cfg, team) {
        const THREE = window.THREE;
        const group = new THREE.Group();
        const mat = shared.minionBody(cfg.id, team);
        const metal = shared.material('gunMetal', () => new THREE.MeshLambertMaterial({ color: 0x2b2f36 }));

        const body = new THREE.Mesh(shared.geo('box'), mat);
        body.scale.set(0.5, 0.82, 0.42);
        body.position.y = 0.48;
        body.castShadow = true;
        group.add(body);

        const head = new THREE.Mesh(shared.geo('sphereLow'), mat);
        head.scale.setScalar(0.2);
        head.position.y = 1.02;
        group.add(head);

        if (cfg.id === 'siege') {
            const wheel = new THREE.Mesh(shared.geo('cylinder'), metal);
            wheel.scale.set(0.34, 0.18, 0.34);
            wheel.rotation.z = Math.PI / 2;
            wheel.position.y = 0.3;
            group.add(wheel);
            const ram = new THREE.Mesh(shared.geo('box'), metal);
            ram.scale.set(0.16, 0.16, 1.1);
            ram.position.set(0, 0.62, 0.4);
            group.add(ram);
        } else {
            const weapon = new THREE.Mesh(shared.geo('box'), metal);
            weapon.scale.set(0.08, 0.08, cfg.ranged ? 0.66 : 0.5);
            weapon.position.set(0.3, 0.6, 0.18);
            group.add(weapon);
        }

        return group;
    }

    /* ------------------------------ 目标选择 ------------------------------ */

    _pickTarget() {
        const world = this.ctx ? this.ctx.world : null;
        if (!world) return null;

        // 优先攻击敌方单位（英雄/小兵/怪物），其次攻击建筑
        const unit = world.findNearestEnemyUnit(this, this.aggroRange, { includeStructures: false });
        if (unit) return unit;

        const structure = world.findNearestEnemyStructure(this, this.attackRange + 1.2);
        if (structure) return structure;

        return null;
    }

    _attack(target) {
        const now = performance.now();
        if (now - this.lastAttack < this.attackInterval * 1000) return;
        this.lastAttack = now;

        this.faceTowards(target.position.x, target.position.z, 1);

        const combat = this.ctx ? this.ctx.combat : null;
        if (!combat) return;

        let damage = this.damage;
        if (target.isStructure) damage *= this.structureMultiplier;

        if (this.ranged) {
            combat.spawnProjectile({
                source: this,
                target,
                x: this.position.x,
                y: this.groundY + 0.7,
                z: this.position.z,
                speed: 40,
                damage,
                color: this.team === 1 ? 0x9fc8ff : 0xffb0b0,
                homing: true
            });
        } else {
            combat.dealDamage(target, damage, this);
        }
    }

    /* ------------------------------ 推进 ------------------------------ */

    _advanceLane(dt) {
        if (!this.lanePoints) return;
        const speed = this.currentSpeed;
        if (speed <= 0) return;

        // 已经推到终点：直接冲向敌方基地
        if ((this.dir > 0 && this.laneT >= 1) || (this.dir < 0 && this.laneT <= 0)) {
            const world = this.ctx ? this.ctx.world : null;
            const base = world ? world.baseFor(this.team === 1 ? 2 : 1) : null;
            if (base) this.moveTowards(base.position.x, base.position.z, dt);
            return;
        }

        const step = (speed * dt) / Math.max(1, this.laneLength);
        this.laneT = clamp(this.laneT + this.dir * step, 0, 1);

        const t = this.laneT;
        polylinePoint(this.lanePoints, t, _pt);
        polylineTangent(this.lanePoints, t, _tan);

        // 横向偏移，让小兵排成队列而不是重叠成一点
        const nx = -_tan[1];
        const nz = _tan[0];
        const targetX = _pt[0] + nx * this.lateralOffset;
        const targetZ = _pt[1] + nz * this.lateralOffset;

        const dx = targetX - this.position.x;
        const dz = targetZ - this.position.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.001) {
            const move = Math.min(speed * dt, d);
            this.faceTowards(targetX, targetZ, dt);
            this.tryMove((dx / d) * move, (dz / d) * move);
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
            this.retargetTimer = 0.4;
            this.target = this._pickTarget();
        }

        if (this.target && this.target.alive) {
            const d = this.distanceToEntity(this.target);
            if (d <= this.attackRange + 0.3) {
                this._attack(this.target);
            } else {
                this.moveTowards(this.target.position.x, this.target.position.z, dt);
            }
        } else {
            this._advanceLane(dt);
        }

        this.updateGroundHeight();
    }
}