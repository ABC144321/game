/**
 * Chunk —— 单个地图分块
 *
 * 一个分块包含两个网格：
 *  1. ground：地面网格。顶点高度来自 Terrain（世界坐标烘焙进几何体），
 *     顶点色按瓦片类型着色；水面被钳制到同一高度形成平整湖面。
 *  2. props：植被/岩石。构建时把上百个物体「合并」为一个几何体，
 *     使整块地图的植被只占 1 次 DrawCall。
 *
 * 视锥体剔除：分块自带 world 空间包围盒，被 RenderSystem 直接用于 Frustum 测试。
 * LOD：远景隐藏 props（它占了分块 90% 以上的顶点数）。
 */

import { TILE_SIZE, CHUNK_TILES, CHUNK_SIZE, TERRAIN } from '../config/GameConfig.js';
import { paintGeometry, mergeGeometries, disposeObject3D } from '../core/GeometryUtils.js';
import { hash2i } from '../core/MathUtils.js';
import { PROP_TREE, PROP_ROCK } from './Terrain.js';

/** 分块 LOD 等级 */
export const CHUNK_LOD_FULL = 0;   // 地面 + 植被
export const CHUNK_LOD_SIMPLE = 1; // 仅地面

/* --------------------------- 植被原型几何体（全局共享） --------------------------- */

let _prototypes = null;

function getPrototypes() {
    if (_prototypes) return _prototypes;
    const THREE = window.THREE;
    if (!THREE) return null;

    const trunks = [];
    const canopies = [];
    // 3 种树冠色，制造自然变化
    const canopyColors = [0x3f6b34, 0x4a7a3a, 0x365c2e];
    for (let i = 0; i < canopyColors.length; i++) {
        const trunk = new THREE.CylinderGeometry(0.14, 0.2, 1.5, 5, 1);
        trunk.translate(0, 0.75, 0);
        paintGeometry(trunk, 0x5a4432);
        trunks.push(trunk);

        const canopy = new THREE.ConeGeometry(1.15, 2.6, 7, 1);
        canopy.translate(0, 2.45, 0);
        paintGeometry(canopy, canopyColors[i]);
        canopies.push(canopy);
    }

    const rocks = [];
    const rockColors = [0x707078, 0x5d5d64];
    for (let i = 0; i < rockColors.length; i++) {
        const rock = new THREE.IcosahedronGeometry(0.72, 0);
        rock.scale(1.0, 0.72, 1.0);
        rock.translate(0, 0.42, 0);
        paintGeometry(rock, rockColors[i]);
        rocks.push(rock);
    }

    _prototypes = { trunks, canopies, rocks };
    return _prototypes;
}

/** 释放全局原型（页面卸载时调用） */
export function disposePrototypes() {
    if (!_prototypes) return;
    const all = [..._prototypes.trunks, ..._prototypes.canopies, ..._prototypes.rocks];
    for (const g of all) {
        if (g && typeof g.dispose === 'function') g.dispose();
    }
    _prototypes = null;
}

export class Chunk {
    /**
     * @param {number} cx 分块 X 索引
     * @param {number} cz 分块 Z 索引
     * @param {Terrain} terrain
     * @param {object} opts { propKeepRatio, maxProps }
     */
    constructor(cx, cz, terrain, opts = {}) {
        this.cx = cx | 0;
        this.cz = cz | 0;
        this.terrain = terrain;
        this.originX = cx * CHUNK_SIZE;
        this.originZ = cz * CHUNK_SIZE;

        this.propKeepRatio = typeof opts.propKeepRatio === 'number' ? opts.propKeepRatio : 1;
        this.maxProps = typeof opts.maxProps === 'number' ? opts.maxProps : 120;

        this.group = null;
        this.groundMesh = null;
        this.propsMesh = null;
        this.boundingBox = null;
        this.built = false;
        this.lod = CHUNK_LOD_FULL;
        this.visible = true;
        this.buildMs = 0;
        this.disposed = false;
    }

    /** 世界坐标 -> 归属分块索引 */
    static indexFor(worldX, worldZ) {
        return {
            cx: Math.floor(worldX / CHUNK_SIZE),
            cz: Math.floor(worldZ / CHUNK_SIZE)
        };
    }

    /** 分块中心（用于距离计算） */
    get centerX() { return this.originX + CHUNK_SIZE * 0.5; }
    get centerZ() { return this.originZ + CHUNK_SIZE * 0.5; }

    distanceTo(x, z) {
        const dx = Math.max(0, Math.abs(x - this.centerX) - CHUNK_SIZE * 0.5);
        const dz = Math.max(0, Math.abs(z - this.centerZ) - CHUNK_SIZE * 0.5);
        return Math.sqrt(dx * dx + dz * dz);
    }

    /* ------------------------------ 构建 ------------------------------ */

    build(scene) {
        if (this.built || this.disposed) return false;
        const THREE = window.THREE;
        if (!THREE) return false;

        const t0 = performance.now();

        this.group = new THREE.Group();
        this.group.name = `chunk_${this.cx}_${this.cz}`;

        this._buildGround(THREE);
        this._buildProps(THREE);

        if (this.groundMesh) this.group.add(this.groundMesh);
        if (this.propsMesh) this.group.add(this.propsMesh);

        if (scene) scene.add(this.group);
        this.built = true;
        this.buildMs = performance.now() - t0;
        return true;
    }

    _buildGround(THREE) {
        const n = CHUNK_TILES;
        const vertsPerSide = n + 1;
        const vertexCount = vertsPerSide * vertsPerSide;

        const positions = new Float32Array(vertexCount * 3);
        const colors = new Float32Array(vertexCount * 3);
        const indices = new Uint16Array(n * n * 6);

        const terrain = this.terrain;
        const waterLevel = TERRAIN.waterLevel;
        let minY = Infinity;
        let maxY = -Infinity;

        // 顶点
        for (let iz = 0; iz < vertsPerSide; iz++) {
            for (let ix = 0; ix < vertsPerSide; ix++) {
                const vi = iz * vertsPerSide + ix;
                const wx = this.originX + ix * TILE_SIZE;
                const wz = this.originZ + iz * TILE_SIZE;
                let h = terrain.heightAt(wx, wz);
                if (h < waterLevel) h = waterLevel; // 湖面抹平

                positions[vi * 3] = wx;
                positions[vi * 3 + 1] = h;
                positions[vi * 3 + 2] = wz;

                if (h < minY) minY = h;
                if (h > maxY) maxY = h;

                // 顶点色取自所在瓦片（复用缓存，不额外计算高度）
                const tx = Math.floor(wx / TILE_SIZE);
                const tz = Math.floor(wz / TILE_SIZE);
                const info = terrain.tileInfo(tx, tz);
                const c = info ? info.color : [0.35, 0.5, 0.3];
                colors[vi * 3] = c[0];
                colors[vi * 3 + 1] = c[1];
                colors[vi * 3 + 2] = c[2];
            }
        }

        // 索引（两个三角形构成一个瓦片方格）
        let ptr = 0;
        for (let iz = 0; iz < n; iz++) {
            for (let ix = 0; ix < n; ix++) {
                const a = iz * vertsPerSide + ix;
                const b = a + 1;
                const c = a + vertsPerSide;
                const d = c + 1;
                indices[ptr++] = a; indices[ptr++] = c; indices[ptr++] = b;
                indices[ptr++] = b; indices[ptr++] = c; indices[ptr++] = d;
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geo.setIndex(new THREE.BufferAttribute(indices, 1));
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        geo.computeBoundingSphere();

        const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = 'ground';
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();

        this.groundMesh = mesh;
        this._minY = minY;
        this._maxY = maxY;
    }

    _buildProps(THREE) {
        const protos = getPrototypes();
        if (!protos) return;

        const n = CHUNK_TILES;
        const keepRatio = this.propKeepRatio;
        const limit = this.maxProps;
        const parts = [];
        let count = 0;

        for (let iz = 0; iz < n && count < limit; iz++) {
            for (let ix = 0; ix < n && count < limit; ix++) {
                const tx = Math.floor((this.originX + ix * TILE_SIZE) / TILE_SIZE);
                const tz = Math.floor((this.originZ + iz * TILE_SIZE) / TILE_SIZE);
                const info = this.terrain.tileInfo(tx, tz);
                if (!info || info.prop === 0) continue;

                // 画质档位抽稀（确定性，保证同一瓦片结果一致）
                if (keepRatio < 1 && hash2i(tx, tz, 4242) > keepRatio) continue;

                const wx = tx * TILE_SIZE + TILE_SIZE * 0.5;
                const wz = tz * TILE_SIZE + TILE_SIZE * 0.5;
                const h = this.terrain.heightAt(wx, wz);

                if (info.prop === PROP_TREE) {
                    const variant = Math.floor(hash2i(tx, tz, 77) * protos.trunks.length) % protos.trunks.length;
                    const scale = 0.8 + hash2i(tx, tz, 91) * 0.6;

                    const trunk = protos.trunks[variant].clone();
                    trunk.scale(scale, scale, scale);
                    trunk.translate(wx, h, wz);
                    parts.push(trunk);

                    const canopy = protos.canopies[variant].clone();
                    canopy.scale(scale, scale * (0.9 + hash2i(tx, tz, 13) * 0.35), scale);
                    canopy.translate(wx, h, wz);
                    parts.push(canopy);
                    count++;
                } else if (info.prop === PROP_ROCK) {
                    const variant = Math.floor(hash2i(tx, tz, 55) * protos.rocks.length) % protos.rocks.length;
                    const scale = 0.7 + hash2i(tx, tz, 66) * 0.8;
                    const rock = protos.rocks[variant].clone();
                    rock.rotateY(hash2i(tx, tz, 31) * Math.PI * 2);
                    rock.scale(scale, scale * 0.8, scale);
                    rock.translate(wx, h, wz);
                    parts.push(rock);
                    count++;
                }
            }
        }

        if (parts.length === 0) return;

        const merged = mergeGeometries(parts, true);
        if (!merged) return;

        const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
        const mesh = new THREE.Mesh(merged, mat);
        mesh.name = 'props';
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();

        this.propsMesh = mesh;
        this._maxY = Math.max(this._maxY, 4.2);
    }

    /* ------------------------------ 运行时控制 ------------------------------ */

    /** 构建完成后调用，生成包围盒 */
    finalizeBounds() {
        const THREE = window.THREE;
        if (!THREE || !this.built) return;
        if (this.boundingBox) return;
        const minY = Number.isFinite(this._minY) ? this._minY : -1;
        const maxY = Number.isFinite(this._maxY) ? this._maxY : 6;
        this.boundingBox = new THREE.Box3(
            new THREE.Vector3(this.originX, minY - 0.5, this.originZ),
            new THREE.Vector3(this.originX + CHUNK_SIZE, maxY + 0.5, this.originZ + CHUNK_SIZE)
        );
    }

    setLOD(level) {
        if (this.lod === level) return;
        this.lod = level;
        if (this.propsMesh) this.propsMesh.visible = (level === CHUNK_LOD_FULL) && this.visible;
    }

    setVisible(v) {
        this.visible = !!v;
        if (this.group) this.group.visible = this.visible;
    }

    /** 释放几何体与材质；之后对象不可再用 */
    dispose(scene) {
        if (this.disposed) return;
        this.disposed = true;

        if (scene && this.group && this.group.parent === scene) {
            scene.remove(this.group);
        }
        disposeObject3D(this.group);
        if (this.group) {
            this.group.clear();
        }
        this.group = null;
        this.groundMesh = null;
        this.propsMesh = null;
        this.boundingBox = null;
        this.built = false;
    }
}