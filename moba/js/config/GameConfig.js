/**
 * GameConfig —— 全部可调参数的唯一来源
 *
 * 约定：本文件是纯数据模块，不依赖 THREE，也不依赖任何运行时系统。
 * 所有数值集中在此，便于调平衡而不必翻遍逻辑代码。
 */

import { polylinePoint, polylineTangent } from '../core/MathUtils.js';

/* ============================== 基础尺度 ============================== */

export const TILE_SIZE = 2;          // 一个瓦片 2 米
export const CHUNK_TILES = 24;       // 每个分块 24x24 瓦片
export const CHUNK_SIZE = TILE_SIZE * CHUNK_TILES; // 48 米

export const TEAM = Object.freeze({
    NEUTRAL: 0,
    PLAYER: 1,
    ENEMY: 2
});

export const TEAM_COLORS = Object.freeze({
    [TEAM.NEUTRAL]: 0xc9a227,
    [TEAM.PLAYER]: 0x3fa9ff,
    [TEAM.ENEMY]: 0xff5555
});

export const TEAM_NAMES = Object.freeze({
    [TEAM.NEUTRAL]: '中立',
    [TEAM.PLAYER]: '蓝方',
    [TEAM.ENEMY]: '红方'
});

/* ============================== 地形生成 ============================== */

export const TERRAIN = {
    seed: 20260919,
    amplitude: 4.6,          // 高度起伏幅度
    baseFrequency: 0.0105,   // 低频：大山丘
    detailFrequency: 0.048,  // 高频：小起伏
    detailAmplitude: 0.55,
    octaves: 4,
    waterLevel: -1.15,
    shoreLevel: -0.55,
    walkMaxHeight: 1.75,     // 高于此高度视为峭壁，不可通行
    maxSlope: 1.35,          // 相邻瓦片高差超过此值视为峭壁
    treeDensity: 0.055,
    rockDensity: 0.028,
    propExclusionRadius: 13  // 兵线/基地附近的植被排除半径
};

/* ============================== 相机与渲染 ============================== */

export const CAMERA = {
    fov: 46,
    near: 0.5,
    far: 2000,
    pitch: 52,               // 初始俯角（度）
    minPitch: 26,
    maxPitch: 82,
    yaw: 40,
    zoom: 78,                // 相机到目标的距离（米）
    minZoom: 28,
    maxZoom: 190,
    panSpeed: 46,
    edgePanMargin: 26,       // 鼠标贴边平移的像素宽度
    rotateSpeed: 0.28
};

export const VIEW = {
    min: 120,
    max: 520,
    default: 260,
    // 渲染距离 -> 雾效参数比例
    fogNearRatio: 0.45,
    fogFarRatio: 0.98,
    // LOD 分级阈值（占渲染距离的比例）
    lod1Ratio: 0.22,         // 超过则隐藏植被等细节
    lod2Ratio: 0.5,          // 超过则使用简化单位模型
    chunkLoadMargin: 1,      // 额外预加载的分块环数
    maxBuildsPerFrame: 3,    // 每帧最多构建的分块数（防卡顿）
    buildBudgetMs: 6,        // 每帧构建耗时预算（毫秒）
    maxPendingQueue: 160     // 待建队列上限，防止快速移动时堆积
};

export const QUALITY_PRESETS = {
    low: { label: '低', shadows: false, propDetail: 0, maxPropsPerChunk: 40, entityLOD: true, pixelRatio: 1 },
    medium: { label: '中', shadows: true, propDetail: 1, maxPropsPerChunk: 90, entityLOD: true, pixelRatio: 1.25 },
    high: { label: '高', shadows: true, propDetail: 2, maxPropsPerChunk: 160, entityLOD: true, pixelRatio: 1.75 }
};

/* ============================== 地图布局 ============================== */

/**
 * 地图为菱形：玩家基地在西南角，敌方基地在东北角，三条兵线沿菱形边推进。
 * 坐标为世界单位（米）。
 */
const LANES = [
    {
        id: 'mid',
        name: '中路',
        points: [[-108, -108], [-58, -58], [0, 0], [58, 58], [108, 108]]
    },
    {
        id: 'top',
        name: '上路',
        points: [[-108, -108], [-108, -54], [-108, 42], [-70, 108], [0, 108], [64, 108], [108, 108]]
    },
    {
        id: 'bottom',
        name: '下路',
        points: [[-108, -108], [-54, -108], [42, -108], [108, -70], [108, 0], [108, 64], [108, 108]]
    }
];

/** 兵线推进方向：由玩家基地 -> 敌方基地，t=0 在玩家基地 */
function buildTowerSpots() {
    const spots = [];
    // 玩家方（防守方）：靠近自家基地；敌方镜像
    const playerFractions = [0.13, 0.30];
    const enemyFractions = [0.87, 0.70];
    const pt = [0, 0];
    const tan = [0, 0];
    const OFFSET = 7.5;

    for (const lane of LANES) {
        const tiers = playerFractions.length;
        playerFractions.forEach((t, i) => {
            polylinePoint(lane.points, t, pt);
            polylineTangent(lane.points, t, tan);
            spots.push({
                team: TEAM.PLAYER,
                lane: lane.id,
                x: pt[0] + (-tan[1]) * OFFSET,
                z: pt[1] + tan[0] * OFFSET,
                tier: tiers - i // 越靠近基地等级越高
            });
        });
        enemyFractions.forEach((t, i) => {
            polylinePoint(lane.points, t, pt);
            polylineTangent(lane.points, t, tan);
            spots.push({
                team: TEAM.ENEMY,
                lane: lane.id,
                x: pt[0] + (-tan[1]) * OFFSET,
                z: pt[1] + tan[0] * OFFSET,
                tier: i + 1
            });
        });
    }

    // 基地守卫塔
    for (const cfg of [
        { team: TEAM.PLAYER, bx: -108, bz: -108, ax: 0, az: -1 },
        { team: TEAM.ENEMY, bx: 108, bz: 108, ax: 0, az: 1 }
    ]) {
        for (const sign of [1, -1]) {
            spots.push({
                team: cfg.team,
                lane: 'base',
                x: cfg.bx + cfg.ax * 16 * sign + (18 * sign),
                z: cfg.bz + cfg.az * 16 * sign,
                tier: 3
            });
        }
    }
    return spots;
}

export const MAP = {
    playerBase: { x: -108, z: -108 },
    enemyBase: { x: 108, z: 108 },
    baseClearRadius: 13,
    lanes: LANES,
    towerSpots: buildTowerSpots(),
    // 塔防怪物裂隙：怪物从此处沿流场涌向玩家基地
    rifts: [
        { x: -176, z: -34, name: '西裂谷' },
        { x: -140, z: 96, name: '北裂谷' },
        { x: -38, z: 172, name: '霜裂谷' },
        { x: 70, z: 166, name: '灰裂谷' },
        { x: 172, z: 58, name: '东裂谷' },
        { x: 164, z: -72, name: '炎裂谷' }
    ],
    riftClearRadius: 7,
    // 野怪营地：AI 打野行为的目标
    jungleCamps: [
        { x: -62, z: 62, name: '迷雾营地' },
        { x: 62, z: -62, name: '碎岩营地' },
        { x: -142, z: 8, name: '古木营地' },
        { x: 12, z: -144, name: '荒丘营地' }
    ],
    campClearRadius: 6,
    // 流场计算边界（瓦片），由基地与裂隙包围盒推导，限定寻路规模
    flowPaddingTiles: 8
};

/** 采集所有需要「整平地形」的关键区域，供 Terrain 使用 */
export function collectFlattenAreas() {
    const areas = [];
    const addLane = (points) => {
        const step = 0.02;
        const pt = [0, 0];
        for (let t = 0; t <= 1.0001; t += step) {
            polylinePoint(points, Math.min(t, 1), pt);
            areas.push({ x: pt[0], z: pt[1], radius: 11, height: 0.35, strength: 1 });
        }
    };

    for (const lane of MAP.lanes) addLane(lane.points);

    for (const base of [MAP.playerBase, MAP.enemyBase]) {
        areas.push({ x: base.x, z: base.z, radius: MAP.baseClearRadius + 6, height: 0.3, strength: 1 });
    }
    for (const rift of MAP.rifts) {
        areas.push({ x: rift.x, z: rift.z, radius: MAP.riftClearRadius + 4, height: 0.2, strength: 1 });
    }
    for (const camp of MAP.jungleCamps) {
        areas.push({ x: camp.x, z: camp.z, radius: MAP.campClearRadius + 3, height: 0.3, strength: 1 });
    }
    for (const t of MAP.towerSpots) {
        areas.push({ x: t.x, z: t.z, radius: 5.5, height: 0.35, strength: 1 });
    }
    return areas;
}

/* ============================== 经济与成长 ============================== */

export const ECONOMY = {
    startGold: 420,
    passiveGoldPerSec: 2.4,
    incomeInterval: 1,
    gold: {
        monster: 16,
        minion: 13,
        siegeMinion: 30,
        hero: 140,
        tower: 220,
        camp: 55
    },
    score: {
        monster: 10,
        minion: 6,
        hero: 120,
        tower: 150
    },
    heroUpgrades: [
        { key: 'damage', name: '攻击力', desc: '提升英雄普攻与技能伤害', base: 90, growth: 1.45, step: 0.12, maxLevel: 8 },
        { key: 'maxHp', name: '生命上限', desc: '提升英雄最大生命值', base: 80, growth: 1.4, step: 0.15, maxLevel: 8 },
        { key: 'moveSpeed', name: '移动速度', desc: '提升英雄移动速度', base: 110, growth: 1.5, step: 0.06, maxLevel: 5 },
        { key: 'cooldown', name: '技能冷却', desc: '降低技能冷却时间', base: 150, growth: 1.6, step: 0.07, maxLevel: 5 }
    ]
};

/* ============================== 英雄 ============================== */

export const HEROES = {
    blade: {
        id: 'blade',
        name: '剑锋',
        role: '战士',
        desc: '近战爆发，突进切入',
        maxHp: 980,
        hpRegen: 9,
        damage: 54,
        attackRange: 3.4,
        attackInterval: 0.78,
        moveSpeed: 11.4,
        radius: 0.95,
        color: 0x3fa9ff,
        accent: 0xffe066,
        ranged: false,
        abilities: [
            { id: 'q', key: 'Q', name: '疾风突进', cooldown: 7, range: 15, radius: 3.6, damage: 130, type: 'dash', desc: '向目标点突进并造成范围伤害' },
            { id: 'w', key: 'W', name: '旋风斩', cooldown: 9, range: 0, radius: 6.2, damage: 160, type: 'aoeSelf', desc: '以自身为中心造成范围伤害' },
            { id: 'e', key: 'E', name: '铁壁', cooldown: 15, range: 0, radius: 0, type: 'shield', shield: 260, duration: 4, desc: '获得护盾，持续 4 秒' },
            { id: 'r', key: 'R', name: '剑刃风暴', cooldown: 42, range: 13, radius: 9.5, damage: 430, type: 'aoePoint', desc: '在目标点召唤剑刃风暴' }
        ]
    },
    ranger: {
        id: 'ranger',
        name: '游侠',
        role: '射手',
        desc: '远程持续输出，脆皮',
        maxHp: 720,
        hpRegen: 6,
        damage: 46,
        attackRange: 13.5,
        attackInterval: 0.66,
        moveSpeed: 11.2,
        radius: 0.85,
        color: 0x62d97a,
        accent: 0xd8ff6b,
        ranged: true,
        projectileColor: 0xbfffd0,
        abilities: [
            { id: 'q', key: 'Q', name: '穿透箭', cooldown: 6, range: 21, radius: 1.6, damage: 140, type: 'line', pierce: true, desc: '射出穿透箭，命中直线上所有敌人' },
            { id: 'w', key: 'W', name: '冰霜陷阱', cooldown: 11, range: 16, radius: 5.5, type: 'slowZone', slow: 0.45, duration: 4, damage: 60, desc: '布置减速区域' },
            { id: 'e', key: 'E', name: '疾风步', cooldown: 10, range: 11, radius: 0, type: 'blink', desc: '向目标点位移' },
            { id: 'r', key: 'R', name: '箭雨', cooldown: 44, range: 22, radius: 11, damage: 460, type: 'aoePoint', ticks: 4, desc: '持续落下的箭雨' }
        ]
    },
    guardian: {
        id: 'guardian',
        name: '守卫',
        role: '坦克',
        desc: '高血量前排，控制战场',
        maxHp: 1580,
        hpRegen: 14,
        damage: 42,
        attackRange: 3.6,
        attackInterval: 0.95,
        moveSpeed: 10.4,
        radius: 1.15,
        color: 0xe0a34a,
        accent: 0xffd98a,
        ranged: false,
        armor: 0.18,
        abilities: [
            { id: 'q', key: 'Q', name: '冲撞', cooldown: 10, range: 13, radius: 3.2, damage: 120, type: 'dash', stun: 1.0, desc: '冲撞并眩晕敌人' },
            { id: 'w', key: 'W', name: '大地壁垒', cooldown: 16, range: 0, radius: 0, type: 'shield', shield: 420, duration: 5, desc: '获得大量护盾' },
            { id: 'e', key: 'E', name: '威慑', cooldown: 13, range: 0, radius: 7.5, type: 'slowZone', slow: 0.5, duration: 3, damage: 70, selfCentered: true, desc: '减速周围敌人' },
            { id: 'r', key: 'R', name: '大地震击', cooldown: 48, range: 0, radius: 11, damage: 520, type: 'aoeSelf', stun: 1.6, desc: '震撼大地，眩晕范围内敌人' }
        ]
    }
};

/* ============================== 单位：小兵 / 怪物 ============================== */

export const MINION_TYPES = {
    melee: {
        id: 'melee', name: '近战兵',
        maxHp: 240, damage: 19, moveSpeed: 6.0, radius: 0.55,
        attackRange: 2.0, attackInterval: 1.0, color: 0x9fb2ff, grieveGold: 13
    },
    ranged: {
        id: 'ranged', name: '远程兵',
        maxHp: 165, damage: 23, moveSpeed: 5.6, radius: 0.5,
        attackRange: 9.0, attackInterval: 1.25, color: 0xcfe4ff, ranged: true, grieveGold: 13
    },
    siege: {
        id: 'siege', name: '攻城车',
        maxHp: 520, damage: 44, moveSpeed: 4.6, radius: 0.9,
        attackRange: 10.0, attackInterval: 1.9, color: 0xffcf6b, ranged: true,
        structureMultiplier: 2.2, grieveGold: 30
    }
};

export const MONSTER_TYPES = {
    grunt: {
        id: 'grunt', name: '裂谷小怪',
        maxHp: 130, damage: 17, moveSpeed: 5.2, radius: 0.7,
        attackRange: 2.3, attackInterval: 1.15, color: 0xd05555, armor: 0
    },
    fast: {
        id: 'fast', name: '疾行者',
        maxHp: 90, damage: 12, moveSpeed: 8.6, radius: 0.6,
        attackRange: 2.0, attackInterval: 0.85, color: 0xc478d0, armor: 0
    },
    tank: {
        id: 'tank', name: '重甲兽',
        maxHp: 460, damage: 32, moveSpeed: 3.4, radius: 1.15,
        attackRange: 2.7, attackInterval: 1.5, color: 0x6aa86a, armor: 0.28
    },
    flying: {
        id: 'flying', name: '浮空者',
        maxHp: 120, damage: 19, moveSpeed: 6.8, radius: 0.7,
        attackRange: 2.6, attackInterval: 1.0, color: 0x7fc8e8, armor: 0.05,
        flying: true, altitude: 3.4
    },
    boss: {
        id: 'boss', name: '裂谷首领',
        maxHp: 2600, damage: 62, moveSpeed: 3.7, radius: 1.9,
        attackRange: 3.6, attackInterval: 1.6, color: 0xff8a33, armor: 0.32
    }
};

export const CAMP_MONSTER = {
    id: 'camp', name: '野怪',
    maxHp: 620, damage: 34, moveSpeed: 4.2, radius: 1.0,
    attackRange: 2.6, attackInterval: 1.3, color: 0xc9a227, armor: 0.1
};

/* ============================== 建筑 ============================== */

export const WAR_TOWER = {
    // tier 1 = 前线塔, 3 = 基地塔
    stats: [
        null,
        { maxHp: 1500, damage: 58, attackRange: 12.5, attackInterval: 1.1, radius: 2.2 },
        { maxHp: 1950, damage: 76, attackRange: 13, attackInterval: 1.05, radius: 2.3 },
        { maxHp: 2600, damage: 98, attackRange: 14, attackInterval: 1.0, radius: 2.5 }
    ],
    blockTiles: 2,
    deathGold: 220,
    deathScore: 150
};

export const BASE_STRUCTURE = {
    maxHp: 7000,
    damage: 88,
    attackRange: 14.5,
    attackInterval: 1.2,
    radius: 5.2,
    blockTiles: 3,
    deathScore: 1000
};

/** 玩家可建造的防御塔（塔防元素） */
export const DEFENSE_TOWERS = {
    arrow: {
        id: 'arrow',
        name: '箭塔',
        hotkey: 'Z',
        desc: '单体高频攻击，性价比高',
        cost: 110,
        color: 0x63c8ff,
        projectileColor: 0xcdefff,
        tiers: [
            { maxHp: 260, damage: 20, attackRange: 15, attackInterval: 0.72, upgradeCost: 90 },
            { maxHp: 380, damage: 32, attackRange: 17, attackInterval: 0.66, upgradeCost: 170 },
            { maxHp: 540, damage: 50, attackRange: 19, attackInterval: 0.58, upgradeCost: 0 }
        ]
    },
    cannon: {
        id: 'cannon',
        name: '炮塔',
        hotkey: 'X',
        desc: '范围溅射，适合清群',
        cost: 175,
        color: 0xffa74d,
        projectileColor: 0xffd08a,
        splash: 5.0,
        tiers: [
            { maxHp: 320, damage: 34, attackRange: 13.5, attackInterval: 1.35, upgradeCost: 140 },
            { maxHp: 460, damage: 54, attackRange: 15, attackInterval: 1.25, upgradeCost: 260 },
            { maxHp: 650, damage: 84, attackRange: 16.5, attackInterval: 1.15, upgradeCost: 0 }
        ]
    },
    frost: {
        id: 'frost',
        name: '冰塔',
        hotkey: 'C',
        desc: '减速敌人，控场核心',
        cost: 150,
        color: 0x9fe8ff,
        projectileColor: 0xe4faff,
        splash: 3.4,
        slow: 0.45,
        slowDuration: 2.2,
        tiers: [
            { maxHp: 240, damage: 12, attackRange: 14, attackInterval: 1.1, upgradeCost: 120 },
            { maxHp: 340, damage: 20, attackRange: 15.5, attackInterval: 1.0, upgradeCost: 220 },
            { maxHp: 480, damage: 32, attackRange: 17, attackInterval: 0.9, upgradeCost: 0 }
        ]
    }
};

export const BUILD = {
    refundRatio: 0.6,          // 出售返还比例
    minDistanceBetweenTowers: 6.5,
    maxTowers: 24,             // 单局建造上限，防止过度铺塔导致性能问题
    blockedTilesAround: 1       // 塔周围不可再建的瓦片半径
};

/* ============================== 波次调度 ============================== */

export const SPAWN = {
    // MOBA 兵线
    minion: {
        firstDelay: 12,
        interval: 30,
        siegesEvery: 3,
        composition: { melee: 2, ranged: 1 },
        maxAlivePerTeam: 60
    },
    // 塔防怪物波次
    monster: {
        firstDelay: 26,
        interval: 42,
        baseCount: 6,
        countGrowth: 1.32,
        hpGrowth: 1.16,
        damageGrowth: 1.09,
        speedGrowth: 1.012,
        bossEvery: 5,
        maxAlive: 90,
        prepareTime: 6
    },
    camp: {
        respawnDelay: 75,
        initialAlive: true
    }
};

/* ============================== AI ============================== */

export const AI = {
    // 决策节拍（秒）：不同英雄错开，避免同一帧集中计算
    thinkInterval: 0.35,
    pathInterval: 1.1,
    commanderInterval: 2.5,
    maxPathNodes: 6000,
    searchRadiusForTarget: 30,
    fleeHpRatio: 0.26,
    visionRange: 34
};

/** AI 行为档案：决定英雄的作战风格 */
export const AI_PROFILES = {
    aggressive: {
        id: 'aggressive',
        label: '激进',
        desc: '主动越线压制，追击残血',
        retreatHpRatio: 0.20,
        chaseRange: 22,
        engageAdvantage: 0.85,
        jungleBias: 0.12,
        supportBias: 0.05,
        defendBias: 0.35,
        towerDive: true
    },
    defensive: {
        id: 'defensive',
        label: '防守',
        desc: '守住塔线，不轻易深入',
        retreatHpRatio: 0.42,
        chaseRange: 11,
        engageAdvantage: 1.35,
        jungleBias: 0.08,
        supportBias: 0.15,
        defendBias: 1.0,
        towerDive: false
    },
    jungler: {
        id: 'jungler',
        label: '打野',
        desc: '清理野区与游走支援',
        retreatHpRatio: 0.30,
        chaseRange: 16,
        engageAdvantage: 1.1,
        jungleBias: 0.75,
        supportBias: 0.35,
        defendBias: 0.5,
        towerDive: false
    },
    support: {
        id: 'support',
        label: '支援',
        desc: '跟随队友，协同作战',
        retreatHpRatio: 0.36,
        chaseRange: 15,
        engageAdvantage: 1.15,
        jungleBias: 0.1,
        supportBias: 0.85,
        defendBias: 0.75,
        towerDive: false
    }
};

/** 双方阵容：玩家固定为 blade（可通过 UI 切换），AI 队友与敌人各有风格 */
export const TEAM_ROSTERS = {
    [TEAM.PLAYER]: [
        { heroId: 'guardian', profile: 'defensive', lane: 'top' },
        { heroId: 'ranger', profile: 'support', lane: 'bottom' },
        { heroId: 'blade', profile: 'jungler', lane: 'mid' }
    ],
    [TEAM.ENEMY]: [
        { heroId: 'blade', profile: 'aggressive', lane: 'mid' },
        { heroId: 'guardian', profile: 'defensive', lane: 'top' },
        { heroId: 'ranger', profile: 'support', lane: 'bottom' },
        { heroId: 'blade', profile: 'jungler', lane: 'mid' }
    ]
};