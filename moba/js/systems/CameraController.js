/**
 * CameraController —— 俯视 2.5D 相机
 *
 * 支持：
 *  - WASD / 中键拖拽平移，滚轮缩放，拖拽旋转俯角；
 *  - 跟随英雄（F 切换）或自由视角（空格键回到英雄）；
 *  - 「渲染距离」独立于「缩放」：缩放决定看得多近，渲染距离决定画多远，
 *    两者正交，玩家可以拉近视角但保持大范围视野（看清远处兵线）。
 *  - 屏幕震动（爆炸时）。
 *
 * 鼠标取地面点用「射线步进 + 二分细化」，而不是对每个分块做 Raycaster：
 * 后者在分块数量多时开销巨大，前者是 O(常数)。
 */

import { CAMERA, VIEW, TERRAIN } from '../config/GameConfig.js';
import { clamp, deg2rad, damp } from '../core/MathUtils.js';

const _rayTmp = { x: 0, y: 0, z: 0 };

export class CameraController {
    constructor(opts = {}) {
        const THREE = window.THREE;
        this.camera = opts.camera;
        this.terrain = opts.terrain || null;
        this.effects = opts.effects || null;

        this.target = new THREE.Vector3(0, 0, 0);
        this.followTarget = null;      // 被跟随的实体

        this.yaw = deg2rad(CAMERA.yaw);
        this.pitch = deg2rad(CAMERA.pitch);
        this.zoom = CAMERA.zoom;
        this.viewDistance = VIEW.default;

        this.follow = true;
        this.enabled = true;

        this._shakeOffset = new THREE.Vector3();
        this._desired = new THREE.Vector3();

        this.raycaster = new THREE.Raycaster();
        this._ndc = new THREE.Vector2();
        this._shakeTime = 0;

        this.camera.far = VIEW.default + 500;
        this.camera.updateProjectionMatrix();
    }

    /* ------------------------------ 参数 ------------------------------ */

    setZoom(delta) {
        this.zoom = clamp(this.zoom * (1 + delta), CAMERA.minZoom, CAMERA.maxZoom);
    }

    setViewDistance(value) {
        const v = clamp(Number(value) || VIEW.default, VIEW.min, VIEW.max);
        if (v === this.viewDistance) return false;
        this.viewDistance = v;
        this.camera.far = v + 500;
        this.camera.updateProjectionMatrix();
        return true;
    }

    rotate(dx, dy) {
        this.yaw -= dx * CAMERA.rotateSpeed * 0.01;
        this.pitch = clamp(this.pitch + dy * CAMERA.rotateSpeed * 0.01, deg2rad(CAMERA.minPitch), deg2rad(CAMERA.maxPitch));
    }

    /** 平移（世界坐标方向，随视角旋转保持一致的手感） */
    pan(forward, right, dt) {
        if (forward === 0 && right === 0) return;
        const speed = CAMERA.panSpeed * (0.45 + this.zoom / CAMERA.maxZoom) * dt;
        // 屏幕上的「上」对应相机朝向的地面投影
        const fx = -Math.sin(this.yaw);
        const fz = -Math.cos(this.yaw);
        const rx = Math.cos(this.yaw);
        const rz = -Math.sin(this.yaw);

        this.target.x += (fx * forward + rx * right) * speed;
        this.target.z += (fz * forward + rz * right) * speed;
        this.follow = false;
    }

    centerOn(entity) {
        if (!entity || !entity.position) return;
        this.followTarget = entity;
        this.follow = true;
    }

    /* ------------------------------ 每帧 ------------------------------ */

    update(dt, input) {
        if (!this.enabled) return;

        // 跟随目标
        if (this.follow && this.followTarget && this.followTarget.alive !== false) {
            const p = this.followTarget.position;
            const gy = this.terrain ? this.terrain.heightAt(p.x, p.z) : 0;
            this._desired.set(p.x, gy, p.z);
            this.target.x = damp(this.target.x, this._desired.x, 6, dt);
            this.target.z = damp(this.target.z, this._desired.z, 6, dt);
            this.target.y = damp(this.target.y, this._desired.y, 6, dt);
        } else if (this.follow && !this.followTarget) {
            // 没有跟随目标时平滑贴地
            const gy = this.terrain ? this.terrain.heightAt(this.target.x, this.target.z) : 0;
            this.target.y = damp(this.target.y, gy, 6, dt);
        }

        // 输入平移
        if (input) {
            const move = input.getCameraPan();
            if (move.x !== 0 || move.z !== 0) this.pan(move.z, move.x, dt);
        }

        // 相机位置
        const cosPitch = Math.cos(this.pitch);
        const offsetX = Math.sin(this.yaw) * cosPitch * this.zoom;
        const offsetY = Math.sin(this.pitch) * this.zoom;
        const offsetZ = Math.cos(this.yaw) * cosPitch * this.zoom;

        // 屏幕震动
        if (this.effects && this.effects.shakeAmount > 0) {
            const s = this.effects.shakeAmount;
            this._shakeTime += dt * 34;
            this._shakeOffset.set(
                Math.sin(this._shakeTime * 1.7) * s * 0.7,
                Math.sin(this._shakeTime * 2.3) * s * 0.5,
                Math.cos(this._shakeTime * 1.9) * s * 0.7
            );
        } else {
            this._shakeOffset.set(0, 0, 0);
        }

        this.camera.position.set(
            this.target.x + offsetX + this._shakeOffset.x,
            this.target.y + offsetY + this._shakeOffset.y,
            this.target.z + offsetZ + this._shakeOffset.z
        );
        this.camera.lookAt(this.target.x, this.target.y, this.target.z);
    }

    /**
     * 屏幕坐标 -> 地面交点（世界坐标）。
     * 采用「步进 + 二分」求交，复杂度与分块数量无关。
     * @param {number} ndcX -1..1
     * @param {number} ndcY -1..1
     * @returns {{x:number,y:number,z:number}|null}
     */
    groundPoint(ndcX, ndcY) {
        if (!this.terrain) return null;
        this._ndc.set(ndcX, ndcY);
        this.raycaster.setFromCamera(this._ndc, this.camera);
        const ray = this.raycaster.ray;

        const maxDist = Math.min(this.camera.far, 1600);
        let t = 0;
        let step = 1.2;
        let prevT = 0;

        let guard = 0;
        while (t < maxDist && guard++ < 4000) {
            _rayTmp.x = ray.origin.x + ray.direction.x * t;
            _rayTmp.y = ray.origin.y + ray.direction.y * t;
            _rayTmp.z = ray.origin.z + ray.direction.z * t;

            const h = this.terrain.heightAt(_rayTmp.x, _rayTmp.z);
            if (_rayTmp.y <= h) {
                // 二分细化，得到精确落点
                let lo = prevT;
                let hi = t;
                for (let i = 0; i < 16; i++) {
                    const mid = (lo + hi) * 0.5;
                    const mx = ray.origin.x + ray.direction.x * mid;
                    const my = ray.origin.y + ray.direction.y * mid;
                    const mz = ray.origin.z + ray.direction.z * mid;
                    if (my > this.terrain.heightAt(mx, mz)) lo = mid;
                    else hi = mid;
                }
                return {
                    x: ray.origin.x + ray.direction.x * hi,
                    y: ray.origin.y + ray.direction.y * hi,
                    z: ray.origin.z + ray.direction.z * hi
                };
            }

            prevT = t;
            t += step;
            if (t > 60) step = 3.5;
            if (t > 200) step = 9;
        }
        return null;
    }

    /** 屏幕坐标 -> 地面点，若射线朝天则回退到目标平面 */
    groundPointSafe(ndcX, ndcY) {
        const hit = this.groundPoint(ndcX, ndcY);
        if (hit) return hit;
        const y = this.terrain ? this.terrain.heightAt(this.target.x, this.target.z) : TERRAIN.waterLevel;
        return { x: this.target.x, y, z: this.target.z };
    }

    snapshot() {
        return {
            yaw: this.yaw,
            pitch: this.pitch,
            zoom: this.zoom,
            viewDistance: this.viewDistance,
            follow: this.follow,
            x: this.target.x,
            z: this.target.z
        };
    }
}