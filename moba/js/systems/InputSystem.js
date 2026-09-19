/**
 * InputSystem —— 输入采集
 *
 * 只做「把浏览器事件翻译成稳定的查询接口」这一件事，不包含任何游戏语义。
 * 这样键位改动不需要碰游戏逻辑，游戏逻辑也不必了解 DOM 事件细节。
 *
 * 提供两类查询：
 *   - 持续状态：isDown('KeyW')、鼠标位置、鼠标按键
 *   - 一次性触发：wasPressed('KeyQ')（每帧末自动清空，避免「按住连发」）
 */

export class InputSystem {
    constructor(opts = {}) {
        this.element = opts.element || null;
        this.canvas = resolveCanvas(this.element);
        this.enabled = true;

        this._down = new Set();
        this._pressed = new Set();      // 本帧内新按下
        this._released = new Set();

        this.mouse = {
            x: 0,
            y: 0,
            ndcX: 0,
            ndcY: 0,
            left: false,
            right: false,
            middle: false,
            wheel: 0
        };

        this._dragging = false;
        this._lastMouse = { x: 0, y: 0 };
        this._dragDelta = { x: 0, y: 0 };
        this._bound = [];

        this._bind();
    }

    /* ------------------------------ 事件绑定 ------------------------------ */

    _on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        this._bound.push({ target, type, handler, options });
    }

    _bind() {
        this._on(window, 'keydown', (e) => {
            if (!this.enabled) return;
            // 避免 F5 / 开发者工具等被拦截
            if (e.repeat) return;
            this._down.add(e.code);
            this._pressed.add(e.code);
            if (['Space', 'Tab', 'F1'].includes(e.code)) e.preventDefault();
        });

        this._on(window, 'keyup', (e) => {
            this._down.delete(e.code);
            this._released.add(e.code);
        });

        this._on(window, 'blur', () => {
            // 失焦时清空按键，避免「切出去再回来还在往前跑」
            this._down.clear();
            this.mouse.left = false;
            this.mouse.right = false;
            this.mouse.middle = false;
            this._dragging = false;
        });

        const canvas = this.canvas;
        if (canvas) {
            this._on(canvas, 'contextmenu', (e) => e.preventDefault());

            this._on(canvas, 'mousemove', (e) => {
                this._updateMousePosition(e);
                if (this._dragging) {
                    const dx = e.clientX - this._lastMouse.x;
                    const dy = e.clientY - this._lastMouse.y;
                    this._dragDelta.x += dx;
                    this._dragDelta.y += dy;
                }
                this._lastMouse.x = e.clientX;
                this._lastMouse.y = e.clientY;
            });

            this._on(canvas, 'mousedown', (e) => {
                this._updateMousePosition(e);
                this._lastMouse.x = e.clientX;
                this._lastMouse.y = e.clientY;
                if (e.button === 0) this.mouse.left = true;
                else if (e.button === 1) { this.mouse.middle = true; this._dragging = true; e.preventDefault(); }
                else if (e.button === 2) this.mouse.right = true;
            });

            this._on(window, 'mouseup', (e) => {
                if (e.button === 0) this.mouse.left = false;
                else if (e.button === 1) { this.mouse.middle = false; this._dragging = false; }
                else if (e.button === 2) this.mouse.right = false;
            });

            this._on(canvas, 'wheel', (e) => {
                if (!this.enabled) return;
                e.preventDefault();
                this.mouse.wheel += e.deltaY;
            }, { passive: false });
        }
    }

    _updateMousePosition(e) {
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.mouse.ndcX = (e.clientX / w) * 2 - 1;
        this.mouse.ndcY = -(e.clientY / h) * 2 + 1;
    }

    /* ------------------------------ 查询 ------------------------------ */

    isDown(code) {
        return this._down.has(code);
    }

    wasPressed(code) {
        return this._pressed.has(code);
    }

    wasReleased(code) {
        return this._released.has(code);
    }

    /** 任意一个按键被按下 */
    anyPressed(codes) {
        for (const c of codes) {
            if (this._pressed.has(c)) return true;
        }
        return false;
    }

    /** 相机平移输入：x=右为正，z=前为正 */
    getCameraPan() {
        let x = 0;
        let z = 0;
        if (this.isDown('KeyW')) z += 1;
        if (this.isDown('KeyS')) z -= 1;
        if (this.isDown('KeyD')) x += 1;
        if (this.isDown('KeyA')) x -= 1;
        return { x, z };
    }

    /** 取走本帧的中键拖拽量（取走即清零） */
    consumeDrag() {
        const d = { x: this._dragDelta.x, y: this._dragDelta.y };
        this._dragDelta.x = 0;
        this._dragDelta.y = 0;
        return d;
    }

    /** 取走本帧滚轮量 */
    consumeWheel() {
        const w = this.mouse.wheel;
        this.mouse.wheel = 0;
        return w;
    }

    /** 每帧末调用：清空一次性触发 */
    endFrame() {
        this._pressed.clear();
        this._released.clear();
    }

    /** 清空全部状态（暂停/切菜单时用） */
    reset() {
        this._down.clear();
        this._pressed.clear();
        this._released.clear();
        this.mouse.left = false;
        this.mouse.right = false;
        this.mouse.middle = false;
        this._dragging = false;
        this.mouse.wheel = 0;
        if (this._dragDelta) {
            this._dragDelta.x = 0;
            this._dragDelta.y = 0;
        }
    }

    dispose() {
        for (const b of this._bound) {
            b.target.removeEventListener(b.type, b.handler, b.options);
        }
        this._bound.length = 0;
    }
}

/** 解析出用于绑定鼠标事件的元素：优先传入的元素，其次画布 */
function resolveCanvas(element) {
    if (element && typeof element.addEventListener === 'function' && element.nodeType === 1) {
        return element;
    }
    return document.getElementById('gameCanvas') || document.body;
}