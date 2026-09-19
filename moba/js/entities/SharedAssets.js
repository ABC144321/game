/**
 * SharedAssets —— 全局共享的几何体与材质
 *
 * 这是「防止内存泄漏」的核心基础设施。
 *
 * 问题：如果每次生成一个单位就 new 一份 Geometry/Material，
 * 那么 1000 只怪物死亡后虽然从场景移除，显存里的材质仍然存在，
 * 玩久了必然 OOM。
 *
 * 方案：
 *  - 基础几何体只有一套（单位立方体、球、柱、锥、环、面片），
 *    通过 object.scale 表达尺寸差异；
 *  - 材质按「键」缓存，键的取值是有限枚举（兵种/阵营/建筑等级），
 *    因此材质数量恒定，与游戏时长无关；
 *  - 所有资源在 dispose() 中统一释放。
 */

import { TEAM, TEAM_COLORS, MINION_TYPES, MONSTER_TYPES, DEFENSE_TOWERS } from '../config/GameConfig.js';

export class SharedAssets {
    constructor() {
        const THREE = window.THREE;
        if (!THREE) throw new Error('SharedAssets 需要先加载 three.js');

        this._geo = new Map();
        this._mat = new Map();

        /* ---------- 基础几何体：统一以「单位尺寸」创建，用 scale 表达大小 ---------- */
        this._geo.set('box', new THREE.BoxGeometry(1, 1, 1));
        this._geo.set('sphere', new THREE.SphereGeometry(1, 12, 9));
        this._geo.set('sphereLow', new THREE.SphereGeometry(1, 8, 6));
        this._geo.set('cylinder', new THREE.CylinderGeometry(1, 1, 1, 10, 1));
        this._geo.set('cone', new THREE.ConeGeometry(1, 1, 8, 1));
        this._geo.set('ring', new THREE.RingGeometry(0.86, 1, 28));
        this._geo.set('plane', new THREE.PlaneGeometry(1, 1));
        this._geo.set('healthBar', new THREE.PlaneGeometry(1, 0.11));

        /* ---------- 常用材质 ---------- */
        this._mat.set('healthBarBg', new THREE.MeshBasicMaterial({
            color: 0x101014, side: THREE.DoubleSide, depthWrite: false
        }));
        this._mat.set('eye', new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
        this._mat.set('gunMetal', new THREE.MeshLambertMaterial({ color: 0x2b2f36 }));

        // 阵营色血条（蓝色/红色/中立黄）
        this.healthBarFill = new Map();
        for (const team of [TEAM.NEUTRAL, TEAM.PLAYER, TEAM.ENEMY]) {
            const color = team === TEAM.PLAYER ? 0x54d16a : (team === TEAM.ENEMY ? 0xe8534d : 0xd8c34a);
            this.healthBarFill.set(team, new THREE.MeshBasicMaterial({
                color, side: THREE.DoubleSide, depthWrite: false
            }));
        }
    }

    /* ------------------------------ 访问器 ------------------------------ */

    geo(name) {
        return this._geo.get(name) || null;
    }

    get healthBarGeo() { return this._geo.get('healthBar'); }
    get healthBarBg() { return this._mat.get('healthBarBg'); }

    healthBarFillFor(team) {
        return this.healthBarFill.get(team) || this.healthBarFill.get(TEAM.NEUTRAL);
    }

    /**
     * 按需创建并缓存材质。key 必须是有限枚举，否则缓存会无限增长。
     * @param {string} key
     * @param {() => THREE.Material} factory
     */
    material(key, factory) {
        const hit = this._mat.get(key);
        if (hit) return hit;
        const made = factory();
        this._mat.set(key, made);
        return made;
    }

    /* ------------------------------ 语义化材质 ------------------------------ */

    heroBody(heroId, color) {
        return this.material(`heroBody_${heroId}`, () => new THREE.MeshLambertMaterial({ color }));
    }

    heroAccent(heroId, color) {
        return this.material(`heroAccent_${heroId}`, () => new THREE.MeshBasicMaterial({ color }));
    }

    heroSkin() {
        return this.material('heroSkin', () => new THREE.MeshLambertMaterial({ color: 0xf0c8a0 }));
    }

    minionBody(typeId, team) {
        const cfg = MINION_TYPES[typeId];
        const base = cfg ? cfg.color : 0xffffff;
        const tint = this._mixWithTeam(base, team);
        return this.material(`minion_${typeId}_${team}`, () => new THREE.MeshLambertMaterial({ color: tint }));
    }

    monsterBody(typeId) {
        const cfg = MONSTER_TYPES[typeId];
        const color = cfg ? cfg.color : 0xcc5555;
        return this.material(`monster_${typeId}`, () => new THREE.MeshLambertMaterial({ color }));
    }

    campBody() {
        return this.material('campBody', () => new THREE.MeshLambertMaterial({ color: 0xc9a227 }));
    }

    teamMaterial(prefix, team, shade = 0) {
        const color = this._shade(TEAM_COLORS[team] || 0xffffff, shade);
        return this.material(`${prefix}_${team}_${shade}`, () => new THREE.MeshLambertMaterial({ color }));
    }

    defenseTowerMaterial(typeId, tier) {
        const cfg = DEFENSE_TOWERS[typeId];
        const base = cfg ? cfg.color : 0x88ccff;
        const color = this._shade(base, (tier - 1) * 0.12);
        return this.material(`defense_${typeId}_${tier}`, () => new THREE.MeshLambertMaterial({ color }));
    }

    /** 弹道/特效：按颜色缓存（颜色集合有限） */
    glow(color) {
        return this.material(`glow_${color}`, () => new THREE.MeshBasicMaterial({ color }));
    }

    transparentGlow(color, opacity = 0.5) {
        return this.material(`tglow_${color}_${opacity}`, () => new THREE.MeshBasicMaterial({
            color, transparent: true, opacity, depthWrite: false
        }));
    }

    /** 建造预览：合法（绿）/非法（红） */
    get buildValid() {
        return this.material('buildValid', () => new THREE.MeshBasicMaterial({
            color: 0x53e07a, transparent: true, opacity: 0.42, depthWrite: false
        }));
    }

    get buildInvalid() {
        return this.material('buildInvalid', () => new THREE.MeshBasicMaterial({
            color: 0xe05353, transparent: true, opacity: 0.42, depthWrite: false
        }));
    }

    /* ------------------------------ 工具 ------------------------------ */

    _shade(color, amount) {
        const r = Math.min(255, Math.max(0, ((color >> 16) & 0xFF) * (1 + amount)));
        const g = Math.min(255, Math.max(0, ((color >> 8) & 0xFF) * (1 + amount)));
        const b = Math.min(255, Math.max(0, (color & 0xFF) * (1 + amount)));
        return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
    }

    /** 把阵营色轻微混入单位基色，让玩家一眼分辨敌我 */
    _mixWithTeam(base, team) {
        const teamColor = TEAM_COLORS[team];
        if (teamColor === undefined) return base;
        const t = 0.42;
        const br = (base >> 16) & 0xFF, bg = (base >> 8) & 0xFF, bb = base & 0xFF;
        const tr = (teamColor >> 16) & 0xFF, tg = (teamColor >> 8) & 0xFF, tb = teamColor & 0xFF;
        const r = Math.round(br * (1 - t) + tr * t);
        const g = Math.round(bg * (1 - t) + tg * t);
        const b = Math.round(bb * (1 - t) + tb * t);
        return (r << 16) | (g << 8) | b;
    }

    stats() {
        return { geometries: this._geo.size, materials: this._mat.size };
    }

    dispose() {
        for (const g of this._geo.values()) {
            if (g && typeof g.dispose === 'function') g.dispose();
        }
        for (const m of this._mat.values()) {
            if (m && typeof m.dispose === 'function') m.dispose();
        }
        for (const m of this.healthBarFill.values()) {
            if (m && typeof m.dispose === 'function') m.dispose();
        }
        this._geo.clear();
        this._mat.clear();
        this.healthBarFill.clear();
    }
}