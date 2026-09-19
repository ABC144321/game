/**
 * AIController —— 单个 AI 英雄的大脑
 *
 * 职责：把 Behaviors 给出的「意图」翻译成可执行动作（移动指令、技能释放）。
 *
 * 性能约束（这是 AI 不拖慢帧率的关键）：
 *  - 决策按 thinkInterval 节流（并带随机相位，避免所有 AI 同一帧集体思考）；
 *  - 寻路按 pathInterval 节流，且只有当目标点明显变化时才重新寻路；
 *  - 每帧只做「执行」，不做任何查询 —— 执行阶段只用缓存下来的引用。
 */

import { AI } from '../config/GameConfig.js';
import { AI_STATE, getProfile, survey, pickState, shouldCastAbility, lanePointAt, laneById } from './Behaviors.js';

export class AIController {
    constructor(opts = {}) {
        this.hero = opts.hero;
        this.world = opts.world;
        this.ctx = opts.ctx;
        this.bus = opts.bus;

        this.profileId = opts.profileId || 'defensive';
        this.profile = getProfile(this.profileId);
        this.laneId = opts.laneId || 'mid';
        this.lane = laneById(this.laneId);

        this.state = AI_STATE.LANE;
        this.commander = opts.commander || null;
        this.enabled = true;

        // 随机相位，打散全体 AI 的思考时刻
        this.thinkTimer = Math.random() * AI.thinkInterval;
        this.pathTimer = Math.random() * AI.pathInterval;
        this.castTimer = Math.random() * 0.5;

        this.laneProgress = 0.18 + Math.random() * 0.18;

        this.situation = null;
        this._moveGoal = { x: 0, z: 0, valid: false };
        this._aim = { x: 0, z: 0 };

        this.stats = { decisions: 0, casts: 0, stateChanges: 0 };
    }

    /* ------------------------------ 查询辅助 ------------------------------ */

    findNearestHero(team, range, exclude = null) {
        let best = null;
        let bestDist = Infinity;
        const heroes = this.world.heroes;
        for (let i = 0; i < heroes.length; i++) {
            const h = heroes[i];
            if (!h || !h.alive || h === exclude) continue;
            if (h.team !== team) continue;
            const d = Math.hypot(h.position.x - this.hero.position.x, h.position.z - this.hero.position.z);
            if (d < bestDist && d <= range) {
                bestDist = d;
                best = h;
            }
        }
        return best;
    }

    /** 可打的野怪（越近越优先，且不追太远） */
    findAvailableCamp() {
        let best = null;
        let bestDist = Infinity;
        const monsters = this.world.monsters;
        for (let i = 0; i < monsters.length; i++) {
            const m = monsters[i];
            if (!m || !m.alive || !m.fromCamp) continue;
            const d = Math.hypot(m.position.x - this.hero.position.x, m.position.z - this.hero.position.z);
            if (d < bestDist && d < 70) {
                bestDist = d;
                best = m;
            }
        }
        return best;
    }

    /* ------------------------------ 主循环 ------------------------------ */

    update(dt) {
        const hero = this.hero;
        if (!hero || !hero.alive) {
            this._moveGoal.valid = false;
            return;
        }
        if (!this.enabled) return;

        this.pathTimer -= dt;
        this.castTimer -= dt;

        this.thinkTimer -= dt;
        if (this.thinkTimer <= 0) {
            this.thinkTimer = AI.thinkInterval;
            this._think();
        }

        this._execute(dt);
    }

    _think() {
        const situation = survey(this);
        this.situation = situation;
        this.stats.decisions++;

        const stance = this.commander ? this.commander.stance : 'BALANCE';
        const next = pickState(this, situation, stance);

        if (next !== this.state) {
            this.state = next;
            this.stats.stateChanges++;
            // 状态切换时强制重新选点
            this._moveGoal.valid = false;
        }

        this._tryCastAbilities(situation);
    }

    /* ------------------------------ 技能 ------------------------------ */

    _tryCastAbilities(situation) {
        const hero = this.hero;
        if (!hero.alive) return;

        const targetPoint = this._pickAimPoint(situation);

        // 从后往前试：大招优先级高，但条件更苛刻，因此放在最后判定失败也无妨
        for (let i = 0; i < hero.abilities.length; i++) {
            const slot = hero.abilities[i];
            if (!slot) continue;
            const ability = { index: i, data: slot.data };
            if (!hero.canCast(i)) continue;

            if (this._shouldCast(ability, situation, targetPoint)) {
                const ok = hero.castAbility(i, targetPoint.x, targetPoint.z);
                if (ok) {
                    this.stats.casts++;
                    break; // 一次只放一个技能，避免瞬间倾泻全部冷却
                }
            }
        }
    }

    _shouldCast(ability, situation, point) {
        const hero = this.hero;
        const data = ability.data;

        // 撤退时把保命技能用掉
        if (this.state === AI_STATE.RETREAT || this.state === AI_STATE.DEFEND) {
            if (data.type === 'shield' || data.type === 'blink' || data.type === 'dash') {
                return data.type !== 'shield' || situation.hpRatio < 0.5;
            }
        }
        return shouldCastAbility(hero, ability, situation, point.x, point.z);
    }

    /** 技能瞄准点：优先敌方英雄，其次是敌军重心 */
    _pickAimPoint(situation) {
        const hero = this.hero;
        const aim = this._aim;

        if (situation.nearestEnemyHero && situation.nearestEnemyHero.alive) {
            aim.x = situation.nearestEnemyHero.position.x;
            aim.z = situation.nearestEnemyHero.position.z;
            return aim;
        }

        const enemies = situation.nearbyEnemies;
        if (enemies.length > 0) {
            let sx = 0;
            let sz = 0;
            let n = 0;
            for (const e of enemies) {
                if (!e) continue;
                sx += e.position.x;
                sz += e.position.z;
                n++;
            }
            if (n > 0) {
                aim.x = sx / n;
                aim.z = sz / n;
                return aim;
            }
        }

        // 兜底：朝兵线前方
        const p = lanePointAt(hero, this.lane, this.laneProgress);
        aim.x = p[0];
        aim.z = p[1];
        return aim;
    }

    /* ------------------------------ 执行 ------------------------------ */

    _execute(dt) {
        const hero = this.hero;
        const situation = this.situation;
        if (!situation) {
            this._advanceLane(dt);
            return;
        }

        switch (this.state) {
            case AI_STATE.RETREAT:
                this._goToBase();
                break;

            case AI_STATE.DEFEND: {
                const base = situation.ownBase;
                if (base) this._moveTo(base.position.x, base.position.z, 8);
                hero.forcedTarget = this.world.findNearestEnemy(hero, hero.attackRange + 2);
                break;
            }

            case AI_STATE.JUNGLE: {
                const camp = this.findAvailableCamp();
                if (camp) {
                    const d = Math.hypot(camp.position.x - hero.position.x, camp.position.z - hero.position.z);
                    if (d > hero.attackRange * 0.8) {
                        this._moveTo(camp.position.x, camp.position.z, hero.attackRange * 0.7);
                    } else {
                        hero.clearDestination();
                        hero.forcedTarget = camp;
                    }
                } else {
                    this._advanceLane(dt);
                }
                break;
            }

            case AI_STATE.ATTACK: {
                const target = situation.nearestEnemyHero;
                if (target && target.alive) {
                    const d = Math.hypot(
                        target.position.x - hero.position.x,
                        target.position.z - hero.position.z
                    );
                    if (d > hero.attackRange * 0.9) {
                        this._moveTo(target.position.x, target.position.z, hero.attackRange * 0.85);
                    } else {
                        hero.clearDestination();
                        hero.forcedTarget = target;
                    }
                } else {
                    this._advanceLane(dt);
                }
                break;
            }

            case AI_STATE.SUPPORT: {
                const ally = situation.nearestAlly;
                if (ally && ally.alive) {
                    const d = Math.hypot(ally.position.x - hero.position.x, ally.position.z - hero.position.z);
                    if (d > 8) this._moveTo(ally.position.x, ally.position.z, 7);
                    else hero.clearDestination();
                } else {
                    this._advanceLane(dt);
                }
                hero.forcedTarget = this.world.findNearestEnemy(hero, hero.attackRange + 2);
                break;
            }

            case AI_STATE.PUSH: {
                const tower = this.world.findNearestEnemyStructure(hero, 40);
                if (tower) {
                    const d = Math.hypot(tower.position.x - hero.position.x, tower.position.z - hero.position.z);
                    if (d > hero.attackRange + tower.radius * 0.8) {
                        this._moveTo(tower.position.x, tower.position.z, hero.attackRange);
                    } else {
                        hero.clearDestination();
                        hero.forcedTarget = tower;
                    }
                } else {
                    this._advanceLane(dt);
                }
                break;
            }

            case AI_STATE.LANE:
            default:
                this._advanceLane(dt);
                break;
        }
    }

    /** 沿兵线推进：把 laneProgress 缓慢前推，并朝该点移动 */
    _advanceLane(dt) {
        const hero = this.hero;
        this.laneProgress += dt * 0.012;
        if (this.laneProgress > 1) this.laneProgress = 1;

        const p = lanePointAt(hero, this.lane, this.laneProgress);
        const d = Math.hypot(p[0] - hero.position.x, p[1] - hero.position.z);
        if (d > 10) {
            this._moveTo(p[0], p[1], 8);
        }
        hero.forcedTarget = this.world.findNearestEnemy(hero, hero.attackRange + 1.5);
    }

    _goToBase() {
        const hero = this.hero;
        const base = this.world.baseFor(hero.team);
        if (!base) return;
        const d = Math.hypot(base.position.x - hero.position.x, base.position.z - hero.position.z);
        if (d > 12) this._moveTo(base.position.x, base.position.z, 10);
        else hero.clearDestination();
        hero.forcedTarget = null;
    }

    /**
     * 带节流的移动指令。
     * @param {number} stopDistance 距离目标多远就停下（避免单位挤成一坨）
     */
    _moveTo(x, z, stopDistance = 0) {
        const hero = this.hero;
        const goal = this._moveGoal;

        const dx = x - hero.position.x;
        const dz = z - hero.position.z;
        const d = Math.hypot(dx, dz);

        if (d <= stopDistance) {
            hero.clearDestination();
            goal.valid = false;
            return;
        }

        // 目标点明显变化 or 已经有段时间没重算，才重新寻路
        const moved = !goal.valid || Math.hypot(x - goal.x, z - goal.z) > 5;
        const stale = this.pathTimer <= 0;

        if (moved || stale) {
            goal.x = x;
            goal.z = z;
            goal.valid = true;
            this.pathTimer = AI.pathInterval;
            hero.setDestination(x, z, this.ctx.pathfinder);
        }
    }

    reset() {
        this.state = AI_STATE.LANE;
        this.thinkTimer = Math.random() * AI.thinkInterval;
        this.pathTimer = 0;
        this.laneProgress = 0.18;
        this._moveGoal.valid = false;
        this.situation = null;
    }
}