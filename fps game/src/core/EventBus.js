// 全局事件总线 - 用于系统间解耦通信
class EventBus {
    constructor() {
        this._listeners = new Map();
    }

    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, []);
        }
        this._listeners.get(event).push(callback);
        return () => this.off(event, callback);
    }

    off(event, callback) {
        const listeners = this._listeners.get(event);
        if (listeners) {
            const idx = listeners.indexOf(callback);
            if (idx >= 0) listeners.splice(idx, 1);
        }
    }

    emit(event, data = null) {
        const listeners = this._listeners.get(event);
        if (listeners) {
            // 使用副本避免在回调中修改导致的迭代问题
            listeners.slice().forEach(cb => {
                try {
                    cb(data);
                } catch (e) {
                    console.error(`EventBus error in ${event}:`, e);
                }
            });
        }
    }

    once(event, callback) {
        const wrapper = (data) => {
            callback(data);
            this.off(event, wrapper);
        };
        this.on(event, wrapper);
    }

    clear() {
        this._listeners.clear();
    }

    clearEvent(event) {
        this._listeners.delete(event);
    }
}

// 事件类型常量
const GAME_EVENTS = {
    // 实体生命周期
    ENTITY_SPAWNED: 'entity:spawned',
    ENTITY_DESTROYED: 'entity:destroyed',
    
    // 战斗事件
    DAMAGE_DEALT: 'combat:damage_dealt',
    HEAL_DEALT: 'combat:heal_dealt',
    ENEMY_KILLED: 'combat:enemy_killed',
    PLAYER_DIED: 'combat:player_died',
    HEADSHOT: 'combat:headshot',
    
    // 玩家事件
    PLAYER_MOVE: 'player:move',
    PLAYER_SHOOT: 'player:shoot',
    PLAYER_RELOAD: 'player:reload',
    PLAYER_DAMAGED: 'player:damaged',
    PLAYER_HEALED: 'player:healed',
    
    // 波次事件
    WAVE_STARTED: 'wave:started',
    WAVE_COMPLETED: 'wave:completed',
    WAVE_ENEMIES_SPAWNED: 'wave:enemies_spawned',
    
    // 经济事件
    GOLD_CHANGED: 'economy:gold_changed',
    SCORE_CHANGED: 'economy:score_changed',
    
    // 防御塔事件
    TOWER_BUILT: 'tower:built',
    TOWER_DESTROYED: 'tower:destroyed',
    TOWER_UPGRADED: 'tower:upgraded',
    
    // 技能事件
    SKILL_USED: 'skill:used',
    SKILL_COOLDOWN: 'skill:cooldown',
    
    // 连击事件
    COMBO_UPDATE: 'combo:update',
    COMBO_BONUS: 'combo:bonus'
};

window.EventBus = EventBus;
window.GAME_EVENTS = GAME_EVENTS;