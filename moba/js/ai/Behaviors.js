/**
 * Behaviors —— AI 决策规则
 *
 * 把「怎么想」和「怎么做」分开：
 *   Behaviors 只负责根据局势输出一个「意图」（AI_STATE + 目标），
 *   AIController 负责把这个意图翻译成移动指令与技能释放。
 *
 * 这样做的价值：
 *   - 想调整 AI 性格（更激进/更保守）只需要改这里的判定权重，不碰执行代码；
 *   - 新增一种行为风格只需要在 GameConfig 里加一份 profile；
 *   - 单元测试可以直接喂局势对象验证决策结果，无需运行整个游戏。
 */

import { AI_PROFILES, AI, MAP } from '../config/GameConfig.js';

export const AI_STATE = Object.freeze({
    IDLE: 'idle',
    LANE: 'lane',         // 推进兵线
    PUSH: 'push',         // 强攻敌方建筑
    ATTACK: 'attack',     // 主动交战敌方英雄
    RETREAT: 'retreat',   // 残血撤退
    JUNGLE: 'jungle',     // 打野
    SUPPORT: 'support',   // 支援队友
    DEFEND: 'defend'      // 回防基地
});

export function getProfile(id) {
    return AI_PROFILES[id] || AI_PROFILES.defensive;
}

/**
 * 收集一次「局势快照」。
 * 每 thinkInterval 才调用一次，因此这里可以放心做多次查询，
 * 不必担心像每帧执行那样昂贵。
 */
export function survey(controller) {
    const hero = controller.hero;
    const world = controller.world;
    const profile = controller.profile;
    const ownBase = world.baseFor(hero.team);
    const enemyTeam = hero.team === 1 ? 2 : 1;
    const enemyBase = world.baseFor(enemyTeam);

    const nearestEnemyHero = controller.findNearestHero(enemyTeam, AI.visionRange);
    const nearestAlly = controller.findNearestHero(hero.team, AI.visionRange, hero);
    const nearbyEnemies = world.queryEnemiesNear(hero.position.x, hero.position.z, 22, hero.team);
    const nearbyAllies = world.queryAlliesNear(hero.position.x, hero.position.z, 22, hero.team);

    let threatToBase = 0;
    if (ownBase) {
        const baseThreats = world.queryEnemiesNear(ownBase.position.x, ownBase.position.z, 46, hero.team);
        threatToBase = baseThreats.length;
    }

    return {
        hpRatio: hero.hpRatio,
        profile,
        ownBase,
        enemyBase,
        baseHpRatio: ownBase ? ownBase.hpRatio : 1,
        enemyBaseHpRatio: enemyBase ? enemyBase.hpRatio : 1,
        nearestEnemyHero,
        nearestAlly,
        nearbyEnemies,
        nearbyAllies,
        enemyCount: nearbyEnemies.length,
        allyCount: nearbyAllies.length,
        threatToBase,
        distanceToBase: ownBase
            ? Math.hypot(ownBase.position.x - hero.position.x, ownBase.position.z - hero.position.z)
            : 0
    };
}

/**
 * 根据局势挑一个状态。
 * 判定顺序本身就是「优先级」：活下来 > 守家 > 打野 > 团战 > 支援 > 推线。
 */
export function pickState(controller, situation, commanderStance) {
    const hero = controller.hero;
    const profile = situation.profile;

    // 1) 残血撤退：任何风格都会先保命
    if (situation.hpRatio < profile.retreatHpRatio) {
        return AI_STATE.RETREAT;
    }

    // 2) 基地告急：防守倾向高的 AI 立刻回防
    if (situation.threatToBase >= 2 && commanderStance === 'DEFEND') {
        const bias = profile.defendBias;
        if (Math.random() < bias) return AI_STATE.DEFEND;
    }

    // 3) 打野：野性倾向高且野区有货
    const camp = controller.findAvailableCamp();
    if (camp && Math.random() < profile.jungleBias) {
        return AI_STATE.JUNGLE;
    }

    // 4) 交战判定：己方兵力占优、且血线安全
    const advantage = (situation.allyCount + 1) / (situation.enemyCount + 1);
    const enemyHeroInRange = situation.nearestEnemyHero &&
        Math.hypot(
            situation.nearestEnemyHero.position.x - hero.position.x,
            situation.nearestEnemyHero.position.z - hero.position.z
        ) < profile.chaseRange;

    if (enemyHeroInRange && advantage >= profile.engageAdvantage) {
        // 越塔判定：激进风格才敢在敌方塔下开打
        const tower = controller.world.findNearestEnemyStructure(hero, 16);
        if (!tower || profile.towerDive || tower.hpRatio < 0.35) {
            return AI_STATE.ATTACK;
        }
    }

    // 5) 支援：队友残血且自己有余力
    if (situation.nearestAlly && Math.random() < profile.supportBias) {
        const allyHp = situation.nearestAlly.hpRatio;
        if (allyHp < 0.6 && situation.hpRatio > 0.5) return AI_STATE.SUPPORT;
    }

    // 6) 默认推线；若推进顺利则转为强攻建筑
    if (situation.allyCount > situation.enemyCount + 1 && situation.hpRatio > 0.55) {
        return AI_STATE.PUSH;
    }

    return AI_STATE.LANE;
}

/**
 * 判断某个技能此刻是否值得放。
 * 统一在这里判定，避免每个技能类型各写一遍条件。
 */
export function shouldCastAbility(hero, ability, situation, aimX, aimZ) {
    if (!hero.canCast(ability.index)) return false;
    const data = ability.data;

    switch (data.type) {
        case 'shield':
            // 血量偏低或正在被围攻时开启
            return situation.hpRatio < 0.62 || situation.enemyCount >= 2;

        case 'aoeSelf': {
            const victims = hero.ctx.world.queryEnemiesNear(
                hero.position.x, hero.position.z, data.radius, hero.team
            );
            // 大招要求更多人，小技能 2 个就够
            const need = data.cooldown > 30 ? 2 : 1;
            return victims.length >= need;
        }

        case 'aoePoint':
        case 'slowZone':
        case 'line': {
            const dx = aimX - hero.position.x;
            const dz = aimZ - hero.position.z;
            const dist = Math.hypot(dx, dz);
            if (data.range > 0 && dist > data.range) return false;
            const victims = hero.ctx.world.queryEnemiesNear(aimX, aimZ, Math.max(3, data.radius), hero.team);
            const need = data.cooldown > 30 ? 2 : 1;
            return victims.length >= need;
        }

        case 'dash':
        case 'blink': {
            const dx = aimX - hero.position.x;
            const dz = aimZ - hero.position.z;
            const dist = Math.hypot(dx, dz);
            // 突进只用来切入或拉开距离，不做无意义位移
            if (dist < 3) return false;
            const victims = hero.ctx.world.queryEnemiesNear(aimX, aimZ, Math.max(3, data.radius), hero.team);
            return victims.length >= 1;
        }

        default:
            return false;
    }
}

/** 取兵线上「当前推进进度附近」的一个目标点 */
export function lanePointAt(hero, lane, progress) {
    const lanePoints = lane.points;
    const t = hero.team === 1 ? Math.min(1, progress) : Math.max(0, 1 - progress);
    const clamped = Math.max(0, Math.min(1, t));
    const out = [0, 0];
    const len = lanePoints.length;
    // 手动线性插值，避免把 polylinePoint 的依赖带进 AI 层
    const segCount = len - 1;
    const scaled = clamped * segCount;
    const idx = Math.min(segCount - 1, Math.floor(scaled));
    const frac = scaled - idx;
    const a = lanePoints[idx];
    const b = lanePoints[idx + 1] || a;
    out[0] = a[0] + (b[0] - a[0]) * frac;
    out[1] = a[1] + (b[1] - a[1]) * frac;
    return out;
}

/** 找到距离英雄最近的兵线配置 */
export function laneById(id) {
    return MAP.lanes.find((l) => l.id === id) || MAP.lanes[0];
}