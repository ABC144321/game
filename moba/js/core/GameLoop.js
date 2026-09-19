/**
 * GameLoop —— 固定步长游戏循环（Fixed Timestep + 累加器）
 *
 * 为什么不用「每帧直接 update(dt)」？
 *   - 帧率波动时，物理/寻路/伤害计算会随 dt 变化，导致行为不一致（高刷屏跑得更快）。
 *   - 固定步长让逻辑与帧率解耦：无论 30fps 还是 144fps，模拟结果一致。
 *
 * 结构：
 *   rAF 回调
 *     ├─ 计算真实帧间隔 frameTime（并 clamp，防止切标签页回来后「一次补几百帧」）
 *     ├─ 累加 accumulator，每满一个 fixedStep 就执行一次 update(fixedStep)
 *     ├─ 单帧最多补 maxSubSteps 次，超出则丢弃余量（防「死亡螺旋」死循环）
 *     └─ 执行一次 render(frameTime, alpha) —— 渲染永远每帧一次
 *
 * alpha = accumulator / fixedStep，可用于渲染插值（消除固定步长带来的视觉抖动）。
 */
export class GameLoop {
    /**
     * @param {object} opts
     * @param {(dt:number)=>void} opts.update  固定步长逻辑更新
     * @param {(dt:number, alpha:number)=>void} opts.render 每帧渲染
     * @param {number} [opts.fixedStep]  逻辑步长秒数，默认 1/30
     * @param {number} [opts.maxSubSteps] 单帧最大补帧数
     * @param {number} [opts.maxFrameTime] 单帧最大时间跨度（秒）
     * @param {(stats:object)=>void} [opts.onStats] 每 0.5s 汇报一次性能
     * @param {(err:Error)=>void} [opts.onFatal] 连续异常时回调
     */
    constructor({ update, render, fixedStep = 1 / 30, maxSubSteps = 5, maxFrameTime = 0.25, onStats = null, onFatal = null } = {}) {
        if (typeof update !== 'function' || typeof render !== 'function') {
            throw new TypeError('GameLoop 需要 update 与 render 回调');
        }
        this._update = update;
        this._render = render;
        this._onStats = onStats;
        this._onFatal = onFatal;

        this.fixedStep = Math.max(1 / 240, fixedStep);
        this.maxSubSteps = Math.max(1, maxSubSteps | 0);
        this.maxFrameTime = Math.max(0.01, maxFrameTime);

        this.running = false;
        this.paused = false;
        this.timeScale = 1;

        this._acc = 0;
        this._lastTime = 0;
        this._rafId = 0;
        this._tick = this._tick.bind(this);

        this._fpsAccum = 0;
        this._fpsFrames = 0;
        this._updateMs = 0;
        this._renderMs = 0;
        this._errorStreak = 0;
        this._consecutiveDropFrames = 0;

        this.stats = {
            fps: 0,
            frameMs: 0,
            updateMs: 0,
            renderMs: 0,
            subSteps: 0,
            droppedSteps: 0,
            elapsed: 0
        };
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.paused = false;
        this._acc = 0;
        this._lastTime = 0;
        this._errorStreak = 0;
        this._rafId = requestAnimationFrame(this._tick);
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = 0;
    }

    setPaused(paused) {
        const next = !!paused;
        if (this.paused === next) return;
        this.paused = next;
        // 恢复时重置计时基准，避免把暂停期间的时间一次性补进来
        if (!next) {
            this._lastTime = 0;
            this._acc = 0;
        }
    }

    setTimeScale(scale) {
        this.timeScale = Math.max(0, Math.min(4, Number(scale) || 0));
    }

    _tick(now) {
        if (!this.running) return;
        this._rafId = requestAnimationFrame(this._tick);

        if (this._lastTime === 0) {
            this._lastTime = now;
            return;
        }

        let frameTime = (now - this._lastTime) / 1000;
        this._lastTime = now;

        // 异常大的间隔（切后台、断点调试）直接裁剪，避免瞬间执行上千次更新
        if (!Number.isFinite(frameTime) || frameTime < 0) frameTime = 0;
        if (frameTime > this.maxFrameTime) {
            frameTime = this.maxFrameTime;
            this._consecutiveDropFrames++;
        } else {
            this._consecutiveDropFrames = 0;
        }

        this.stats.elapsed += frameTime;

        let subSteps = 0;
        let dropped = 0;

        if (!this.paused && this.timeScale > 0) {
            this._acc += frameTime * this.timeScale;

            const t0 = performance.now();
            while (this._acc >= this.fixedStep) {
                if (subSteps >= this.maxSubSteps) {
                    // 丢弃余量：宁可让逻辑“慢下来”，也不能让本帧陷入死循环
                    dropped = Math.floor(this._acc / this.fixedStep);
                    this._acc = 0;
                    this.stats.droppedSteps += dropped;
                    break;
                }
                try {
                    this._update(this.fixedStep);
                    this._errorStreak = 0;
                } catch (err) {
                    this._errorStreak++;
                    console.error('[GameLoop] update 抛出异常', err);
                    // 连续异常说明状态已不可信，停止循环并上报，避免无限刷屏
                    if (this._errorStreak >= 30) {
                        this.stop();
                        if (this._onFatal) this._onFatal(err);
                        return;
                    }
                    this._acc = 0;
                    break;
                }
                this._acc -= this.fixedStep;
                subSteps++;
            }
            this._updateMs = performance.now() - t0;
        }

        const alpha = this.fixedStep > 0 ? this._acc / this.fixedStep : 0;

        const r0 = performance.now();
        try {
            this._render(frameTime, alpha);
        } catch (err) {
            this._errorStreak++;
            console.error('[GameLoop] render 抛出异常', err);
            if (this._errorStreak >= 30) {
                this.stop();
                if (this._onFatal) this._onFatal(err);
                return;
            }
        }
        this._renderMs = performance.now() - r0;

        this._fpsAccum += frameTime;
        this._fpsFrames++;
        if (this._fpsAccum >= 0.5) {
            this.stats.fps = Math.round(this._fpsFrames / this._fpsAccum);
            this.stats.frameMs = (this._fpsAccum / this._fpsFrames) * 1000;
            this.stats.updateMs = this._updateMs;
            this.stats.renderMs = this._renderMs;
            this.stats.subSteps = subSteps;
            this._fpsAccum = 0;
            this._fpsFrames = 0;
            if (this._onStats) {
                try { this._onStats(this.stats); } catch (err) { console.error('[GameLoop] onStats 出错', err); }
            }
        }
    }
}