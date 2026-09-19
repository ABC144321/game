/**
 * HUD —— 所有信息层的显示与交互
 *
 * 与游戏逻辑的关系：
 *   逻辑层从不直接操作 DOM，只通过 EventBus 广播；HUD 订阅事件并刷新界面。
 *   这样做的代价是多一层事件，收益是「改 UI 不会碰到玩法代码」，
 *   而且 UI 可以被关闭/替换而不影响模拟。
 *
 * 性能考量：
 *   - 数值刷新按 4Hz 节流，避免每帧写 DOM 触发重排；
 *   - 小地图按 8Hz 重绘，且地形底图只生成一次（离屏 canvas）；
 *   - 性能面板按 2Hz 刷新。
 */

import { HEROES, ECONOMY, TEAM, VIEW, MAP, QUALITY_PRESETS } from '../config/GameConfig.js';
import { EVT } from '../core/EventBus.js';

export class HUD {
    constructor(ctx = {}) {
        this.ctx = ctx;
        this.callbacks = ctx.callbacks || {};
        this.bus = ctx.bus;

        this.hero = null;
        this.playerHero = null;

        this._refreshTimer = 0;
        this._minimapTimer = 0;
        this._perfTimer = 0;
        this._selectedHeroId = 'blade';

        this._minimapTerrain = null;
        this._minimapBounds = this._computeMinimapBounds();

        this.els = this._collectElements();
        this._buildHeroPicker();
        this._bindEvents();
        this._subscribe();
        this._bindSettings();
    }

    /* ------------------------------ 元素收集 ------------------------------ */

    _collectElements() {
        const id = (name) => document.getElementById(name);
        return {
            waveValue: id('waveValue'),
            waveTimer: id('waveTimer'),
            goldValue: id('goldValue'),
            scoreValue: id('scoreValue'),
            killValue: id('killValue'),
            baseHpFill: id('baseHpFill'),
            enemyBaseHpFill: id('enemyBaseHpFill'),
            stanceValue: id('stanceValue'),

            minimap: id('minimap'),

            heroName: id('heroName'),
            heroLevel: id('heroLevel'),
            heroHpFill: id('heroHpFill'),
            heroHpText: id('heroHpText'),
            heroXpFill: id('heroXpFill'),
            upgradeList: id('upgradeList'),
            abilityBar: id('abilityBar'),

            viewDistanceSlider: id('viewDistanceSlider'),
            viewDistanceValue: id('viewDistanceValue'),
            zoomSlider: id('zoomSlider'),
            zoomValue: id('zoomValue'),
            qualitySelect: id('qualitySelect'),
            perfToggle: id('perfToggle'),
            followToggle: id('followToggle'),

            perfPanel: id('perfPanel'),
            perfFps: id('perfFps'),
            perfUpdate: id('perfUpdate'),
            perfRender: id('perfRender'),
            perfChunks: id('perfChunks'),
            perfCulled: id('perfCulled'),
            perfDraw: id('perfDraw'),
            perfTris: id('perfTris'),
            perfEntities: id('perfEntities'),
            perfProjectiles: id('perfProjectiles'),
            perfMaterials: id('perfMaterials'),

            toastBox: id('toastBox'),
            startScreen: id('startScreen'),
            pauseScreen: id('pauseScreen'),
            resultScreen: id('resultScreen'),
            resultTitle: id('resultTitle'),
            resultSubtitle: id('resultSubtitle'),
            resultStats: id('resultStats'),
            heroPicker: id('heroPicker'),
            bootNote: id('bootNote')
        };
    }

    /* ------------------------------ 事件绑定 ------------------------------ */

    _bindEvents() {
        const cb = this.callbacks;
        const on = (el, event, fn) => {
            if (el) el.addEventListener(event, fn);
        };

        on(document.getElementById('startButton'), 'click', () => cb.onStart && cb.onStart(this._selectedHeroId));
        on(document.getElementById('resumeButton'), 'click', () => cb.onResume && cb.onResume());
        on(document.getElementById('restartButton'), 'click', () => cb.onRestart && cb.onRestart());
        on(document.getElementById('restartButton2'), 'click', () => cb.onRestart && cb.onRestart());
        on(document.getElementById('quitButton'), 'click', () => cb.onQuit && cb.onQuit());
        on(document.getElementById('quitButton2'), 'click', () => cb.onQuit && cb.onQuit());

        // 小地图跳转
        on(this.els.minimap, 'click', (e) => {
            const rect = this.els.minimap.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * this.els.minimap.width;
            const py = ((e.clientY - rect.top) / rect.height) * this.els.minimap.height;
            const world = this._minimapToWorld(px, py);
            if (world && cb.onMinimapClick) cb.onMinimapClick(world.x, world.z);
        });
    }

    _bindSettings() {
        const els = this.els;
        const cb = this.callbacks;

        if (els.viewDistanceSlider) {
            els.viewDistanceSlider.value = String(VIEW.default);
            els.viewDistanceSlider.addEventListener('input', () => {
                const v = Number(els.viewDistanceSlider.value);
                els.viewDistanceValue.textContent = String(v);
                if (cb.onViewDistanceChange) cb.onViewDistanceChange(v);
            });
            els.viewDistanceSlider.addEventListener('change', () => {
                this.toast(`渲染距离：${els.viewDistanceSlider.value} 米`, 'info');
            });
        }

        if (els.zoomSlider) {
            els.zoomSlider.addEventListener('input', () => {
                const v = Number(els.zoomSlider.value);
                els.zoomValue.textContent = String(v);
                if (cb.onZoomChange) cb.onZoomChange(v);
            });
        }

        if (els.qualitySelect) {
            els.qualitySelect.addEventListener('change', () => {
                const name = els.qualitySelect.value;
                if (cb.onQualityChange) cb.onQualityChange(name);
                const preset = QUALITY_PRESETS[name];
                this.toast(`画质切换为「${preset ? preset.label : name}」`, 'info');
            });
        }

        if (els.perfToggle) {
            els.perfToggle.addEventListener('change', () => {
                els.perfPanel.classList.toggle('hidden', !els.perfToggle.checked);
            });
        }

        if (els.followToggle) {
            els.followToggle.addEventListener('change', () => {
                if (cb.onFollowChange) cb.onFollowChange(els.followToggle.checked);
            });
        }
    }

    _subscribe() {
        const bus = this.bus;
        if (!bus) return;

        bus.on(EVT.GOLD_CHANGED, () => this._refreshTopBar());
        bus.on(EVT.PROGRESS_CHANGED, () => this._refreshTopBar());
        bus.on(EVT.WAVE_STARTED, (p) => {
            if (!p) return;
            const boss = p.boss ? '（首领来袭！）' : '';
            this.toast(`第 ${p.wave} 波怪物涌出裂隙${boss}`, p.boss ? 'danger' : 'warning');
        });
        bus.on(EVT.MINION_WAVE, (p) => {
            if (!p) return;
            if (p.siege) this.toast(`兵线出击 · 攻城车加入（第 ${p.wave} 波）`, 'info');
        });
        bus.on(EVT.WAVE_CLEARED, (p) => {
            if (p) this.toast(`第 ${p.wave} 波已清空`, 'success');
        });
        bus.on(EVT.HERO_LEVELUP, (p) => {
            if (p && p.hero && p.hero.isPlayer) this.toast(`升级！当前等级 ${p.hero.level}`, 'gold');
        });
        bus.on(EVT.TOWER_BUILT, () => this.refreshUpgrades());
    }

    /* ------------------------------ 英雄选择 ------------------------------ */

    get selectedHeroId() {
        return this._selectedHeroId;
    }

    _buildHeroPicker() {
        const container = this.els.heroPicker;
        if (!container) return;
        container.innerHTML = '';

        Object.values(HEROES).forEach((cfg) => {
            const card = document.createElement('div');
            card.className = 'hero-card' + (cfg.id === this._selectedHeroId ? ' active' : '');
            card.dataset.hero = cfg.id;

            const avatar = document.createElement('div');
            avatar.className = 'hero-avatar';
            avatar.style.background = `linear-gradient(135deg, #${cfg.color.toString(16).padStart(6, '0')}, #${cfg.accent.toString(16).padStart(6, '0')})`;

            const body = document.createElement('div');
            body.className = 'hero-card-body';
            body.innerHTML = `
                <div class="hero-card-name">${cfg.name}</div>
                <div class="hero-card-role">${cfg.role}</div>
                <div class="hero-card-desc">${cfg.desc}</div>
            `;

            card.appendChild(avatar);
            card.appendChild(body);
            card.addEventListener('click', () => {
                this._selectedHeroId = cfg.id;
                container.querySelectorAll('.hero-card').forEach((c) => c.classList.remove('active'));
                card.classList.add('active');
            });
            container.appendChild(card);
        });
    }

    /* ------------------------------ 英雄绑定 ------------------------------ */

    /** 开局/重开时把 HUD 接到玩家英雄上 */
    bindHero(hero) {
        this.playerHero = hero;
        this.hero = hero;
        this._buildAbilityBar();
        this.refreshUpgrades();
        this._refreshHeroPanel();
    }

    _buildAbilityBar() {
        const bar = this.els.abilityBar;
        if (!bar) return;
        bar.innerHTML = '';
        if (!this.hero) return;

        this._abilityEls = [];

        this.hero.abilities.forEach((slot, index) => {
            const data = slot.data;
            const isUltimate = data.cooldown >= 30;

            const el = document.createElement('div');
            el.className = 'ability-slot' + (isUltimate ? ' ultimate' : '');
            el.innerHTML = `
                <span class="ability-key">${data.key}</span>
                <span class="ability-name">${data.name}</span>
                <div class="ability-cd hidden">0</div>
            `;

            const cdEl = el.querySelector('.ability-cd');
            el.addEventListener('click', () => {
                if (this.callbacks.onAbilityClick) this.callbacks.onAbilityClick(index);
            });
            el.title = data.desc || data.name;

            bar.appendChild(el);
            this._abilityEls.push({ el, cdEl, slot });
        });
    }

    _refreshHeroPanel() {
        const hero = this.hero;
        if (!hero || !this.els.heroName) return;

        this.els.heroName.textContent = `${hero.heroName} · ${hero.role}`;
        this.els.heroLevel.textContent = `Lv.${hero.level}`;

        const hpPercent = Math.max(0, hero.hpRatio * 100);
        this.els.heroHpFill.style.width = hpPercent + '%';
        this.els.heroHpFill.style.background = hpPercent > 55
            ? 'linear-gradient(90deg, #2f9e44, #63e07a)'
            : (hpPercent > 25
                ? 'linear-gradient(90deg, #d99b1e, #ffcc44)'
                : 'linear-gradient(90deg, #b32d2d, #ff6b6b)');

        const shieldText = hero.shield > 0 ? `  (+${Math.round(hero.shield)} 护盾)` : '';
        this.els.heroHpText.textContent = `${Math.ceil(hero.hp)} / ${hero.maxHp}${shieldText}`;

        const needed = hero.level * 120;
        const xpPercent = hero.level >= 15 ? 100 : Math.min(100, (hero.xp / needed) * 100);
        this.els.heroXpFill.style.width = xpPercent + '%';
    }

    refreshUpgrades() {
        const list = this.els.upgradeList;
        const hero = this.playerHero;
        if (!list || !hero) return;

        const economy = this.ctx.economy;
        const gold = economy ? economy.playerGold : 0;

        if (!this._upgradeEls) {
            list.innerHTML = '';
            this._upgradeEls = {};
            for (const def of ECONOMY.heroUpgrades) {
                const btn = document.createElement('button');
                btn.className = 'upgrade-btn';
                btn.dataset.key = def.key;
                btn.innerHTML = `
                    <span class="u-name">${def.name}</span>
                    <span class="u-cost">—</span>
                `;
                btn.title = def.desc;
                btn.addEventListener('click', () => {
                    if (this.callbacks.onUpgrade) this.callbacks.onUpgrade(def.key);
                });
                list.appendChild(btn);
                this._upgradeEls[def.key] = btn;
            }
        }

        for (const def of ECONOMY.heroUpgrades) {
            const btn = this._upgradeEls[def.key];
            if (!btn) continue;
            const level = hero.upgrades[def.key] || 0;
            const costEl = btn.querySelector('.u-cost');
            const maxed = level >= def.maxLevel;

            btn.classList.toggle('maxed', maxed);
            if (maxed) {
                costEl.textContent = `已满级 (${def.maxLevel})`;
                btn.disabled = true;
            } else {
                const cost = hero.upgradeCost(def.key);
                costEl.textContent = `${cost} 金 · ${level}/${def.maxLevel}`;
                btn.disabled = gold < cost;
            }
        }
    }

    /* ------------------------------ 顶部状态条 ------------------------------ */

    _refreshTopBar() {
        const ctx = this.ctx;
        const world = ctx.world;
        const economy = ctx.economy;
        if (!world || !economy) return;

        if (this.els.goldValue) this.els.goldValue.textContent = String(Math.floor(economy.playerGold));
        if (this.els.scoreValue) this.els.scoreValue.textContent = String(economy.score);
        if (this.els.killValue) this.els.killValue.textContent = String(economy.kills);

        const playerBase = world.baseFor(TEAM.PLAYER);
        const enemyBase = world.baseFor(TEAM.ENEMY);
        if (this.els.baseHpFill) {
            this.els.baseHpFill.style.width = (playerBase ? playerBase.hpRatio * 100 : 0) + '%';
        }
        if (this.els.enemyBaseHpFill) {
            this.els.enemyBaseHpFill.style.width = (enemyBase ? enemyBase.hpRatio * 100 : 0) + '%';
        }

        const spawner = ctx.spawnSystem;
        if (spawner && this.els.waveValue) {
            this.els.waveValue.textContent = String(spawner.monsterWave || 0);
            const status = spawner.status();
            const boss = status.monsterWave > 0 && status.monsterWave % 5 === 0;
            this.els.waveTimer.textContent = boss
                ? `下一波 ${status.nextMonsterIn}s`
                : `下一波 ${status.nextMonsterIn}s · 场上 ${status.monstersAlive}`;
        }

        if (this.els.stanceValue && this.ctx.enemyCommander) {
            const stance = this.ctx.enemyCommander.stance;
            this.els.stanceValue.textContent = stance === 'PUSH' ? '进攻' : (stance === 'DEFEND' ? '防守' : '僵持');
        }
    }

    /* ------------------------------ 小地图 ------------------------------ */

    _computeMinimapBounds() {
        const points = [MAP.playerBase, MAP.enemyBase, ...MAP.rifts, ...MAP.jungleCamps];
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of points) {
            if (!p) continue;
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minZ = Math.min(minZ, p.z);
            maxZ = Math.max(maxZ, p.z);
        }
        const pad = 34;
        const size = Math.max(maxX - minX, maxZ - minZ) + pad * 2;
        const cx = (minX + maxX) * 0.5;
        const cz = (minZ + maxZ) * 0.5;
        return { minX: cx - size * 0.5, minZ: cz - size * 0.5, size };
    }

    _worldToMinimap(x, z, canvasSize) {
        const b = this._minimapBounds;
        const px = ((x - b.minX) / b.size) * canvasSize;
        const py = ((z - b.minZ) / b.size) * canvasSize;
        return { x: px, y: py };
    }

    _minimapToWorld(px, py) {
        const b = this._minimapBounds;
        const canvas = this.els.minimap;
        if (!canvas) return null;
        const x = b.minX + (px / canvas.width) * b.size;
        const z = b.minZ + (py / canvas.height) * b.size;
        return { x, z };
    }

    /** 预渲染地形底图（只做一次），后续每帧直接贴图，避免逐像素采样 */
    buildMinimapTerrain(terrain) {
        if (!terrain || !this.els.minimap) return;
        const res = 128;
        const canvas = document.createElement('canvas');
        canvas.width = res;
        canvas.height = res;
        const c2d = canvas.getContext('2d');
        const b = this._minimapBounds;
        const cell = b.size / res;

        const img = c2d.createImageData(res, res);
        for (let j = 0; j < res; j++) {
            for (let i = 0; i < res; i++) {
                const wx = b.minX + (i + 0.5) * cell;
                const wz = b.minZ + (j + 0.5) * cell;
                const tx = Math.floor(wx / 2);
                const tz = Math.floor(wz / 2);
                const info = terrain.tileInfo(tx, tz);
                const color = info ? info.color : [0.15, 0.2, 0.15];
                const idx = (j * res + i) * 4;
                img.data[idx] = Math.round(color[0] * 255);
                img.data[idx + 1] = Math.round(color[1] * 255);
                img.data[idx + 2] = Math.round(color[2] * 255);
                img.data[idx + 3] = 255;
            }
        }
        c2d.putImageData(img, 0, 0);
        this._minimapTerrain = canvas;
    }

    _drawMinimap() {
        const canvas = this.els.minimap;
        if (!canvas) return;
        const c2d = canvas.getContext('2d');
        if (!c2d) return;

        const W = canvas.width;
        const H = canvas.height;
        const b = this._minimapBounds;

        c2d.clearRect(0, 0, W, H);

        if (this._minimapTerrain) {
            c2d.globalAlpha = 0.95;
            c2d.drawImage(this._minimapTerrain, 0, 0, W, H);
            c2d.globalAlpha = 1;
        } else {
            c2d.fillStyle = '#0f1a14';
            c2d.fillRect(0, 0, W, H);
        }

        // 兵线
        c2d.strokeStyle = 'rgba(255, 255, 255, 0.16)';
        c2d.lineWidth = 1.5;
        for (const lane of MAP.lanes) {
            c2d.beginPath();
            lane.points.forEach((p, i) => {
                const pt = this._worldToMinimap(p[0], p[1], W);
                if (i === 0) c2d.moveTo(pt.x, pt.y);
                else c2d.lineTo(pt.x, pt.y);
            });
            c2d.stroke();
        }

        // 裂隙
        for (const rift of MAP.rifts) {
            const pt = this._worldToMinimap(rift.x, rift.z, W);
            c2d.fillStyle = 'rgba(180, 120, 255, 0.85)';
            c2d.beginPath();
            c2d.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2);
            c2d.fill();
        }

        // 营地
        for (const camp of MAP.jungleCamps) {
            const pt = this._worldToMinimap(camp.x, camp.z, W);
            c2d.fillStyle = 'rgba(210, 180, 60, 0.75)';
            c2d.beginPath();
            c2d.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2);
            c2d.fill();
        }

        const world = this.ctx.world;
        if (!world) return;

        // 建筑
        for (const s of world.structures) {
            if (!s) continue;
            const pt = this._worldToMinimap(s.position.x, s.position.z, W);
            const isBase = s.isBase;
            const size = isBase ? 6 : 3.4;
            c2d.fillStyle = s.team === TEAM.PLAYER ? '#4ea6ff' : '#ff5a5a';
            if (isBase) {
                c2d.fillRect(pt.x - size * 0.5, pt.y - size * 0.5, size, size);
                c2d.strokeStyle = '#fff';
                c2d.lineWidth = 1;
                c2d.strokeRect(pt.x - size * 0.5, pt.y - size * 0.5, size, size);
            } else {
                c2d.beginPath();
                c2d.arc(pt.x, pt.y, size, 0, Math.PI * 2);
                c2d.fill();
            }
        }

        // 单位
        const drawUnits = (list, color, radius, filterFn) => {
            c2d.fillStyle = color;
            for (const u of list) {
                if (!u || !u.alive) continue;
                if (filterFn && !filterFn(u)) continue;
                const pt = this._worldToMinimap(u.position.x, u.position.z, W);
                c2d.beginPath();
                c2d.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
                c2d.fill();
            }
        };

        const isPlayerMinion = (m) => m.team === TEAM.PLAYER;
        const isEnemyMinion = (m) => m.team === TEAM.ENEMY;

        drawUnits(world.minions, 'rgba(120, 190, 255, 0.8)', 1.5, isPlayerMinion);
        drawUnits(world.minions, 'rgba(255, 140, 140, 0.8)', 1.5, isEnemyMinion);
        drawUnits(world.monsters, 'rgba(220, 90, 220, 0.85)', 1.9, null);

        // 英雄
        for (const h of world.heroes) {
            if (!h || !h.alive) continue;
            const pt = this._worldToMinimap(h.position.x, h.position.z, W);
            if (h.isPlayer) {
                c2d.fillStyle = '#ffe066';
                c2d.beginPath();
                c2d.arc(pt.x, pt.y, 4.4, 0, Math.PI * 2);
                c2d.fill();
                c2d.strokeStyle = '#fff';
                c2d.lineWidth = 1.4;
                c2d.stroke();
            } else {
                c2d.fillStyle = h.team === TEAM.PLAYER ? '#8fd0ff' : '#ff9a9a';
                c2d.beginPath();
                c2d.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2);
                c2d.fill();
            }
        }

        // 视野矩形（相机位置）
        const cc = this.ctx.cameraController;
        if (cc) {
            const pt = this._worldToMinimap(cc.target.x, cc.target.z, W);
            c2d.strokeStyle = 'rgba(255, 255, 255, 0.45)';
            c2d.lineWidth = 1;
            c2d.strokeRect(pt.x - 9, pt.y - 7, 18, 14);
        }
    }

    /* ------------------------------ 性能面板 ------------------------------ */

    updatePerf(stats) {
        const els = this.els;
        if (!els.perfPanel || els.perfPanel.classList.contains('hidden')) return;
        if (!stats) return;

        els.perfFps.textContent = String(stats.fps);
        els.perfUpdate.textContent = `${stats.updateMs.toFixed(1)}ms`;
        els.perfRender.textContent = `${stats.renderMs.toFixed(1)}ms`;
        els.perfChunks.textContent = `${stats.chunksVisible} / ${stats.chunksLoaded}`;
        els.perfCulled.textContent = `${stats.chunksFrustum + stats.chunksCulled}`;
        els.perfDraw.textContent = String(stats.drawCalls);
        els.perfTris.textContent = this._formatNumber(stats.triangles);
        els.perfEntities.textContent = String(stats.entities);
        els.perfProjectiles.textContent = String(stats.projectiles);
        els.perfMaterials.textContent = String(stats.materials);
    }

    _formatNumber(n) {
        const v = Number(n) || 0;
        if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
        if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
        return String(v);
    }

    /* ------------------------------ 每帧 ------------------------------ */

    update(dt) {
        this._refreshTimer -= dt;
        if (this._refreshTimer <= 0) {
            this._refreshTimer = 0.25;
            this._refreshTopBar();
            this._refreshHeroPanel();
            this.refreshUpgrades();
            this._refreshAbilities();
        }

        this._minimapTimer -= dt;
        if (this._minimapTimer <= 0) {
            this._minimapTimer = 0.12;
            this._drawMinimap();
        }
    }

    _refreshAbilities() {
        if (!this._abilityEls || !this.hero) return;
        for (let i = 0; i < this._abilityEls.length; i++) {
            const entry = this._abilityEls[i];
            const slot = this.hero.abilities[i];
            if (!slot) continue;

            const remaining = slot.remaining;
            if (remaining > 0.05) {
                entry.cdEl.classList.remove('hidden');
                entry.cdEl.textContent = remaining >= 1 ? Math.ceil(remaining) : remaining.toFixed(1);
                entry.el.classList.remove('ready');
            } else {
                entry.cdEl.classList.add('hidden');
                entry.el.classList.add('ready');
            }
        }
    }

    /* ------------------------------ 提示 ------------------------------ */

    toast(text, type = 'info') {
        const box = this.els.toastBox;
        if (!box) return;

        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = text;
        box.appendChild(el);

        // 动画结束后自行移除；同时限制最大数量防止无限堆积
        window.setTimeout(() => {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 2900);

        while (box.childElementCount > 6) {
            box.removeChild(box.firstElementChild);
        }
    }

    /* ------------------------------ 界面切换 ------------------------------ */

    showScreen(name) {
        const els = this.els;
        const set = (el, visible) => { if (el) el.classList.toggle('hidden', !visible); };
        set(els.startScreen, name === 'start');
        set(els.pauseScreen, name === 'pause');
        set(els.resultScreen, name === 'result');

        const container = document.getElementById('gameContainer');
        if (container) container.classList.toggle('in-game', name === 'none');
    }

    showResult(victory, stats) {
        const els = this.els;
        if (!els.resultScreen) return;

        els.resultTitle.textContent = victory ? '胜利' : '战败';
        els.resultTitle.style.webkitTextFillColor = victory ? '#7ee787' : '#ff6b6b';
        els.resultSubtitle.textContent = victory
            ? '敌方基地已被摧毁，裂谷归于平静。'
            : '我方基地陷落，防线崩溃。';

        if (els.resultStats && stats) {
            els.resultStats.innerHTML = `
                <span>最终得分</span><b>${stats.score}</b>
                <span>击杀总数</span><b>${stats.kills}</b>
                <span>存活波次</span><b>${stats.monsterWaves || 0}</b>
                <span>小兵击杀</span><b>${stats.minionKills || 0}</b>
                <span>怪物击杀</span><b>${stats.monsterKills || 0}</b>
                <span>英雄击杀</span><b>${stats.heroKills || 0}</b>
                <span>防御塔建造</span><b>${stats.towersBuilt || 0}</b>
                <span>经济总收入</span><b>${Math.round(stats.totalEarned || 0)}</b>
            `;
        }
        this.showScreen('result');
    }

    setViewDistanceUI(value) {
        if (this.els.viewDistanceSlider) this.els.viewDistanceSlider.value = String(Math.round(value));
        if (this.els.viewDistanceValue) this.els.viewDistanceValue.textContent = String(Math.round(value));
    }

    setZoomUI(value) {
        if (this.els.zoomSlider) this.els.zoomSlider.value = String(Math.round(value));
        if (this.els.zoomValue) this.els.zoomValue.textContent = String(Math.round(value));
    }

    setFollowUI(follow) {
        if (this.els.followToggle) this.els.followToggle.checked = !!follow;
    }

    setBootNote(text, color) {
        if (!this.els.bootNote) return;
        this.els.bootNote.textContent = text;
        if (color) this.els.bootNote.style.color = color;
    }
}