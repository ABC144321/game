/**
 * AICommander —— 队伍级指挥官
 *
 * 单个 AI 只看得见身边几十米，容易「一群人去推一条线，家被拆了没人管」。
 * 指挥官站在全局视角做两件事：
 *   1. 判断当前战略态势（进攻 / 僵持 / 防守）；
 *   2. 给每个 AI 分配该去的兵线，避免全部扎堆。
 *
 * 它是「低内聚」的反例修正：把全局判断从个体大脑里抽出来，
 * 个体只需要读 commander.stance，不必各自重复评估全局。
 */

import { AI, MAP, TEAM } from '../config/GameConfig.js';

export const STANCE = Object.freeze({
    PUSH: 'PUSH',
    BALANCE: 'BALANCE',
    DEFEND: 'DEFEND'
});

export class AICommander {
    constructor(opts = {}) {
        this.team = opts.team;
        this.world = opts.world;
        this.bus = opts.bus;

        this.controllers = [];
        this.stance = STANCE.BALANCE;
        this.timer = Math.random() * AI.commanderInterval;

        this.laneAssignments = new Map(); // controller -> laneId
        this.lanePressure = new Map();    // laneId -> 敌方单位数
        for (const lane of MAP.lanes) this.lanePressure.set(lane.id, 0);
    }

    register(controller) {
        if (!controller) return;
        this.controllers.push(controller);
        controller.commander = this;
    }

    update(dt) {
        this.timer -= dt;
        if (this.timer > 0) return;
        this.timer = AI.commanderInterval;
        this._evaluate();
    }

    _evaluate() {
        const world = this.world;
        const ownBase = world.baseFor(this.team);
        const enemyTeam = this.team === TEAM.PLAYER ? TEAM.ENEMY : TEAM.PLAYER;
        const enemyBase = world.baseFor(enemyTeam);

        const baseHp = ownBase ? ownBase.hpRatio : 1;
        const enemyBaseHp = enemyBase ? enemyBase.hpRatio : 1;

        // 威胁评估：己方基地附近的敌人数量
        let threat = 0;
        if (ownBase) {
            threat = world.queryEnemiesNear(ownBase.position.x, ownBase.position.z, 45, this.team).length;
        }

        // 塔差：推塔进度
        let ownTowers = 0;
        let enemyTowers = 0;
        for (const s of world.structures) {
            if (!s || !s.isWarTower) continue;
            if (s.team === this.team) ownTowers++;
            else enemyTowers++;
        }

        const previous = this.stance;
        if (threat >= 3 || baseHp < 0.6) {
            this.stance = STANCE.DEFEND;
        } else if (enemyBaseHp < 0.85 || enemyTowers < ownTowers) {
            this.stance = STANCE.PUSH;
        } else {
            this.stance = STANCE.BALANCE;
        }

        if (previous !== this.stance && this.bus) {
            this.bus.emit('ai:stance', { team: this.team, stance: this.stance, previous });
        }

        this._assignLanes();

        // 防守姿态下让 AI 顾家：把接近基地的敌方目标暴露给个体
        if (this.stance === STANCE.DEFEND) {
            for (const c of this.controllers) {
                if (c) c.laneProgress = c.hero && c.hero.team === TEAM.PLAYER ? 0.1 : 0.9;
            }
        }
    }

    /**
     * 兵线分配：把每条线的「压力」算出来，
     * 优先把打野/支援型 AI 调去没人管的线，避免出现空档。
     */
    _assignLanes() {
        const world = this.world;

        for (const lane of MAP.lanes) this.lanePressure.set(lane.id, 0);
        for (const m of world.minions) {
            if (!m || !m.alive || m.team === this.team) continue;
            const pressure = this.lanePressure.get(m.laneId);
            if (pressure !== undefined) this.lanePressure.set(m.laneId, pressure + 1);
        }

        for (const c of this.controllers) {
            if (!c || !c.hero || !c.enabled) continue;

            // 默认沿用出生时分配的线
            let laneId = c.laneId;

            // 打野与支援型会去压力最小的线协防
            if (c.profile.jungleBias > 0.5 || c.profile.supportBias > 0.5) {
                let minPressure = Infinity;
                for (const lane of MAP.lanes) {
                    const p = this.lanePressure.get(lane.id) || 0;
                    if (p < minPressure) {
                        minPressure = p;
                        laneId = lane.id;
                    }
                }
            }

            if (laneId !== c.laneId) {
                c.laneId = laneId;
                c.lane = MAP.lanes.find((l) => l.id === laneId) || c.lane;
            }
            this.laneAssignments.set(c, laneId);
        }
    }

    snapshot() {
        return {
            team: this.team,
            stance: this.stance,
            controllers: this.controllers.length,
            pressure: Object.fromEntries(this.lanePressure)
        };
    }
}