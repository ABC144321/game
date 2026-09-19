/**
 * EconomySystem —— 经济：金币、得分、统计数据
 *
 * 设计要点：
 *  - 金币按阵营分开记账（蓝方/红方），AI 阵营同样有经济，便于将来做 AI 买装备；
 *  - 所有金币变动都经过 spend()/addGold()，并统一发出事件，UI 只需监听事件刷新；
 *  - 被动收入使用累加器而不是 setTimeout，因此与暂停/时间倍率天然兼容。
 */

import { EVT } from '../core/EventBus.js';
import { ECONOMY, TEAM } from '../config/GameConfig.js';

export class EconomySystem {
    constructor(ctx = {}) {
        this.bus = ctx.bus || null;
        this.reset();
    }

    reset() {
        this.gold = {
            [TEAM.PLAYER]: ECONOMY.startGold,
            [TEAM.ENEMY]: ECONOMY.startGold,
            [TEAM.NEUTRAL]: 0
        };
        this.totalEarned = { [TEAM.PLAYER]: 0, [TEAM.ENEMY]: 0, [TEAM.NEUTRAL]: 0 };
        this.score = 0;
        this.kills = 0;
        this.stats = {
            minionKills: 0,
            monsterKills: 0,
            heroKills: 0,
            towerKills: 0,
            campsCleared: 0,
            towersBuilt: 0,
            goldSpent: 0,
            wavesSurvived: 0
        };
        this._incomeAccumulator = 0;
        this.emit();
    }

    /* ------------------------------ 收入 ------------------------------ */

    update(dt) {
        if (!Number.isFinite(dt) || dt <= 0) return;
        this._incomeAccumulator += dt;
        const interval = ECONOMY.incomeInterval;
        if (this._incomeAccumulator < interval) return;
        this._incomeAccumulator -= interval;
        // 被动收入：只给玩家与敌方，中立不参与
        this.addGold(TEAM.PLAYER, ECONOMY.passiveGoldPerSec * interval, false);
        this.addGold(TEAM.ENEMY, ECONOMY.passiveGoldPerSec * interval, false);
    }

    addGold(team, amount, silent = true) {
        const value = Math.max(0, Math.round(amount));
        if (value <= 0) return;
        if (this.gold[team] === undefined) this.gold[team] = 0;
        this.gold[team] += value;
        this.totalEarned[team] = (this.totalEarned[team] || 0) + value;
        if (!silent) this.emit();
    }

    awardKillGold(team, amount, target) {
        this.addGold(team, amount, true);

        if (team === TEAM.PLAYER) {
            if (target) {
                if (target.isMinion) this.stats.minionKills++;
                else if (target.isMonster) this.stats.monsterKills++;
                else if (target.isHero) this.stats.heroKills++;
                else if (target.isWarTower) this.stats.towerKills++;
            }
        }
        if (target && target.isHero) this.kills++;
        this.emit();
    }

    awardScore(amount) {
        const value = Math.round(amount);
        if (!Number.isFinite(value) || value === 0) return;
        this.score += value;
        if (this.score < 0) this.score = 0;
        if (this.bus) this.bus.emit(EVT.SCORE_CHANGED, { score: this.score });
        this.emit(false);
    }

    /* ------------------------------ 支出 ------------------------------ */

    get playerGold() {
        return this.gold[TEAM.PLAYER] || 0;
    }

    canAfford(cost) {
        return this.playerGold >= cost;
    }

    /**
     * 扣除玩家金币。
     * @returns {boolean} 是否成功（余额不足时不做任何修改）
     */
    spend(cost) {
        const value = Math.max(0, Math.round(cost));
        if (!Number.isFinite(value)) return false;
        if (value === 0) return true;
        if (this.gold[TEAM.PLAYER] < value) return false;
        this.gold[TEAM.PLAYER] -= value;
        this.stats.goldSpent += value;
        this.emit();
        return true;
    }

    refund(amount) {
        this.addGold(TEAM.PLAYER, amount, false);
        this.emit();
    }

    /* ------------------------------ 事件 ------------------------------ */

    emit() {
        if (!this.bus) return;
        this.bus.emit(EVT.GOLD_CHANGED, {
            gold: this.playerGold,
            enemyGold: this.gold[TEAM.ENEMY] || 0
        });
        this.bus.emit(EVT.PROGRESS_CHANGED, {
            score: this.score,
            kills: this.kills,
            stats: this.stats
        });
    }

    snapshot() {
        return {
            gold: this.playerGold,
            score: this.score,
            kills: this.kills,
            ...this.stats
        };
    }
}