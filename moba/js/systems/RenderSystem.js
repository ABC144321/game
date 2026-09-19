/**
 * RenderSystem —— 渲染优化：视锥体剔除 + LOD + 光照跟随
 *
 * 两级可见性裁剪：
 *   1. 距离裁剪：超出「渲染距离」的分块直接不渲染（这是玩家可调的核心参数）；
 *   2. 视锥体裁剪：用 THREE.Frustum 对分块的 world 包围盒做相交测试，
 *      屏幕外的分块即使很近也不渲染。
 *
 * 两级 LOD：
 *   - 分块级：远处隐藏植被网格（植被占分块 90% 以上顶点）；
 *   - 单位级：远处隐藏细节挂件（阵营光环）与血条，只保留主体轮廓。
 *
 * 关键优化：LOD 只在「等级发生变化」时才写场景图，
 * 避免每帧对数百个单位做无意义的 visible 赋值（会触发矩阵/排序计算）。
 */

import { VIEW, QUALITY_PRESETS, CAMERA } from '../config/GameConfig.js';

export const LOD_FULL = 0;
export const LOD_MEDIUM = 1;
export const LOD_SIMPLE = 2;

export class RenderSystem {
    constructor(ctx = {}) {
        const THREE = window.THREE;

        this.scene = ctx.scene;
        this.camera = ctx.camera;
        this.chunkManager = ctx.chunkManager;
        this.world = ctx.world;
        this.cameraController = ctx.cameraController;
        this.sun = ctx.sun || null;
        this.fog = ctx.fog || null;

        this.viewDistance = VIEW.default;
        this.quality = 'medium';
        this.shadowsEnabled = true;

        this._frustum = new THREE.Frustum();
        this._projMatrix = new THREE.Matrix4();
        this._matrixWorld = new THREE.Matrix4();
        this._box = new THREE.Box3();

        this.stats = {
            chunksVisible: 0,
            chunksCulled: 0,
            chunksFrustum: 0,
            entitiesVisible: 0,
            entitiesCulled: 0,
            lodChanged: 0
        };
    }

    setQuality(name) {
        const preset = QUALITY_PRESETS[name];
        if (!preset) return false;
        this.quality = name;

        if (this.chunkManager) {
            this.chunkManager.setBuildOptions({
                propKeepRatio: preset.propDetail === 0 ? 0.45 : (preset.propDetail === 1 ? 0.8 : 1),
                maxProps: preset.maxPropsPerChunk
            });
        }

        const renderer = this.renderer;
        if (renderer) {
            renderer.shadowMap.enabled = preset.shadows;
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatio));
            this.shadowsEnabled = preset.shadows;
            // 切换阴影开关后需要重新编译材质
            this.scene.traverse((o) => {
                if (o.isMesh && o.material) {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    for (const m of mats) if (m) m.needsUpdate = true;
                }
            });
        }
        return true;
    }

    setRenderer(renderer) {
        this.renderer = renderer;
    }

    setViewDistance(value) {
        this.viewDistance = Math.max(1, value);
    }

    update() {
        if (!this.camera || !this.scene) return;

        const camPos = this.camera.position;
        const vd = this.viewDistance;

        // 视锥体
        this._projMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        this._frustum.setFromProjectionMatrix(this._projMatrix);

        const lod1 = vd * VIEW.lod1Ratio;
        const lod2 = vd * VIEW.lod2Ratio;

        this._updateChunks(camPos, vd, lod1);
        this._updateEntities(camPos, vd, lod1, lod2);
        this._updateLight();
    }

    /* ------------------------------ 分块 ------------------------------ */

    _updateChunks(camPos, vd, lod1) {
        const stats = this.stats;
        stats.chunksVisible = 0;
        stats.chunksCulled = 0;
        stats.chunksFrustum = 0;

        const chunks = this.chunkManager ? this.chunkManager.chunks : null;
        if (!chunks) return;

        const reach = vd + 48;

        for (const chunk of chunks.values()) {
            if (!chunk || !chunk.built) continue;

            const dist = chunk.distanceTo(camPos.x, camPos.z);

            // 1) 距离裁剪
            if (dist > reach) {
                chunk.setVisible(false);
                stats.chunksCulled++;
                continue;
            }

            // 2) 视锥体裁剪
            if (chunk.boundingBox && !this._frustum.intersectsBox(chunk.boundingBox)) {
                chunk.setVisible(false);
                stats.chunksFrustum++;
                continue;
            }

            chunk.setVisible(true);
            stats.chunksVisible++;

            // 3) 分块 LOD：远处不渲染植被
            const nextLod = dist > lod1 ? 1 : 0;
            if (chunk.lod !== nextLod) chunk.setLOD(nextLod);
        }
    }

    /* ------------------------------ 单位 ------------------------------ */

    _updateEntities(camPos, vd, lod1, lod2) {
        const stats = this.stats;
        stats.entitiesVisible = 0;
        stats.entitiesCulled = 0;
        stats.lodChanged = 0;

        const all = this.world ? this.world.all : null;
        if (!all) return;

        for (let i = 0; i < all.length; i++) {
            const e = all[i];
            if (!e || !e.mesh) continue;

            const dx = e.position.x - camPos.x;
            const dz = e.position.z - camPos.z;
            const dist = Math.hypot(dx, dz);

            if (dist > vd + 24) {
                if (e.mesh.visible) {
                    e.mesh.visible = false;
                    stats.entitiesCulled++;
                }
                continue;
            }

            // 死亡单位（等待复活的英雄）保持隐藏，避免被下面的 visible=true 重新显示
            if (e.isHero && !e.alive) {
                if (e.mesh.visible) e.mesh.visible = false;
                if (e.healthBar) e.healthBar.visible = false;
                continue;
            }

            if (!e.mesh.visible) e.mesh.visible = true;
            stats.entitiesVisible++;

            const nextLod = dist > lod2 ? LOD_SIMPLE : (dist > lod1 ? LOD_MEDIUM : LOD_FULL);
            if (e._lodLevel !== nextLod) {
                e._lodLevel = nextLod;
                this._applyEntityLOD(e, nextLod);
                stats.lodChanged++;
            }
        }
    }

    _applyEntityLOD(entity, lod) {
        const mesh = entity.mesh;
        if (!mesh) return;

        // 血条：近处才显示，避免远处密密麻麻
        entity.setHealthBarVisible(lod !== LOD_SIMPLE);

        // 细节挂件（阵营光环等）在中远距离隐藏
        const children = mesh.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (!child || !child.userData || !child.userData.isDetail) continue;
            child.visible = lod === LOD_FULL;
        }
    }

    /* ------------------------------ 光照 ------------------------------ */

    _updateLight() {
        if (!this.sun || !this.cameraController) return;

        const t = this.cameraController.target;
        const vd = this.viewDistance;

        // 平行光跟随相机目标，保证阴影贴图始终覆盖可视区域
        this.sun.position.set(t.x + 60, 110, t.z + 42);
        if (this.sun.target) {
            this.sun.target.position.set(t.x, 0, t.z);
            this.sun.target.updateMatrixWorld();
        }

        const cam = this.sun.shadow ? this.sun.shadow.camera : null;
        if (cam) {
            const half = Math.min(120, Math.max(45, vd * 0.35));
            cam.left = -half;
            cam.right = half;
            cam.top = half;
            cam.bottom = -half;
            cam.far = 400;
            cam.updateProjectionMatrix();
        }
    }

    /* ------------------------------ 雾效（随渲染距离变化） ------------------------------ */

    applyFog(skyColor) {
        if (!this.fog) return;
        this.fog.color.setHex(skyColor);
        this.fog.near = this.viewDistance * VIEW.fogNearRatio;
        this.fog.far = this.viewDistance * VIEW.fogFarRatio;
    }

    applyCameraFar() {
        if (!this.camera) return;
        this.camera.far = Math.max(this.viewDistance + 500, CAMERA.far);
        this.camera.updateProjectionMatrix();
    }
}