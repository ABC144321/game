/**
 * EventBus —— 极简发布/订阅事件总线
 *
 * 设计要点：
 * 1. 系统之间只通过事件名通信，避免模块互相持有引用（低耦合）。
 * 2. emit 时对监听器数组做浅拷贝，允许监听器在回调中安全地 on/off。
 * 3. 单个监听器抛错不会中断其余监听器，错误被捕获并上报。
 */
export class EventBus {
    constructor(name = 'bus') {
        this.name = name;
        this._listeners = new Map();
        this._errorCount = 0;
    }

    /** 订阅事件，返回取消订阅函数 */
    on(type, handler) {
        if (typeof type !== 'string' || typeof handler !== 'function') return () => {};
        let list = this._listeners.get(type);
        if (!list) {
            list = [];
            this._listeners.set(type, list);
        }
        list.push(handler);
        return () => this.off(type, handler);
    }

    /** 只触发一次 */
    once(type, handler) {
        if (typeof handler !== 'function') return () => {};
        const wrapper = (payload) => {
            this.off(type, wrapper);
            handler(payload);
        };
        wrapper.__origin = handler;
        return this.on(type, wrapper);
    }

    off(type, handler) {
        const list = this._listeners.get(type);
        if (!list) return;
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this._listeners.delete(type);
    }

    emit(type, payload) {
        const list = this._listeners.get(type);
        if (!list || list.length === 0) return;
        // 浅拷贝：允许回调内部增删监听器而不影响本次遍历
        const snapshot = list.slice();
        for (let i = 0; i < snapshot.length; i++) {
            try {
                snapshot[i](payload);
            } catch (err) {
                this._errorCount++;
                if (this._errorCount <= 20) {
                    console.error(`[EventBus:${this.name}] 监听器执行出错 @ "${type}"`, err);
                }
            }
        }
    }

    /** 事件类型 -> 监听器数量，用于调试面板 */
    stats() {
        const out = {};
        for (const [type, list] of this._listeners) out[type] = list.length;
        return out;
    }

    clear() {
        this._listeners.clear();
    }
}

/** 全局事件名常量，避免字符串拼写错误 */
export const EVT = Object.freeze({
    GAME_START: 'game:start',
    GAME_PAUSE: 'game:pause',
    GAME_RESUME: 'game:resume',
    GAME_VICTORY: 'game:victory',
    GAME_DEFEAT: 'game:defeat',
    GAME_RESET: 'game:reset',

    ENTITY_SPAWNED: 'entity:spawned',
    ENTITY_DIED: 'entity:died',
    ENTITY_DAMAGED: 'entity:damaged',

    GOLD_CHANGED: 'economy:goldChanged',
    SCORE_CHANGED: 'economy:scoreChanged',
    PROGRESS_CHANGED: 'economy:progressChanged',

    WAVE_STARTED: 'spawn:waveStarted',
    WAVE_CLEARED: 'spawn:waveCleared',
    MINION_WAVE: 'spawn:minionWave',

    TOWER_BUILT: 'build:towerBuilt',
    TOWER_SOLD: 'build:towerSold',
    TOWER_UPGRADED: 'build:towerUpgraded',
    BUY_HERO_UPGRADE: 'build:heroUpgrade',

    HERO_LEVELUP: 'hero:levelUp',
    HERO_CAST: 'hero:cast',

    TOAST: 'ui:toast',
    SHAKE: 'fx:shake'
});