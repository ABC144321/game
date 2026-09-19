// 全局配置 - 集中管理所有游戏参数
const GAME_CONFIG = {
    // 游戏状态
    MAX_WAVES: 100,
    STARTING_HEALTH: 100,
    STARTING_SCORE: 0,
    STARTING_GOLD: 0,
    
    // 物理参数
    FIXED_DT: 1 / 60,
    MAX_FRAME_DT: 1 / 5,
    MAX_STEPS: 5,
    GRAVITY: 26,
    FRICTION_GROUND: 10,
    FRICTION_AIR: 2,
    PLAYER_SPEED: 8.5,
    PLAYER_SPRINT_MULT: 1.55,
    PLAYER_JUMP: 10.5,
    PLAYER_HEIGHT: 1.6,
    PLAYER_RADIUS: 0.4,
    
    // 武器配置
    WEAPONS: [
        { id: 1, name: '手枪', damage: 25, fireRate: 280, magSize: 12, reserveAmmo: 48, reloadTime: 1400, spread: 0.018, bulletSpeed: 90, bulletColor: 0xffaa00, auto: false, pellets: 1, recoil: 0.012 },
        { id: 2, name: '冲锋枪', damage: 14, fireRate: 90, magSize: 40, reserveAmmo: 160, reloadTime: 1800, spread: 0.055, bulletSpeed: 75, bulletColor: 0xffff00, auto: true, pellets: 1, recoil: 0.01 },
        { id: 3, name: '步枪', damage: 42, fireRate: 140, magSize: 30, reserveAmmo: 90, reloadTime: 2300, spread: 0.012, bulletSpeed: 110, bulletColor: 0x00ff00, auto: true, pellets: 1, recoil: 0.018 },
        { id: 4, name: '霰弹枪', damage: 16, fireRate: 650, magSize: 6, reserveAmmo: 24, reloadTime: 2800, spread: 0.14, bulletSpeed: 65, bulletColor: 0xff6600, auto: false, pellets: 8, recoil: 0.032 },
        { id: 5, name: '火箭筒', damage: 120, fireRate: 1400, magSize: 4, reserveAmmo: 12, reloadTime: 3200, spread: 0.02, bulletSpeed: 40, bulletColor: 0xff4400, auto: false, pellets: 1, recoil: 0.06, explosive: true, explosiveRadius: 6, explosiveDamage: 60 }
    ],
    
    // 敌人配置
    ENEMY_TYPES: {
        normal: { body: [0.7, 1.6, 0.5], head: 0.3, health: 60, damage: 15, speed: 3.1, scoreValue: 50, attackRange: 2.5, cooldown: 1000 },
        fast: { body: [0.5, 1.2, 0.35], head: 0.22, health: 40, damage: 10, speed: 6.2, scoreValue: 100, attackRange: 2.2, cooldown: 800 },
        tank: { body: [1, 2, 0.8], head: 0.45, health: 200, damage: 24, speed: 1.9, scoreValue: 200, attackRange: 2.8, cooldown: 1100 }
    },
    
    // 波次配置
    WAVE_BASE_ENEMIES: 3,
    WAVE_GROWTH: 1.6,
    WAVE_SPAWN_INTERVAL: 700,
    
    // 连击配置
    COMBO_WINDOW_MS: 2000,
    COMBO_BONUS_THRESHOLDS: [
        { count: 5, multiplier: 0.1 },
        { count: 10, multiplier: 0.15 },
        { count: 20, multiplier: 0.25 }
    ],
    
    // 塔防配置
    TOWER_TYPES: {
        basic: { cost: 50, damage: 40, range: 25, fireRate: 0.8, duration: 20000, color: 0x00aaff },
        splash: { cost: 80, damage: 30, range: 18, fireRate: 1.2, splashRadius: 4, duration: 25000, color: 0xff6600 },
        laser: { cost: 120, damage: 80, range: 30, fireRate: 2.0, duration: 30000, color: 0xff00aa }
    },
    
    // 金币奖励
    GOLD_PER_WAVE: 10,
    GOLD_PER_ENEMY: 5,
    GOLD_PER_HEADSHOT: 2,
    
    // 对象池限制
    MAX_BULLETS: 100,
    MAX_ENEMIES: 200,
    MAX_EFFECTS: 50,
    MAX_PICKUPS: 30,
    
    // 队友配置
    ALLY_CONFIG: {
        health: 90,
        damage: 14,
        fireRate: 380,
        range: 32,
        speed: 3.2
    },
    
    // 技能冷却
    SKILLS: {
        bulletTime: { cooldown: 8000, duration: 1500, timeScale: 0.3 },
        melee: { cooldown: 3000, damage: 60, range: 2.5, duration: 500 }
    }
};

// 导出配置到全局
window.GAME_CONFIG = GAME_CONFIG;