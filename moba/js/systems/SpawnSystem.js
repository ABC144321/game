/**
 * SpawnSystem —— 一切「随时间反复出现」的内容
 *
 * 三类生成：
 *  1. MOBA 兵线：双方每隔固定时间在三条兵线各刷一队小兵，沿折线推进；
 *  2. 塔防怪物：从裂隙按波次涌出，数量与强度随波次成长；
 *  3. 野怪营地：被清掉后延时重生，供打野型 AI 与玩家刷经济。
 *
 * 防坑设计：
 *  - 所有生成都检查存活上限，避免单位无限堆积拖垮帧率；
 *  - 批次生成使用 world.schedule 分散到多帧，避免「一瞬间刷 40 个」造成卡顿；
 *  - 定时器统一走 World，暂停/重开时自动失效，不会出现「暂停后仍在刷怪」。
 */

import { SPAWN, MAP, TEAM, MONSTER_TYPES, CAMP_MONSTER, MINION_TYPES } from '../config/GameConfig.js';
import { Minion } from '../entities/Minion.js';
import { Monster } from '../entities/Monster.js';
import { EVT } from '../core/EventBus.js';

export class SpawnSystem {
    constructor(ctx = {}) {
        this.ctx = ctx;
        this.world = ctx.world;
        this.bus = ctx.bus;
        this.shared = ctx.shared;
        this.rng = ctx.rng || Math.random;

        this.minionTimer = SPAWN.minion.firstDelay;
        this.monsterTimer = SPAWN.monster.firstDelay;
        this.monsterWave = 0;
        this.minionWave = 0;
        this.enabled = false;

        this.rifts = [];
        this.camps = [];
        this._pendingSpawns = 0;
    }

    setSources(rifts, camps) {
        this.rifts = Array.isArray(rifts) ? rifts : [];
        this.camps = Array.isArray(camps) ? camps : [];
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
    }

    reset() {
        this.minionTimer = SPAWN.minion.firstDelay;
        this.monsterTimer = SPAWN.monster.firstDelay;
        this.monsterWave = 0;
        this.minionWave = 0;
        this._pendingSpawns = 0;
    }

    /* ------------------------------ 主循环 ------------------------------ */

    update(dt) {
        if (!this.enabled) return;

        this._updateMinions(dt);
        this._updateMonsters(dt);
        this._updateCamps(dt);
    }

    /* ------------------------------ 兵线 ------------------------------ */

    _updateMinions(dt) {
        this.minionTimer -= dt;
        if (this.minionTimer > 0) return;
        this.minionTimer = SPAWN.minion.interval;
        this.minionWave++;
        this.spawnMinionWave();
    }

    /** 双方三条兵线同时出兵 */
    spawnMinionWave() {
        const alive = this.world.minions.length;
        if (alive >= SPAWN.minion.maxAlivePerTeam * 2) return;

        const isSiegeWave = this.minionWave % SPAWN.minion.siegesEvery === 0;

        for (const team of [TEAM.PLAYER, TEAM.ENEMY]) {
            for (const lane of MAP.lanes) {
                this._spawnLaneSquad(team, lane, isSiegeWave);
            }
        }

        if (this.bus) {
            this.bus.emit(EVT.MINION_WAVE, { wave: this.minionWave, siege: isSiegeWave });
        }
    }

    _spawnLaneSquad(team, lane, isSiegeWave) {
        const composition = SPAWN.minion.composition;
        const dir = team === TEAM.PLAYER ? 1 : -1;
        const base = team === TEAM.PLAYER ? MAP.playerBase : MAP.enemyBase;

        let index = 0;
        for (const key of Object.keys(composition)) {
            const count = composition[key];
            for (let i = 0; i < count; i++) {
                this._spawnMinion(team, lane, key, dir, base, index++);
            }
        }
        if (isSiegeWave) {
            this._spawnMinion(team, lane, 'siege', dir, base, index++);
        }
    }

    _spawnMinion(team, lane, typeId, dir, base, index) {
        const cfg = MINION_TYPES[typeId];
        if (!cfg) return null;

        // 出生点略作散布，避免所有小兵重叠
        const angle = Math.random() * Math.PI * 2;
        const r = 3 + Math.random() * 3.5;
        const x = base.x + Math.cos(angle) * r;
        const z = base.z + Math.sin(angle) * r;

        const minion = new Minion({
            ctx: this.ctx,
            team,
            x,
            z,
            minionType: typeId,
            laneId: lane.id,
            lanePoints: lane.points,
            dir,
            lateralOffset: ((index % 5) - 2) * 1.9
        });

        minion.mesh = Minion.buildMesh(this.shared, cfg, team);
        minion.groundY = this.ctx.terrain.heightAt(x, z);
        minion.syncMesh();

        this.world.add(minion);
        return minion;
    }

    /* ------------------------------ 怪物波次 ------------------------------ */

    _updateMonsters(dt) {
        this.monsterTimer -= dt;
        if (this.monsterTimer > 0) return;
        this.monsterTimer = SPAWN.monster.interval;
        this.startMonsterWave();
    }

    startMonsterWave() {
        if (this.world.monsters.length >= SPAWN.monster.maxAlive) return;

        this.monsterWave++;
        const cfg = SPAWN.monster;
        const isBoss = this.monsterWave % cfg.bossEvery === 0;

        let count = Math.round(cfg.baseCount * Math.pow(cfg.countGrowth, this.monsterWave - 1));
        count = Math.min(count, 34);
        if (isBoss) count = Math.max(4, Math.round(count * 0.5));

        const hpMul = Math.pow(cfg.hpGrowth, this.monsterWave - 1);
        const dmgMul = Math.pow(cfg.damageGrowth, this.monsterWave - 1);
        const spdMul = Math.min(1.5, Math.pow(cfg.speedGrowth, this.monsterWave - 1));

        if (this.bus) {
            this.bus.emit(EVT.WAVE_STARTED, {
                wave: this.monsterWave,
                count,
                boss: isBoss,
                prepareTime: cfg.prepareTime
            });
        }

        // 分散到多帧生成，避免瞬时卡顿
        const interval = 0.22;
        for (let i = 0; i < count; i++) {
            this.ctx.world.schedule(i * interval, () => {
                if (!this.enabled) return;
                const rift = this._pickRift();
                if (!rift) return;
                this.spawnMonster(this._pickMonsterType(this.monsterWave), rift, hpMul, dmgMul, spdMul);
            });
        }

        if (isBoss) {
            this.ctx.world.schedule(count * interval + 0.4, () => {
                if (!this.enabled) return;
                const rift = this._pickRift();
                if (rift) this.spawnMonster('boss', rift, hpMul, dmgMul, spdMul);
            });
        }
    }

    _pickRift() {
        if (this.rifts.length === 0) return null;
        // 优先选择离玩家基地较远的裂隙，让进攻有层次
        const idx = Math.floor(Math.random() * this.rifts.length);
        return this.rifts[idx] || null;
    }

    _pickMonsterType(wave) {
        const roll = Math.random();
        if (wave >= 4 && roll < 0.12) return 'tank';
        if (wave >= 2 && roll < 0.34) return 'fast';
        if (wave >= 3 && roll < 0.46) return 'flying';
        return 'grunt';
    }

    spawnMonster(typeId, rift, hpMul = 1, dmgMul = 1, spdMul = 1) {
        const cfg = MONSTER_TYPES[typeId] || MONSTER_TYPES.grunt;

        const angle = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 4;
        const x = rift.x + Math.cos(angle) * r;
        const z = rift.z + Math.sin(angle) * r;

        const monster = new Monster({
            ctx: this.ctx,
            team: TEAM.ENEMY,
            x,
            z,
            monsterType: typeId,
            goldValue: Math.round(16 * (1 + (hpMul - 1) * 0.5)),
            scoreValue: Math.round(10 * (1 + (hpMul - 1) * 0.5))
        });

        monster.maxHp = Math.round(cfg.maxHp * hpMul);
        monster.hp = monster.maxHp;
        monster.damage = cfg.damage * dmgMul;
        monster.moveSpeed = cfg.moveSpeed * spdMul;
        monster.mesh = Monster.buildMesh(this.shared, cfg);
        monster.groundY = this.ctx.terrain.heightAt(x, z);
        monster.syncMesh();

        if (monster.isElite) {
            monster.attachHealthBar(this.shared, {
                width: cfg.radius * 1.9,
                y: cfg.radius * 2.6
            });
        }

        this.world.add(monster);
        return monster;
    }

    /* ------------------------------ 野怪营地 ------------------------------ */

    _updateCamps(dt) {
        for (const camp of this.camps) {
            if (camp.monster && camp.monster.alive) continue;
            if (camp.monster && !camp.monster.alive) camp.monster = null;

            camp.respawnTimer -= dt;
            if (camp.respawnTimer > 0) continue;
            this._spawnCampMonster(camp);
        }
    }

    _spawnCampMonster(camp) {
        const cfg = CAMP_MONSTER;
        const angle = Math.random() * Math.PI * 2;
        const x = camp.x + Math.cos(angle) * 2.5;
        const z = camp.z + Math.sin(angle) * 2.5;

        const monster = new Monster({
            ctx: this.ctx,
            team: TEAM.NEUTRAL,
            x,
            z,
            monsterType: 'grunt',
            fromCamp: true,
            displayName: `${camp.name}野怪`,
            goldValue: 55,
            scoreValue: 45
        });

        monster.maxHp = cfg.maxHp;
        monster.hp = cfg.maxHp;
        monster.damage = cfg.damage;
        monster.moveSpeed = cfg.moveSpeed;
        monster.attackRange = cfg.attackRange;
        monster.attackInterval = cfg.attackInterval;
        monster.radius = cfg.radius;
        monster.armor = cfg.armor || 0;
        monster.aggroRange = 9;
        monster.goldValue = 55;
        monster.scoreValue = 45;

        monster.mesh = Monster.buildMesh(this.shared, MONSTER_TYPES.grunt);
        monster.mesh.scale.setScalar(1.5);
        monster.groundY = this.ctx.terrain.heightAt(x, z);
        monster.syncMesh();
        monster.attachHealthBar(this.shared, { width: 1.6, y: 2.6 });

        monster.lairX = camp.x;
        monster.lairZ = camp.z;

        this.world.add(monster);
        camp.monster = monster;
        camp.respawnTimer = SPAWN.camp.respawnDelay;

        // 野怪死亡后启动重生计时
        monster.onDeath = () => {
            camp.respawnTimer = SPAWN.camp.respawnDelay;
            camp.monster = null;
        };
        return monster;
    }

    /** 开局立刻放上营地野怪 */
    populateCamps() {
        for (const camp of this.camps) {
            if (camp.monster && camp.monster.alive) continue;
            this._spawnCampMonster(camp);
        }
    }

    /* ------------------------------ 状态 ------------------------------ */

    status() {
        return {
            monsterWave: this.monsterWave,
            minionWave: this.minionWave,
            nextMonsterIn: Math.max(0, Math.ceil(this.monsterTimer)),
            nextMinionIn: Math.max(0, Math.ceil(this.minionTimer)),
            monstersAlive: this.world.monsters.length,
            minionsAlive: this.world.minions.length
        };
    }
}