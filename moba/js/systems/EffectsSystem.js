/**
 * EffectsSystem —— 视觉特效（全部走对象池）
 *
 * 三类池化特效：
 *   rings   地面扩散圆环（范围技能、爆炸冲击波）
 *   sparks  飞散的粒子（命中、爆炸碎屑）
 *   beams   光束/斩击（直线技能）
 *
 * 每个池实例自带一份材质（在初始化时创建一次，之后反复复用）。
 * 因为池容量固定，材质数量也是固定的，不会随时间增长。
 * 这样做是为了解决「特效需要逐实例改透明度 → 无法共享材质 → 频繁 new 材质泄漏」的矛盾。
 */

import { ObjectPool } from '../core/ObjectPool.js';

const RING_POOL_SIZE = 40;
const SPARK_POOL_SIZE = 140;
const BEAM_POOL_SIZE = 16;

class RingEffect {
    constructor(geo) {
        const THREE = window.THREE;
        this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            transparent: true, depthWrite: false, side: THREE.DoubleSide
        }));
        this.mesh.rotation.x = -Math.PI / 2;
        this.mesh.visible = false;
        this.life = 0;
        this.maxLife = 1;
        this.fromScale = 1;
        this.toScale = 2;
    }

    init({ x, y, z, radius, color, duration, thickness }) {
        this.mesh.position.set(x, y, z);
        this.mesh.material.color.setHex(color);
        this.fromScale = radius * (thickness || 0.25);
        this.toScale = radius;
        this.mesh.scale.setScalar(this.fromScale);
        this.life = duration;
        this.maxLife = duration;
        this.mesh.material.opacity = 0.85;
        this.mesh.visible = true;
        return this;
    }

    update(dt) {
        this.life -= dt;
        if (this.life <= 0) return false;
        const t = 1 - this.life / this.maxLife;
        const s = this.fromScale + (this.toScale - this.fromScale) * t;
        this.mesh.scale.setScalar(s);
        this.mesh.material.opacity = 0.85 * (1 - t);
        return true;
    }

    reset() {
        this.mesh.visible = false;
        this.life = 0;
    }
}

class SparkEffect {
    constructor(geo) {
        const THREE = window.THREE;
        this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            transparent: true, depthWrite: false
        }));
        this.mesh.visible = false;
        this.velocity = new THREE.Vector3();
        this.life = 0;
        this.maxLife = 1;
        this.gravity = 22;
    }

    init({ x, y, z, vx, vy, vz, color, size, duration }) {
        this.mesh.position.set(x, y, z);
        this.mesh.material.color.setHex(color);
        this.mesh.scale.setScalar(size);
        this.velocity.set(vx, vy, vz);
        this.life = duration;
        this.maxLife = duration;
        this.mesh.material.opacity = 1;
        this.mesh.visible = true;
        return this;
    }

    update(dt) {
        this.life -= dt;
        if (this.life <= 0) return false;
        this.velocity.y -= this.gravity * dt;
        this.mesh.position.addScaledVector(this.velocity, dt);
        this.mesh.material.opacity = Math.max(0, this.life / this.maxLife);
        return true;
    }

    reset() {
        this.mesh.visible = false;
        this.life = 0;
    }
}

class BeamEffect {
    constructor(geo) {
        const THREE = window.THREE;
        this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            transparent: true, depthWrite: false
        }));
        this.mesh.visible = false;
        this.life = 0;
        this.maxLife = 1;
    }

    init({ x0, y0, z0, x1, y1, z1, color, width, duration }) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const dz = z1 - z0;
        const len = Math.hypot(dx, dy, dz) || 0.001;

        this.mesh.position.set((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
        this.mesh.scale.set(width, width, len);
        // 让单位立方体的 +Z 轴对准终点
        this.mesh.lookAt(x1, y1, z1);
        this.mesh.material.color.setHex(color);
        this.mesh.material.opacity = 0.9;

        this.life = duration;
        this.maxLife = duration;
        this.mesh.visible = true;
        return this;
    }

    update(dt) {
        this.life -= dt;
        if (this.life <= 0) return false;
        this.mesh.material.opacity = 0.9 * (this.life / this.maxLife);
        return true;
    }

    reset() {
        this.mesh.visible = false;
        this.life = 0;
    }
}

export class EffectsSystem {
    constructor(ctx = {}) {
        this.scene = ctx.scene || null;
        this.shared = ctx.shared || null;
        this.enabled = true;

        this.shakeAmount = 0;
        this.shakeDecay = 3.2;

        this._ringUpdate = [];
        this._sparkUpdate = [];
        this._beamUpdate = [];

        if (!this.scene || !this.shared) {
            this.ringPool = null;
            this.sparkPool = null;
            this.beamPool = null;
            return;
        }

        this.ringPool = new ObjectPool({
            create: () => {
                const e = new RingEffect(this.shared.geo('ring'));
                this.scene.add(e.mesh);
                return e;
            },
            reset: (e) => e.reset(),
            initial: RING_POOL_SIZE,
            max: RING_POOL_SIZE
        });

        this.sparkPool = new ObjectPool({
            create: () => {
                const e = new SparkEffect(this.shared.geo('sphereLow'));
                this.scene.add(e.mesh);
                return e;
            },
            reset: (e) => e.reset(),
            initial: SPARK_POOL_SIZE,
            max: SPARK_POOL_SIZE
        });

        this.beamPool = new ObjectPool({
            create: () => {
                const e = new BeamEffect(this.shared.geo('box'));
                this.scene.add(e.mesh);
                return e;
            },
            reset: (e) => e.reset(),
            initial: BEAM_POOL_SIZE,
            max: BEAM_POOL_SIZE
        });
    }

    get ready() {
        return !!this.ringPool;
    }

    /* ------------------------------ 对外接口 ------------------------------ */

    ring(x, y, z, radius, color = 0x9fd8ff, duration = 0.45) {
        if (!this.ready || !this.enabled) return;
        const e = this.ringPool.acquire();
        e.init({ x, y, z, radius, color, duration, thickness: 0.22 });
        this._ringUpdate.push(e);
    }

    explosion(x, y, z, radius, color = 0xffa54d) {
        if (!this.ready || !this.enabled) return;
        this.ring(x, y + 0.1, z, radius, color, 0.42);

        const count = Math.min(10, 4 + Math.floor(radius));
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2 + Math.random() * 0.6;
            const speed = 4 + Math.random() * 7;
            this._spark(
                x, y + 0.3, z,
                Math.cos(angle) * speed,
                3 + Math.random() * 5,
                Math.sin(angle) * speed,
                color,
                0.12 + Math.random() * 0.12,
                0.5 + Math.random() * 0.3
            );
        }
    }

    impact(x, y, z, color = 0xffffff) {
        if (!this.ready || !this.enabled) return;
        this.ring(x, Math.max(0.15, y - 0.8), z, 1.1, color, 0.22);

        for (let i = 0; i < 4; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 3.5;
            this._spark(
                x, y, z,
                Math.cos(angle) * speed,
                1.5 + Math.random() * 3,
                Math.sin(angle) * speed,
                color,
                0.08 + Math.random() * 0.07,
                0.28 + Math.random() * 0.18
            );
        }
    }

    /** 近战斩击：一段短暂的弧光 */
    slash(x, y, z, facing, color = 0xfff0c0) {
        if (!this.ready || !this.enabled) return;
        const e = this.beamPool.acquire();
        const fx = Math.sin(facing);
        const fz = Math.cos(facing);
        e.init({
            x0: x - fx * 0.9, y0: y, z0: z - fz * 0.9,
            x1: x + fx * 1.8, y1: y + 0.25, z1: z + fz * 1.8,
            color, width: 0.16, duration: 0.16
        });
        this._beamUpdate.push(e);
    }

    beam(x0, y0, z0, x1, y1, z1, color = 0xffffff) {
        if (!this.ready || !this.enabled) return;
        const e = this.beamPool.acquire();
        e.init({ x0, y0, z0, x1, y1, z1, color, width: 0.42, duration: 0.26 });
        this._beamUpdate.push(e);
    }

    /** 屏幕震动（由 CameraController 消费） */
    shake(amount) {
        const a = Number(amount);
        if (!Number.isFinite(a) || a <= 0) return;
        this.shakeAmount = Math.min(1.6, this.shakeAmount + a);
    }

    _spark(x, y, z, vx, vy, vz, color, size, duration) {
        const e = this.sparkPool.acquire();
        e.init({ x, y, z, vx, vy, vz, color, size, duration });
        this._sparkUpdate.push(e);
    }

    /* ------------------------------ 每帧 ------------------------------ */

    update(dt) {
        if (!this.ready) return;
        this._updatePool(this._ringUpdate, dt);
        this._updatePool(this._sparkUpdate, dt);
        this._updatePool(this._beamUpdate, dt);

        if (this.shakeAmount > 0) {
            this.shakeAmount -= this.shakeDecay * dt;
            if (this.shakeAmount < 0) this.shakeAmount = 0;
        }
    }

    _updatePool(list, dt) {
        for (let i = list.length - 1; i >= 0; i--) {
            const e = list[i];
            let alive = false;
            try {
                alive = e.update(dt);
            } catch (err) {
                console.error('[EffectsSystem] 特效更新异常，已回收', err);
                alive = false;
            }
            if (!alive) {
                const pool = this._poolFor(e);
                if (pool) pool.release(e);
                list.splice(i, 1);
            }
        }
    }

    _poolFor(effect) {
        if (effect instanceof RingEffect) return this.ringPool;
        if (effect instanceof SparkEffect) return this.sparkPool;
        if (effect instanceof BeamEffect) return this.beamPool;
        return null;
    }

    reset() {
        if (!this.ready) return;
        for (const e of this._ringUpdate.slice()) this.ringPool.release(e);
        for (const e of this._sparkUpdate.slice()) this.sparkPool.release(e);
        for (const e of this._beamUpdate.slice()) this.beamPool.release(e);
        this._ringUpdate.length = 0;
        this._sparkUpdate.length = 0;
        this._beamUpdate.length = 0;
        this.shakeAmount = 0;
    }

    stats() {
        return {
            rings: this.ringPool ? this.ringPool.activeCount : 0,
            sparks: this.sparkPool ? this.sparkPool.activeCount : 0,
            beams: this.beamPool ? this.beamPool.activeCount : 0,
            shake: this.shakeAmount
        };
    }
}