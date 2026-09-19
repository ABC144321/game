/**
 * GeometryUtils —— 轻量几何合并工具
 *
 * three.js 核心包不含 BufferGeometryUtils（那是 addon），
 * 这里手写一个最小实现，用于把分块内的植被/岩石烘焙成单个网格，
 * 把「每棵树一次 DrawCall」降为「每分块一次 DrawCall」。
 */

/**
 * 把多个 BufferGeometry 合并成一个非索引几何体。
 * 只处理 position / normal / color 三个属性（足够本项目使用）。
 * @param {THREE.BufferGeometry[]} geometries
 * @param {boolean} disposeSources 合并后是否释放源几何体
 * @returns {THREE.BufferGeometry|null}
 */
export function mergeGeometries(geometries, disposeSources = true) {
    if (!Array.isArray(geometries) || geometries.length === 0) return null;

    const THREE = window.THREE;
    if (!THREE) {
        console.error('[GeometryUtils] THREE 未加载');
        return null;
    }

    const sources = [];
    let totalVerts = 0;

    for (const geo of geometries) {
        if (!geo || !geo.attributes || !geo.attributes.position) continue;
        // 统一转为非索引，避免索引偏移换算
        const g = geo.index ? geo.toNonIndexed() : geo;
        sources.push({ g, temporary: g !== geo });
        totalVerts += g.attributes.position.count;
    }

    if (totalVerts === 0) return null;

    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const colors = new Float32Array(totalVerts * 3);
    colors.fill(1);

    let offset = 0;
    for (const { g } of sources) {
        const count = g.attributes.position.count;
        const p = g.attributes.position.array;
        positions.set(p.subarray(0, count * 3), offset * 3);

        const nAttr = g.attributes.normal;
        if (nAttr && nAttr.array.length >= count * 3) {
            normals.set(nAttr.array.subarray(0, count * 3), offset * 3);
        }

        const cAttr = g.attributes.color;
        if (cAttr && cAttr.array.length >= count * 3) {
            colors.set(cAttr.array.subarray(0, count * 3), offset * 3);
        }

        offset += count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    merged.computeBoundingBox();
    merged.computeBoundingSphere();

    for (const { g, temporary } of sources) {
        if (temporary) g.dispose();
    }
    if (disposeSources) {
        for (const geo of geometries) {
            if (geo && typeof geo.dispose === 'function') geo.dispose();
        }
    }

    return merged;
}

/**
 * 为几何体写入统一的顶点色（原地修改）。
 * 若几何体没有 color 属性则先创建。
 */
export function paintGeometry(geometry, color) {
    if (!geometry) return;
    const THREE = window.THREE;
    if (!THREE) return;

    const count = geometry.attributes.position ? geometry.attributes.position.count : 0;
    if (count === 0) return;

    let attr = geometry.attributes.color;
    if (!attr || attr.count !== count) {
        const arr = new Float32Array(count * 3);
        attr = new THREE.BufferAttribute(arr, 3);
        geometry.setAttribute('color', attr);
    }
    const r = ((color >> 16) & 0xFF) / 255;
    const g = ((color >> 8) & 0xFF) / 255;
    const b = (color & 0xFF) / 255;
    for (let i = 0; i < count; i++) {
        attr.array[i * 3] = r;
        attr.array[i * 3 + 1] = g;
        attr.array[i * 3 + 2] = b;
    }
    attr.needsUpdate = true;
}

/**
 * 安全释放一个 Object3D 下的所有几何体与材质。
 * @param {THREE.Object3D} root
 * @param {WeakSet} [shared] 共享资源集合，命中的资源不会被释放
 */
export function disposeObject3D(root, shared = null) {
    if (!root) return;
    root.traverse((child) => {
        if (!child) return;
        const geo = child.geometry;
        if (geo && typeof geo.dispose === 'function') {
            if (!shared || !shared.has(geo)) geo.dispose();
        }
        const mat = child.material;
        if (!mat) return;
        const list = Array.isArray(mat) ? mat : [mat];
        for (const m of list) {
            if (!m) continue;
            if (shared && shared.has(m)) continue;
            // 释放材质引用的贴图，防止显存泄漏
            for (const key of ['map', 'normalMap', 'roughnessMap', 'alphaMap', 'emissiveMap']) {
                const tex = m[key];
                if (tex && typeof tex.dispose === 'function' && (!shared || !shared.has(tex))) tex.dispose();
            }
            if (typeof m.dispose === 'function') m.dispose();
        }
    });
}