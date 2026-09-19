/**
 * Projectile —— 投射物（对象池复用）
 *
 * 命中判定使用「线段-球体最近距离」，而不是「当前位置是否落在球体内」。
 * 原因：高速弹道单帧位移可达 1.7 米，远超小兵 0.5 米的半径，
 * 逐帧点检测会直接穿过目标（穿透 Bug）。线段检测从数学上消除了这个问题，
 * 且比子步进循环更省算力。
 */

import { TEAM } from '../config/GameConfig.js';

export class Projectile {
    constructor(shared) {
        this.shared = shared;
        this.active = false;

        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.prevPosition = new THREE.Vector3();

        this.mesh = new THREE.Mesh(shared.geo('sphere'), shared.glow(0xffffff));
        this.mesh.scale.setScalar(0.14);
        this.mesh.visible = false;

        this.life = 0;
        this.damage = 0;
        this.source = null;
        this.target = null;
        this.homing = false;
        this.speed = 40;
        this.splash = 0;
        this.slow = 0;
        this.slowDuration = 0;
        this.team = TEAM.NEUTRAL;
        this.hitRadiusBonus = 0.35;
    }

    /**
     * @param {object} opts
     * @param {import('./Entity.js').Entity} opts.source 来源（用于结算与归属）
     * @param {import('./Entity.js').Entity|null} opts.target 追踪目标
     */
    init(opts) {
        this.active = true;
        this.source = opts.source || null;
        this.target = opts.target || null;
        this.team = opts.source ? opts.source.team : TEAM.NEUTRAL;

        this.position.set(opts.x, opts.y, opts.z);
        this.prevPosition.copy(this.position);

        this.speed = opts.speed || 40;
        this.damage = opts.damage || 1;
        this.homing = !!opts.homing;
        this.splash = opts.splash || 0;
        this.slow = opts.slow || 0;
        this.slowDuration = opts.slowDuration || 0;
        this.life = opts.life || 2.5;

        // 追踪弹：初始速度直接指向目标
        if (this.homing && this.target) {
            const tx = this.target.position.x - this.position.x;
            const ty = (this.target.groundY + 0.8) - this.position.y;
            const tz = this.target.position.z - this.position.z;
            const len = Math.hypot(tx, ty, tz) || 1;
            this.velocity.set(tx / len, ty / len, tz / len).multiplyScalar(this.speed);
        } else if (opts.dirX !== undefined) {
            const len = Math.hypot(opts.dirX, opts.dirY || 0, opts.dirZ) || 1;
            this.velocity.set(
                (opts.dirX / len) * this.speed,
                ((opts.dirY || 0) / len) * this.speed,
                (opts.dirZ / len) * this.speed
            );
        } else {
            this.velocity.set(0, 0, 0);
        }

        this.mesh.material = this.shared.glow(opts.color === undefined ? 0xffffff : opts.color);
        const scale = opts.scale || 0.14;
        this.mesh.scale.setScalar(scale);
        this.mesh.position.copy(this.position);
        this.mesh.visible = true;
        return this;
    }

    /**
     * @returns {boolean} 是否仍然存活（false 表示可以回收）
     */
    update(dt, combat) {
        if (!this.active) return false;

        this.life -= dt;
        if (this.life <= 0) return false;

        // 追踪目标失效时转为直线飞行，避免原地打转
        if (this.homing && (!this.target || !this.target.alive)) {
            this.homing = false;
            this.target = null;
        }

        if (this.homing && this.target) {
            this._steerTowardsTarget(dt);
        }

        this.prevPosition.copy(this.position);
        this.position.addScaledVector(this.velocity, dt);
        this.mesh.position.copy(this.position);

        // 线段命中判定
        if (combat) {
            const hit = combat.resolveProjectileHit(this);
            if (hit) return false;
        }

        // 超出世界高度范围视为丢失
        if (this.position.y < -30) return false;

        return true;
    }

    _steerTowardsTarget(dt) {
        const t = this.target;
        const tx = t.position.x - this.position.x;
        const ty = (t.groundY + 0.8) - this.position.y;
        const tz = t.position.z - this.position.z;
        const len = Math.hypot(tx, ty, tz);
        if (len < 0.001) return;

        const desiredX = (tx / len) * this.speed;
        const desiredY = (ty / len) * this.speed;
        const desiredZ = (tz / len) * this.speed;

        // 限制转向速度，让弹道有弧线感而不是瞬间拐弯
        const turn = Math.min(1, dt * 14);
        this.velocity.x += (desiredX - this.velocity.x) * turn;
        this.velocity.y += (desiredY - this.velocity.y) * turn;
        this.velocity.z += (desiredZ - this.velocity.z) * turn;

        // 归一到设定速度，避免多次插值后速度衰减
        const cur = Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z);
        if (cur > 0.0001) {
            const scale = this.speed / cur;
            this.velocity.multiplyScalar(scale);
        }
    }

    reset() {
        this.active = false;
        this.mesh.visible = false;
        this.target = null;
        this.source = null;
        this.splash = 0;
        this.slow = 0;
        this.slowDuration = 0;
    }

    dispose() {
        if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
        this.mesh = null;
    }
}

/**
 * 点到线段的最近距离平方。用于弹道命中判定。
 * 与逐帧点检测相比，它天然免疫「高速穿透」。
 */
export function segmentPointDistSq(ax, ay, az, bx, by, bz, px, py, pz) {
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;

    const abLenSq = abx * abx + aby * aby + abz * abz;
    let t = 0;
    if (abLenSq > 1e-8) {
        t = (apx * abx + apy * aby + apz * abz) / abLenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
    }
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    const cz = az + abz * t;

    const dx = px - cx;
    const dy = py - cy;
    const dz = pz - cz;
    return dx * dx + dy * dy + dz * dz;
}