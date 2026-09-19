/**
 * Main —— 应用入口与游戏循环装配
 *
 * 这里只做三件事：
 *   1. 创建并连接各系统（依赖注入，系统之间不互相 new）；
 *   2. 定义游戏循环的 update / render 两个阶段；
 *   3. 处理「开始 / 暂停 / 结算 / 重开」这些顶层状态迁移。
 *
 * 关于两个阶段的划分（这是本项目的核心循环设计）：
 *
 *   ┌── 固定步长 update(1/30s) ── 与帧率解耦，可被暂停与时间缩放影响
 *   │     World 更新实体 → Combat 结算伤害 → Economy 记账
 *   │     → Spawn 刷怪 → AI 决策 → 流场校验 → 胜负判定
 *   │
 *   └── 每帧 render(dt) ── 与显示器刷新率对齐
 *         输入采样 → 相机 → 特效 → 分块流式加载 → 视锥剔除/LOD → 绘制
 *
 *   为什么输入放在 render 阶段？
 *     固定步长一帧可能执行多次 update。若把「按键按下」这类一次性事件
 *     放在 update 里，一次按键会被处理多次（例如技能连放）。
 *     放在每帧一次的 render 阶段天然避免了这个问题。
 */

import { EventBus, EVT } from './core/EventBus.js';
import { GameLoop } from './core/GameLoop.js';
import { Terrain } from './world/Terrain.js';
import { NavGrid } from './world/NavGrid.js';
import { Pathfinder, FlowField } from './world/Pathfinder.js';
import { ChunkManager } from './world/ChunkManager.js';
import { SharedAssets } from './entities/SharedAssets.js';
import { World } from './systems/World.js';
import { EffectsSystem } from './systems/EffectsSystem.js';
import { CombatSystem } from './systems/CombatSystem.js';
import { EconomySystem } from './systems/EconomySystem.js';
import { SpawnSystem } from './systems/SpawnSystem.js';
import { MapBuilder } from './systems/MapBuilder.js';
import { CameraController } from './systems/CameraController.js';
import { InputSystem } from './systems/InputSystem.js';
import { RenderSystem } from './systems/RenderSystem.js';
import { AIController } from './ai/AIController.js';
import { AICommander } from './ai/AICommander.js';
import { HUD } from './ui/HUD.js';
import { BuildPanel } from './ui/BuildPanel.js';
import { VIEW, CAMERA, MAP, TEAM } from './config/GameConfig.js';

const STATE = {
    MENU: 'menu',
    PLAYING: 'playing',
    PAUSED: 'paused',
    ENDED: 'ended'
};

class Game {
    constructor() {
        this.state = STATE.MENU;
        this.bus = new EventBus('game');
        this.aiControllers = [];
        this.commanders = { [TEAM.PLAYER]: null, [TEAM.ENEMY]: null };
        this._flowCheckTimer = 0;
        this._mouseWorld = null;
        this._lastFrameTime = 0;
        this._buildUiTimer = 0;
        this._prevLeft = false;
        this._prevRight = false;

        this._initThree();
        this._initSystems();
        this._initUI();
        this._initLoop();
        this._bindGlobalEvents();

        // 主菜单也渲染场景作为背景，因此先把相机放到玩家基地
        this._prepareMenuScene();
    }

    /* ============================== 初始化 ============================== */

    _initThree() {
        const THREE = window.THREE;

        this.scene = new THREE.Scene();
        this.skyColor = 0x8fb8d8;
        this.scene.background = new THREE.Color(this.skyColor);
        this.fog = new THREE.Fog(this.skyColor, 120, 300);
        this.scene.fog = this.fog;

        this.camera = new THREE.PerspectiveCamera(
            CAMERA.fov,
            window.innerWidth / Math.max(1, window.innerHeight),
            CAMERA.near,
            VIEW.max + 500
        );

        const canvas = document.getElementById('gameCanvas');
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);

        this.renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: pixelRatio < 1.3,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;

        // 光照
        this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
        this.scene.add(this.ambient);

        this.hemi = new THREE.HemisphereLight(0xbdd7f5, 0x4a5a3a, 0.45);
        this.scene.add(this.hemi);

        this.sun = new THREE.DirectionalLight(0xfff2d8, 0.72);
        this.sun.position.set(60, 110, 42);
        this.sun.castShadow = true;
        this.sun.shadow.mapSize.width = 1024;
        this.sun.shadow.mapSize.height = 1024;
        this.sun.shadow.camera.near = 1;
        this.sun.shadow.camera.far = 400;
        this.sun.shadow.camera.left = -80;
        this.sun.shadow.camera.right = 80;
        this.sun.shadow.camera.top = 80;
        this.sun.shadow.camera.bottom = -80;
        this.sun.shadow.bias = -0.0006;
        this.scene.add(this.sun);
        this.scene.add(this.sun.target);
    }

    _initSystems() {
        const THREE = window.THREE;

        // --- 世界数据层 ---
        this.terrain = new Terrain();
        this.nav = new NavGrid(this.terrain);
        this.pathfinder = new Pathfinder(this.nav, 6000);
        this.flowField = new FlowField();

        // 流场只需覆盖「裂隙到基地」的范围，限定规模
        const bounds = Terrain.boundsOf(
            [MAP.playerBase, ...MAP.rifts],
            MAP.flowPaddingTiles
        );
        this.flowField.configure(bounds);

        // --- 共享资源 ---
        this.shared = new SharedAssets();

        // --- 实体容器 ---
        this.world = new World({
            scene: this.scene,
            terrain: this.terrain,
            nav: this.nav,
            pathfinder: this.pathfinder,
            flowField: this.flowField,
            bus: this.bus
        });

        // --- 表现层 ---
        this.effects = new EffectsSystem({ scene: this.scene, shared: this.shared });

        // --- 经济 ---
        this.economy = new EconomySystem({ bus: this.bus });

        // --- 全局上下文：实体通过它访问系统，但不持有具体实现 ---
        this.ctx = {
            scene: this.scene,
            terrain: this.terrain,
            nav: this.nav,
            pathfinder: this.pathfinder,
            flowField: this.flowField,
            world: this.world,
            shared: this.shared,
            bus: this.bus,
            rng: Math.random
        };

        // --- 战斗（依赖 ctx 中的多数模块） ---
        this.combat = new CombatSystem({
            scene: this.scene,
            world: this.world,
            shared: this.shared,
            bus: this.bus,
            effects: this.effects,
            economy: this.economy,
            terrain: this.terrain
        });
        this.ctx.combat = this.combat;
        this.ctx.effects = this.effects;
        this.ctx.economy = this.economy;

        // --- 地图与生成 ---
        this.mapBuilder = new MapBuilder(this.ctx);
        this.spawnSystem = new SpawnSystem(this.ctx);

        // --- 分块与渲染 ---
        this.chunkManager = new ChunkManager(this.scene, this.terrain);
        this.cameraController = new CameraController({
            camera: this.camera,
            terrain: this.terrain,
            effects: this.effects
        });
        this.cameraController.setViewDistance(VIEW.default);

        this.renderSystem = new RenderSystem({
            scene: this.scene,
            camera: this.camera,
            chunkManager: this.chunkManager,
            world: this.world,
            cameraController: this.cameraController,
            sun: this.sun,
            fog: this.fog
        });
        this.renderSystem.setRenderer(this.renderer);
        this.renderSystem.setViewDistance(VIEW.default);
        this.renderSystem.applyCameraFar();
        this.renderSystem.applyFog(this.skyColor);

        // --- 输入 ---
        this.input = new InputSystem({ element: document.getElementById('gameCanvas') });

        // --- AI 指挥官 ---
        this.commanders[TEAM.PLAYER] = new AICommander({ team: TEAM.PLAYER, world: this.world, bus: this.bus });
        this.commanders[TEAM.ENEMY] = new AICommander({ team: TEAM.ENEMY, world: this.world, bus: this.bus });
    }

    _initUI() {
        this.hud = new HUD({
            bus: this.bus,
            world: this.world,
            economy: this.economy,
            spawnSystem: this.spawnSystem,
            cameraController: this.cameraController,
            enemyCommander: this.commanders[TEAM.ENEMY],
            callbacks: {
                onStart: (heroId) => this.startGame(heroId),
                onResume: () => this.resumeGame(),
                onRestart: () => this.restart(),
                onQuit: () => this.quitToMenu(),
                onUpgrade: (key) => this.buyUpgrade(key),
                onAbilityClick: (index) => this.castPlayerAbility(index),
                onViewDistanceChange: (v) => this.setViewDistance(v),
                onZoomChange: (v) => this.setZoom(v),
                onQualityChange: (name) => this.setQuality(name),
                onFollowChange: (follow) => this.setFollow(follow),
                onMinimapClick: (x, z) => this.jumpCamera(x, z)
            }
        });

        this.buildPanel = new BuildPanel({
            gameCtx: this.ctx,
            scene: this.scene,
            shared: this.shared,
            world: this.world,
            terrain: this.terrain,
            nav: this.nav,
            economy: this.economy,
            bus: this.bus,
            hud: this.hud
        });

        this.hud.buildMinimapTerrain(this.terrain);
        this.hud.showScreen('start');
    }

    _initLoop() {
        this.loop = new GameLoop({
            update: (dt) => this._update(dt),
            render: (dt) => this._render(dt),
            fixedStep: 1 / 30,
            maxSubSteps: 5,
            onStats: (stats) => this._reportStats(stats),
            onFatal: (err) => this._onFatal(err)
        });
        this.loop.start();
    }

    _bindGlobalEvents() {
        window.addEventListener('resize', () => this._onResize());

        this.bus.on(EVT.ENTITY_DIED, (payload) => {
            const entity = payload ? payload.entity : null;
            if (!entity || !entity.isBase) return;
            if (entity.team === TEAM.ENEMY) this.endGame(true, '敌方基地被摧毁');
            else if (entity.team === TEAM.PLAYER) this.endGame(false, '我方基地被摧毁');
        });

        window.addEventListener('beforeunload', () => {
            this.loop.stop();
            this.input.dispose();
        });
    }

    /* ============================== 状态迁移 ============================== */

    _prepareMenuScene() {
        // 让菜单背景对准玩家基地
        const base = MAP.playerBase;
        this.cameraController.target.set(base.x, this.terrain.heightAt(base.x, base.z), base.z);
        this.cameraController.follow = false;
        this.hud.setViewDistanceUI(VIEW.default);
        this.hud.setZoomUI(CAMERA.zoom);
    }

    startGame(heroId) {
        this.hud.showScreen('none');
        this.state = STATE.PLAYING;
        this.loop.setPaused(false);

        this._buildWorld(heroId || 'blade');

        this.combat.setActive(true);
        this.spawnSystem.setEnabled(true);
        this.hud.bindHero(this.mapBuilder.playerHero);
        this.hud.setFollowUI(true);

        this.bus.emit(EVT.GAME_START, { heroId });
        this.hud.toast('守住基地，同时寻找机会摧毁红方基地！', 'warning');
    }

    _buildWorld(heroId) {
        // 清理旧世界
        this.world.reset();
        this.nav.clearDynamic();
        this.combat.reset();
        this.effects.reset();
        this.economy.reset();
        this.spawnSystem.reset();
        this.flowField.clear();
        this.aiControllers.length = 0;
        for (const key of Object.keys(this.commanders)) {
            if (this.commanders[key]) this.commanders[key].controllers.length = 0;
        }

        // 构建静态世界
        const built = this.mapBuilder.build(heroId);
        this.spawnSystem.setSources(built.rifts, built.camps);
        this.spawnSystem.populateCamps();

        // 为每个非玩家英雄创建 AI 大脑
        for (const hero of built.heroes) {
            if (hero.isPlayer) continue;
            const controller = new AIController({
                hero,
                world: this.world,
                ctx: this.ctx,
                bus: this.bus,
                profileId: hero.aiProfile || 'defensive',
                laneId: hero.laneId || 'mid'
            });
            this.aiControllers.push(controller);
            const commander = this.commanders[hero.team];
            if (commander) commander.register(controller);
        }

        // 相机跟随玩家英雄
        const player = built.playerHero;
        if (player) {
            this.cameraController.followTarget = player;
            this.cameraController.centerOn(player);
            this.hud.setFollowUI(true);
        }

        this.buildPanel.reset();
        this._refreshFlowField(true);
    }

    pauseGame() {
        if (this.state !== STATE.PLAYING) return;
        this.state = STATE.PAUSED;
        this.loop.setPaused(true);
        this.input.reset();
        this.hud.showScreen('pause');
    }

    resumeGame() {
        if (this.state !== STATE.PAUSED) return;
        this.state = STATE.PLAYING;
        this.loop.setPaused(false);
        this.hud.showScreen('none');
    }

    endGame(victory, reason) {
        if (this.state === STATE.ENDED) return;
        this.state = STATE.ENDED;
        this.combat.setActive(false);
        this.spawnSystem.setEnabled(false);
        this.input.reset();

        const snapshot = this.economy.snapshot();
        snapshot.monsterWaves = this.spawnSystem.monsterWave;
        snapshot.totalEarned = this.economy.totalEarned[TEAM.PLAYER] || 0;

        this.hud.showResult(victory, snapshot);
        this.hud.toast(reason, victory ? 'success' : 'danger');
        this.bus.emit(victory ? EVT.GAME_VICTORY : EVT.GAME_DEFEAT, { reason });
    }

    restart() {
        this.hud.showScreen('none');
        this.startGame(this.hud.selectedHeroId || 'blade');
    }

    quitToMenu() {
        this.state = STATE.MENU;
        this.loop.setPaused(false);
        this.combat.setActive(false);
        this.spawnSystem.setEnabled(false);
        this.world.reset();
        this.nav.clearDynamic();
        this.combat.reset();
        this.effects.reset();
        this.spawnSystem.reset();
        this.flowField.clear();
        this.aiControllers.length = 0;
        this.hud.showScreen('start');
        this._prepareMenuScene();
    }

    _onFatal(err) {
        console.error('[Main] 游戏循环因连续异常停止', err);
        this.hud.toast('运行出现异常，已停止循环。请刷新页面。', 'danger');
    }

    /* ============================== 玩家操作 ============================== */

    buyUpgrade(key) {
        const hero = this.mapBuilder.playerHero;
        if (!hero) return;

        const info = hero.applyUpgrade(key);
        if (!info.ok) {
            this.hud.toast(info.reason || '无法升级', 'warning');
            return;
        }
        if (!this.economy.spend(info.cost)) {
            this.hud.toast('金币不足', 'danger');
            return;
        }
        hero.commitUpgrade(key);
        this.hud.toast(`${info.def.name} 提升至 ${hero.upgrades[key]} 级`, 'success');
        this.hud.refreshUpgrades();
    }

    castPlayerAbility(index) {
        const hero = this.mapBuilder.playerHero;
        if (!hero || !hero.alive) return;
        if (this.state !== STATE.PLAYING) return;

        const point = this._mouseWorld || { x: hero.position.x, z: hero.position.z };
        const ok = hero.castAbility(index, point.x, point.z);
        if (!ok) {
            const slot = hero.abilities[index];
            if (slot && slot.remaining > 0) this.hud.toast('技能冷却中', 'warning');
        }
    }

    setViewDistance(value) {
        this.cameraController.setViewDistance(value);
        this.renderSystem.setViewDistance(this.cameraController.viewDistance);
        this.renderSystem.applyFog(this.skyColor);
        this.renderSystem.applyCameraFar();
    }

    setZoom(value) {
        this.cameraController.zoom = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom, value));
    }

    setQuality(name) {
        this.renderSystem.setQuality(name);
        this.hud.toast(`画质已切换，正在重建地图分块…`, 'info');
    }

    setFollow(follow) {
        this.cameraController.follow = !!follow;
        if (follow && this.mapBuilder.playerHero) {
            this.cameraController.centerOn(this.mapBuilder.playerHero);
        }
    }

    jumpCamera(x, z) {
        this.cameraController.follow = false;
        this.cameraController.target.x = x;
        this.cameraController.target.z = z;
        this.hud.setFollowUI(false);
    }

    /* ============================== 循环：逻辑 ============================== */

    _update(dt) {
        if (this.state !== STATE.PLAYING) return;

        try {
            this.world.update(dt);
            this.combat.update(dt);
            this.economy.update(dt);
            this.spawnSystem.update(dt);

            for (let i = 0; i < this.aiControllers.length; i++) {
                this.aiControllers[i].update(dt);
            }
            this.commanders[TEAM.PLAYER].update(dt);
            this.commanders[TEAM.ENEMY].update(dt);

            // 流场校验（带节流，仅当导航网格变化时才真正重算）
            this._flowCheckTimer -= dt;
            if (this._flowCheckTimer <= 0) {
                this._flowCheckTimer = 0.5;
                this._refreshFlowField(false);
            }
        } catch (err) {
            console.error('[Main] 逻辑更新异常', err);
        }
    }

    _refreshFlowField(force) {
        const base = this.world.baseFor(TEAM.PLAYER);
        if (!base) return;
        const tx = Math.floor(base.position.x / 2);
        const tz = Math.floor(base.position.z / 2);
        if (force) this.flowField.clear();
        this.flowField.ensure(this.nav, tx, tz);
    }

    /* ============================== 循环：渲染 ============================== */

    _render(dt) {
        const now = performance.now();
        const frameDt = this._lastFrameTime > 0
            ? Math.min(0.1, (now - this._lastFrameTime) / 1000)
            : dt || 1 / 60;
        this._lastFrameTime = now;

        try {
            this._handleInput(frameDt);

            // 相机
            if (this.state === STATE.MENU) {
                // 主菜单：缓慢环绕，作为动态背景
                this.cameraController.follow = false;
                this.cameraController.yaw += frameDt * 0.06;
            }
            this.cameraController.update(frameDt, this.state === STATE.PLAYING ? this.input : null);

            this.camera.updateMatrixWorld(true);
            this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();

            // 鼠标地面点（供建造预览与施法瞄准复用，每帧只算一次）
            if (this.state === STATE.PLAYING) {
                this._mouseWorld = this.cameraController.groundPointSafe(
                    this.input.mouse.ndcX,
                    this.input.mouse.ndcY
                );
            }

            // 特效与视觉同步
            this.effects.update(frameDt);
            this.world.syncMeshes();
            this._updateBillboards();

            // 建造预览
            if (this.state === STATE.PLAYING) {
                this.buildPanel.update(this._mouseWorld, this.mapBuilder.playerHero);
            } else {
                this.buildPanel.hideGhost();
            }

            // 分块流式加载（先加载，再做剔除，否则新分块会晚一帧才可见）
            const camPos = this.camera.position;
            this.chunkManager.update(camPos.x, camPos.z, this.cameraController.viewDistance);

            // 视锥剔除 + LOD
            this.renderSystem.update();

            // UI
            this.hud.update(frameDt);

            // 建造面板的经济刷新按 5Hz 节流，避免每帧写 DOM
            this._buildUiTimer -= frameDt;
            if (this._buildUiTimer <= 0) {
                this._buildUiTimer = 0.2;
                this.buildPanel.updateEconomyUI();
            }

            this.renderer.render(this.scene, this.camera);
        } catch (err) {
            console.error('[Main] 渲染帧异常', err);
        } finally {
            this.input.endFrame();
        }
    }

    _updateBillboards() {
        const cam = this.camera;
        for (const e of this.world.all) {
            if (e && e.healthBar) e.billboardHealthBar(cam);
        }
    }

    /* ============================== 输入处理 ============================== */

    _handleInput(dt) {
        const input = this.input;
        const hero = this.mapBuilder ? this.mapBuilder.playerHero : null;

        // 暂停状态：只监听继续
        if (this.state === STATE.PAUSED) {
            if (input.wasPressed('Escape')) this.resumeGame();
            return;
        }

        if (this.state !== STATE.PLAYING) return;

        /* ---- 镜头 ---- */
        const drag = input.consumeDrag();
        if (drag.x !== 0 || drag.y !== 0) this.cameraController.rotate(drag.x, drag.y);

        const wheel = input.consumeWheel();
        if (wheel !== 0) {
            this.cameraController.setZoom(-wheel * 0.0012);
            this.hud.setZoomUI(this.cameraController.zoom);
        }

        if (input.wasPressed('Space') && hero) {
            this.cameraController.centerOn(hero);
            this.hud.setFollowUI(true);
        }
        if (input.wasPressed('KeyF')) {
            this.setFollow(!this.cameraController.follow);
        }
        if (input.anyPressed(['Digit1', 'Digit2', 'Digit3', 'Digit4']) && hero) {
            // 数字键快速切换镜头到各 AI 队友？保持简单：聚焦自身
            this.cameraController.centerOn(hero);
        }

        /* ---- 技能 ---- */
        if (input.wasPressed('KeyQ')) this.castPlayerAbility(0);
        if (input.wasPressed('KeyW')) this.castPlayerAbility(1);
        if (input.wasPressed('KeyE')) this.castPlayerAbility(2);
        if (input.wasPressed('KeyR')) this.castPlayerAbility(3);

        /* ---- 建造 ---- */
        if (input.wasPressed('KeyB')) this.buildPanel.toggleBuildMode();
        if (input.wasPressed('KeyZ')) this.buildPanel.selectType('arrow');
        if (input.wasPressed('KeyX')) this.buildPanel.selectType('cannon');
        if (input.wasPressed('KeyC')) this.buildPanel.selectType('frost');

        if (input.wasPressed('Escape')) {
            if (this.buildPanel.cancel()) return;
            this.pauseGame();
            return;
        }

        /* ---- 鼠标左键：建造 / 选中 ---- */
        if (this._clickEdge('left')) this._onLeftClick(hero);

        /* ---- 鼠标右键：移动 / 指定攻击目标 ---- */
        if (this._clickEdge('right')) this._onRightClick(hero);
    }

    /**
     * 鼠标按键的「按下沿」检测。
     * 用边沿而不是「当前是否按住」，否则按住左键会每帧重复建造/选中。
     */
    _clickEdge(button) {
        const nowDown = button === 'left' ? this.input.mouse.left : this.input.mouse.right;
        const prevKey = button === 'left' ? '_prevLeft' : '_prevRight';
        const prev = this[prevKey] || false;

        if (nowDown && !prev) {
            this[prevKey] = true;
            return true;
        }
        if (!nowDown) this[prevKey] = false;
        return false;
    }

    _onLeftClick(hero) {
        if (this.buildPanel.active) {
            if (this._mouseWorld) {
                this.buildPanel.place(this._mouseWorld.x, this._mouseWorld.z, hero);
            }
            return;
        }
        if (this._mouseWorld) {
            const tower = this.buildPanel.pickTowerAt(this._mouseWorld.x, this._mouseWorld.z);
            this.buildPanel.selectTower(tower); // 传 null 即取消选中
        }
    }

    _onRightClick(hero) {
        if (!hero || !hero.alive) return;
        if (this.buildPanel.active) {
            this.buildPanel.cancel();
            return;
        }

        const point = this._mouseWorld;
        if (!point) return;

        // 右键点到敌人身上则强制攻击，否则作为移动指令
        const target = this._pickEnemyAt(point.x, point.z, 3.2);
        if (target) {
            hero.forcedTarget = target;
            const d = Math.hypot(target.position.x - hero.position.x, target.position.z - hero.position.z);
            if (d > hero.attackRange * 0.9) hero.setDestination(target.position.x, target.position.z, this.pathfinder);
            else hero.clearDestination();
        } else {
            hero.forcedTarget = null;
            hero.setDestination(point.x, point.z, this.pathfinder);
        }
    }

    _pickEnemyAt(x, z, radius) {
        const hero = this.mapBuilder.playerHero;
        if (!hero) return null;

        let best = null;
        let bestDist = Infinity;
        const candidates = this.world.queryEnemiesNear(x, z, radius, hero.team, { includeStructures: true });
        for (const e of candidates) {
            if (!e || !e.alive) continue;
            const d = Math.hypot(e.position.x - x, e.position.z - z);
            if (d < bestDist) {
                bestDist = d;
                best = e;
            }
        }
        return best;
    }

    /* ============================== 统计与杂项 ============================== */

    _reportStats(loopStats) {
        if (!this.renderSystem || !this.world) return;

        const info = this.renderer.info.render;
        this.hud.updatePerf({
            fps: loopStats.fps,
            updateMs: loopStats.updateMs,
            renderMs: loopStats.renderMs,
            chunksVisible: this.renderSystem.stats.chunksVisible,
            chunksLoaded: this.chunkManager.chunks.size,
            chunksCulled: this.renderSystem.stats.chunksCulled,
            chunksFrustum: this.renderSystem.stats.chunksFrustum,
            drawCalls: info.calls,
            triangles: info.triangles,
            entities: this.world.all.length,
            projectiles: this.combat.activeProjectiles.length,
            materials: this.shared.stats().materials
        });
    }

    _onResize() {
        const w = window.innerWidth;
        const h = Math.max(1, window.innerHeight);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }
}

/* ============================== 启动 ============================== */

window.addEventListener('load', () => {
    try {
        window._game = new Game();
    } catch (err) {
        console.error('[Main] 初始化失败', err);
        const note = document.getElementById('bootNote');
        if (note) {
            note.textContent = `初始化失败：${err && err.message ? err.message : err}`;
            note.style.color = '#ff7b7b';
        }
    }
});

export { Game, STATE };