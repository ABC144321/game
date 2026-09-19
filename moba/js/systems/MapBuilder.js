/**
 * MapBuilder —— 初始世界搭建
 *
 * 负责把「配置里的静态数据」变成「场景中的实体」：
 *   基地 → 兵线防御塔 → 裂隙传送门 → 野怪营地 → 双方英雄
 *
 * 与 SpawnSystem 的分工：
 *   MapBuilder 只做一次的、不随时间变化的东西；
 *   SpawnSystem 负责随时间反复发生的（兵线波次、怪物波次、营地重生）。
 */

import {
    MAP, TEAM, TEAM_ROSTERS, BASE_STRUCTURE
} from '../config/GameConfig.js';
import { Base, WarTower } from '../entities/Structures.js';
import { Hero } from '../entities/Hero.js';

export class MapBuilder {
    /** @param {object} ctx 全局上下文（含 world / terrain / nav / shared / scene / bus） */
    constructor(ctx) {
        this.ctx = ctx;
        this.rifts = [];
        this.camps = [];
        this.heroes = [];
        this.playerHero = null;
    }

    build(playerHeroId = 'blade') {
        this._buildBase(TEAM.PLAYER, MAP.playerBase, '蓝方基地');
        this._buildBase(TEAM.ENEMY, MAP.enemyBase, '红方基地');
        this._buildWarTowers();
        this._buildRifts();
        this._buildCamps();
        this._buildHeroes(playerHeroId);
        return {
            rifts: this.rifts,
            camps: this.camps,
            heroes: this.heroes,
            playerHero: this.playerHero
        };
    }

    /* ------------------------------ 基地 ------------------------------ */

    _buildBase(team, pos, name) {
        const base = new Base({
            ctx: this.ctx,
            team,
            x: pos.x,
            z: pos.z,
            radius: BASE_STRUCTURE.radius,
            maxHp: BASE_STRUCTURE.maxHp,
            blockRadiusTiles: BASE_STRUCTURE.blockTiles,
            displayName: name
        });
        base.mesh = Base.buildMesh(this.ctx.shared, team);
        base.groundY = this.ctx.terrain.heightAt(pos.x, pos.z);
        base.position.y = base.groundY;
        base.syncMesh();
        base.occupy();
        base.attachHealthBar(this.ctx.shared, { width: 4.2, y: 7.4 });
        this.ctx.world.add(base);
        return base;
    }

    /* ------------------------------ 兵线防御塔 ------------------------------ */

    _buildWarTowers() {
        for (const spot of MAP.towerSpots) {
            const tower = new WarTower({
                ctx: this.ctx,
                team: spot.team,
                x: spot.x,
                z: spot.z,
                tier: spot.tier || 1
            });
            tower.laneId = spot.lane;
            tower.mesh = WarTower.buildMesh(this.ctx.shared, spot.team, tower.tier);
            tower.groundY = this.ctx.terrain.heightAt(spot.x, spot.z);
            tower.position.y = tower.groundY;
            tower.syncMesh();
            tower.occupy();
            tower.attachHealthBar(this.ctx.shared, { width: 2.0, y: 6.0 });
            this.ctx.world.add(tower);
        }
    }

    /* ------------------------------ 裂隙 ------------------------------ */

    _buildRifts() {
        const THREE = window.THREE;
        const shared = this.ctx.shared;

        for (const rift of MAP.rifts) {
            const group = new THREE.Group();

            const groundY = this.ctx.terrain.heightAt(rift.x, rift.z);
            group.position.set(rift.x, groundY, rift.z);

            const pad = new THREE.Mesh(
                shared.geo('cylinder'),
                shared.transparentGlow(0x6a3ca8, 0.55)
            );
            pad.scale.set(5.2, 0.16, 5.2);
            pad.position.y = 0.08;
            group.add(pad);

            const ring = new THREE.Mesh(
                shared.geo('ring'),
                shared.transparentGlow(0xb07cff, 0.75)
            );
            ring.rotation.x = -Math.PI / 2;
            ring.scale.setScalar(4.4);
            ring.position.y = 0.2;
            group.add(ring);

            const pillar = new THREE.Mesh(
                shared.geo('cylinder'),
                shared.transparentGlow(0xc9a6ff, 0.2)
            );
            pillar.scale.set(2.6, 12, 2.6);
            pillar.position.y = 6;
            group.add(pillar);

            const core = new THREE.Mesh(
                shared.geo('sphere'),
                shared.transparentGlow(0xd9b8ff, 0.9)
            );
            core.scale.setScalar(1.5);
            core.position.y = 3.2;
            group.add(core);

            this.ctx.scene.add(group);

            this.rifts.push({
                name: rift.name,
                x: rift.x,
                z: rift.z,
                position: new THREE.Vector3(rift.x, groundY, rift.z),
                groundY,
                mesh: group,
                core,
                spin: Math.random() * Math.PI * 2
            });
        }
    }

    /* ------------------------------ 野怪营地 ------------------------------ */

    _buildCamps() {
        for (const camp of MAP.jungleCamps) {
            const groundY = this.ctx.terrain.heightAt(camp.x, camp.z);
            this.camps.push({
                name: camp.name,
                x: camp.x,
                z: camp.z,
                groundY,
                monster: null,
                respawnTimer: 0
            });
        }
    }

    /* ------------------------------ 英雄 ------------------------------ */

    _buildHeroes(playerHeroId) {
        const spawnAtBase = (team, offsetIndex) => {
            const base = team === TEAM.PLAYER ? MAP.playerBase : MAP.enemyBase;
            const angle = (offsetIndex / 4) * Math.PI * 2;
            const r = 8 + (offsetIndex % 2) * 2.5;
            return {
                x: base.x + Math.cos(angle) * r,
                z: base.z + Math.sin(angle) * r
            };
        };

        // 玩家英雄
        const playerPos = spawnAtBase(TEAM.PLAYER, 0);
        const playerHero = this._createHero(playerHeroId, TEAM.PLAYER, playerPos, true);
        this.playerHero = playerHero;

        // AI 队友
        const playerRoster = TEAM_ROSTERS[TEAM.PLAYER] || [];
        playerRoster.forEach((slot, i) => {
            if (slot.heroId === playerHeroId) return; // 避免与玩家英雄重复
            const pos = spawnAtBase(TEAM.PLAYER, i + 1);
            this._createHero(slot.heroId, TEAM.PLAYER, pos, false, slot);
        });

        // AI 敌人
        const enemyRoster = TEAM_ROSTERS[TEAM.ENEMY] || [];
        enemyRoster.forEach((slot, i) => {
            const pos = spawnAtBase(TEAM.ENEMY, i);
            this._createHero(slot.heroId, TEAM.ENEMY, pos, false, slot);
        });
    }

    _createHero(heroId, team, pos, isPlayer, slot = null) {
        const hero = new Hero({
            ctx: this.ctx,
            team,
            heroId,
            x: pos.x,
            z: pos.z,
            isPlayer
        });
        hero.mesh = Hero.buildMesh(this.ctx.shared, hero.cfg, team);
        hero.groundY = this.ctx.terrain.heightAt(pos.x, pos.z);
        hero.position.y = hero.groundY;
        hero.syncMesh();
        hero.attachHealthBar(this.ctx.shared, { width: 1.35, y: 1.95 });

        hero.aiProfile = slot ? slot.profile : null;
        hero.laneId = slot ? slot.lane : 'mid';

        this.ctx.world.add(hero);
        this.heroes.push(hero);
        return hero;
    }
}