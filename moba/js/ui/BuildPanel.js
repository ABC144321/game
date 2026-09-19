/**
 * BuildPanel —— 塔防建造界面 + 放置逻辑
 *
 * 「建造」这个动作跨越了 UI、经济、导航、渲染四个关注点，
 * 如果散落在各处很容易出现「扣了钱没建出来」这类不一致。
 * 因此这里把「校验 → 扣费 → 生成实体 → 占用导航 → 发事件」收成一条链路，
 * 任何一步失败都在扣费之前被拦截。
 */

import { DEFENSE_TOWERS, BUILD, TEAM, ECONOMY } from '../config/GameConfig.js';
import { DefenseTower } from '../entities/Structures.js';
import { EVT } from '../core/EventBus.js';

/** 玩家建造的防御塔距离英雄的最大距离（避免全图乱放） */
const MAX_BUILD_RANGE = 46;

export class BuildPanel {
    constructor(ctx = {}) {
        this.ctx = ctx.gameCtx || ctx;
        this.bus = ctx.bus;
        this.scene = ctx.scene;
        this.shared = ctx.shared;
        this.world = ctx.world;
        this.terrain = ctx.terrain;
        this.nav = ctx.nav;
        this.economy = ctx.economy;
        this.hud = ctx.hud;

        this.active = false;
        this.selectedType = null;
        this.ghost = null;
        this.ghostValid = false;
        this.selectedTower = null;

        this.els = {
            buildHint: document.getElementById('buildHint'),
            towerOptions: document.getElementById('towerOptions'),
            selectedTower: document.getElementById('selectedTower'),
            selTitle: document.getElementById('selTowerTitle'),
            selStats: document.getElementById('selTowerStats'),
            upgradeBtn: document.getElementById('upgradeTowerBtn'),
            sellBtn: document.getElementById('sellTowerBtn')
        };

        this._buildOptionButtons();
        this._bindButtons();
    }

    /* ------------------------------ 界面 ------------------------------ */

    _buildOptionButtons() {
        const box = this.els.towerOptions;
        if (!box) return;
        box.innerHTML = '';

        this._optionButtons = {};

        Object.values(DEFENSE_TOWERS).forEach((cfg) => {
            const btn = document.createElement('button');
            btn.className = 'tower-option';
            btn.dataset.tower = cfg.id;
            btn.innerHTML = `
                <span class="tower-dot" style="background:#${cfg.color.toString(16).padStart(6, '0')}"></span>
                <span class="tower-meta">
                    <span class="tower-name">${cfg.name}</span>
                    <span class="tower-cost">${cfg.cost} 金币</span>
                </span>
                <span class="tower-hotkey">${cfg.hotkey}</span>
            `;
            btn.title = cfg.desc;
            btn.addEventListener('click', () => this.selectType(cfg.id));
            box.appendChild(btn);
            this._optionButtons[cfg.id] = btn;
        });
    }

    _bindButtons() {
        if (this.els.upgradeBtn) {
            this.els.upgradeBtn.addEventListener('click', () => this.upgradeSelected());
        }
        if (this.els.sellBtn) {
            this.els.sellBtn.addEventListener('click', () => this.sellSelected());
        }
    }

    /* ------------------------------ 模式切换 ------------------------------ */

    selectType(typeId) {
        if (!DEFENSE_TOWERS[typeId]) return;
        this.selectedType = typeId;
        this.active = true;
        this._refreshOptionButtons();
        this._ensureGhost();
        this._updateHint();
    }

    toggleBuildMode(force) {
        const next = force === undefined ? !this.active : !!force;
        this.active = next;

        if (next && !this.selectedType) this.selectedType = 'arrow';
        if (!next) {
            this.hideGhost();
            this.selectedType = null;
        } else {
            this._ensureGhost();
        }
        this._refreshOptionButtons();
        this._updateHint();
    }

    cancel() {
        if (this.active) {
            this.toggleBuildMode(false);
            return true;
        }
        if (this.selectedTower) {
            this.clearSelection();
            return true;
        }
        return false;
    }

    _updateHint() {
        if (!this.els.buildHint) return;
        if (this.active && this.selectedType) {
            const cfg = DEFENSE_TOWERS[this.selectedType];
            this.els.buildHint.textContent = `放置 ${cfg.name}（左键）/ Esc 取消`;
        } else {
            this.els.buildHint.textContent = 'B 进入建造';
        }
    }

    _refreshOptionButtons() {
        if (!this._optionButtons) return;
        const gold = this.economy ? this.economy.playerGold : 0;
        for (const [id, btn] of Object.entries(this._optionButtons)) {
            const cfg = DEFENSE_TOWERS[id];
            btn.classList.toggle('active', this.active && this.selectedType === id);
            btn.disabled = gold < cfg.cost;
        }
    }

    /* ------------------------------ 幽灵预览 ------------------------------ */

    _ensureGhost() {
        if (this.ghost || !this.scene || !this.shared) return;
        const THREE = window.THREE;

        const group = new THREE.Group();

        const pad = new THREE.Mesh(this.shared.geo('cylinder'), this.shared.buildValid);
        pad.scale.set(1.6, 0.14, 1.6);
        pad.position.y = 0.1;
        group.add(pad);

        const range = new THREE.Mesh(this.shared.geo('ring'), this.shared.buildValid);
        range.rotation.x = -Math.PI / 2;
        range.scale.setScalar(15);
        range.position.y = 0.16;
        group.add(range);

        group.visible = false;
        this.scene.add(group);

        this.ghost = group;
        this.ghostPad = pad;
        this.ghostRange = range;
    }

    hideGhost() {
        if (this.ghost) this.ghost.visible = false;
    }

    /** 每帧更新幽灵位置与合法性 */
    update(mouseWorld, playerHero) {
        if (!this.active || !this.ghost || !this.selectedType) {
            this.hideGhost();
            return;
        }
        if (!mouseWorld) {
            this.hideGhost();
            return;
        }

        const cfg = DEFENSE_TOWERS[this.selectedType];
        const result = this.validate(mouseWorld.x, mouseWorld.z, this.selectedType, playerHero);

        this.ghostValid = result.ok;
        this.ghost.visible = true;

        const groundY = this.terrain ? this.terrain.heightAt(mouseWorld.x, mouseWorld.z) : 0;
        this.ghost.position.set(mouseWorld.x, groundY, mouseWorld.z);

        const mat = result.ok ? this.shared.buildValid : this.shared.buildInvalid;
        if (this.ghostPad) this.ghostPad.material = mat;
        if (this.ghostRange) {
            this.ghostRange.material = mat;
            this.ghostRange.scale.setScalar(cfg.tiers[0].attackRange);
        }
    }

    /* ------------------------------ 合法性校验 ------------------------------ */

    /**
     * @returns {{ok:boolean, reason:string}}
     */
    validate(x, z, typeId, playerHero) {
        const cfg = DEFENSE_TOWERS[typeId];
        if (!cfg) return { ok: false, reason: '未知塔类型' };

        if (!this.economy || this.economy.playerGold < cfg.cost) {
            return { ok: false, reason: '金币不足' };
        }

        let count = 0;
        for (const s of this.world.structures) {
            if (s && s.isDefenseTower && s.alive) count++;
        }
        if (count >= BUILD.maxTowers) {
            return { ok: false, reason: `防御塔数量已达上限（${BUILD.maxTowers}）` };
        }

        if (playerHero && playerHero.alive) {
            const d = Math.hypot(playerHero.position.x - x, playerHero.position.z - z);
            if (d > MAX_BUILD_RANGE) return { ok: false, reason: '距离英雄太远' };
        }

        // 地形必须可行走
        const tx = Math.floor(x / 2);
        const tz = Math.floor(z / 2);
        if (!this.nav || !this.nav.isTerrainWalkable(tx, tz)) {
            return { ok: false, reason: '地形不可建造' };
        }

        // 不能压在其他建筑上
        for (const s of this.world.structures) {
            if (!s || !s.alive) continue;
            const d = Math.hypot(s.position.x - x, s.position.z - z);
            const minDist = s.radius + 2.2;
            if (d < minDist) return { ok: false, reason: '与已有建筑重叠' };
        }

        // 不能压在其他单位身上
        const nearby = this.world.queryEnemiesNear(x, z, 2.4, TEAM.NEUTRAL, { includeStructures: false });
        if (nearby.length > 0) return { ok: false, reason: '附近有单位挡位' };

        return { ok: true, reason: '' };
    }

    /* ------------------------------ 放置 ------------------------------ */

    /**
     * 尝试在指定位置建造。
     * @returns {{ok:boolean, reason?:string}}
     */
    place(x, z, playerHero) {
        if (!this.active || !this.selectedType) return { ok: false, reason: '未进入建造模式' };

        const cfg = DEFENSE_TOWERS[this.selectedType];
        const check = this.validate(x, z, this.selectedType, playerHero);
        if (!check.ok) {
            if (this.hud) this.hud.toast(`无法建造：${check.reason}`, 'warning');
            return check;
        }

        // 先扣费，扣费失败则中止（保证「钱与塔」始终一致）
        if (!this.economy.spend(cfg.cost)) {
            if (this.hud) this.hud.toast('金币不足', 'danger');
            return { ok: false, reason: '金币不足' };
        }

        const tower = this._createTower(this.selectedType, x, z);
        if (!tower) {
            this.economy.refund(cfg.cost); // 创建失败立即退款，绝不让玩家白花钱
            return { ok: false, reason: '创建失败' };
        }

        this.economy.stats.towersBuilt++;
        this.economy.emit();

        if (this.bus) {
            this.bus.emit(EVT.TOWER_BUILT, { tower, type: this.selectedType, cost: cfg.cost });
        }
        if (this.hud) this.hud.toast(`建造 ${cfg.name} -${cfg.cost} 金`, 'success');

        // 默认保持建造模式以便连续放置，但金币不足时自动退出
        this._refreshOptionButtons();
        return { ok: true, tower };
    }

    _createTower(typeId, x, z) {
        try {
            const cfg = DEFENSE_TOWERS[typeId];
            const tower = new DefenseTower({
                ctx: this.ctx,
                team: TEAM.PLAYER,
                x,
                z,
                towerId: typeId,
                investedGold: cfg.cost
            });

            const mesh = DefenseTower.buildMesh(this.shared, typeId, tower.tier);
            tower.mesh = mesh;
            tower.turret = mesh.userData ? mesh.userData.turret : null;
            tower.groundY = this.terrain ? this.terrain.heightAt(x, z) : 0;
            tower.position.y = tower.groundY;
            tower.syncMesh();
            tower.occupy();
            tower.attachHealthBar(this.shared, { width: 1.8, y: 3.4 });

            this.world.add(tower);
            return tower;
        } catch (err) {
            console.error('[BuildPanel] 创建防御塔失败', err);
            return null;
        }
    }

    /* ------------------------------ 选中/升级/出售 ------------------------------ */

    /** 拾取鼠标下最近的防御塔 */
    pickTowerAt(x, z, radius = 3.2) {
        let best = null;
        let bestDist = Infinity;
        for (const s of this.world.structures) {
            if (!s || !s.alive || !s.isDefenseTower) continue;
            const d = Math.hypot(s.position.x - x, s.position.z - z);
            if (d < radius + s.radius && d < bestDist) {
                bestDist = d;
                best = s;
            }
        }
        return best;
    }

    selectTower(tower) {
        this.selectedTower = tower;
        this._refreshSelectedPanel();
    }

    clearSelection() {
        this.selectedTower = null;
        this._refreshSelectedPanel();
    }

    _refreshSelectedPanel() {
        const panel = this.els.selectedTower;
        if (!panel) return;

        const tower = this.selectedTower;
        if (!tower || !tower.alive) {
            panel.classList.add('hidden');
            this.selectedTower = null;
            return;
        }

        panel.classList.remove('hidden');
        if (this.els.selTitle) {
            this.els.selTitle.textContent = `${tower.config.name} · ${tower.tier} 级`;
        }
        if (this.els.selStats) {
            const t = tower.tierStats;
            this.els.selStats.textContent =
                `伤害 ${t.damage}   射程 ${t.attackRange}\n` +
                `攻速 ${(1 / t.attackInterval).toFixed(2)}/s   生命 ${Math.ceil(tower.hp)}/${tower.maxHp}` +
                (tower.splash ? `\n溅射半径 ${tower.splash}` : '') +
                (tower.slow ? `\n减速 ${Math.round(tower.slow * 100)}%` : '');
        }

        const economy = this.economy;
        const gold = economy ? economy.playerGold : 0;
        if (this.els.upgradeBtn) {
            const canUp = tower.canUpgrade;
            const cost = tower.upgradeCost;
            this.els.upgradeBtn.textContent = canUp ? `升级 (${cost} 金)` : '已满级';
            this.els.upgradeBtn.disabled = !canUp || gold < cost;
        }
        if (this.els.sellBtn) {
            this.els.sellBtn.textContent = `出售 (+${tower.sellValue} 金)`;
        }
    }

    upgradeSelected() {
        const tower = this.selectedTower;
        if (!tower || !tower.alive || !tower.canUpgrade) return false;

        const cost = tower.upgradeCost;
        if (!this.economy.spend(cost)) {
            if (this.hud) this.hud.toast('金币不足', 'danger');
            return false;
        }

        tower.upgrade();
        tower.investedGold += cost;

        // 重建模型以体现等级变化
        this._rebuildTowerMesh(tower);
        tower.updateHealthBar();
        tower.hp = Math.max(tower.hp, tower.maxHp * 0.4);

        if (this.bus) this.bus.emit(EVT.TOWER_UPGRADED, { tower });
        if (this.hud) this.hud.toast(`升级为 ${tower.tier} 级 -${cost} 金`, 'success');
        this._refreshSelectedPanel();
        return true;
    }

    sellSelected() {
        const tower = this.selectedTower;
        if (!tower || !tower.alive) return false;

        const refund = tower.sellValue;
        tower.release();               // 释放导航占用，怪物路线会随之更新
        this.world.destroy(tower);
        this.economy.refund(refund);

        if (this.bus) this.bus.emit(EVT.TOWER_SOLD, { tower, refund });
        if (this.hud) this.hud.toast(`出售获得 +${refund} 金`, 'info');

        this.clearSelection();
        return true;
    }

    _rebuildTowerMesh(tower) {
        if (!tower.mesh || !tower.mesh.parent) return;
        const parent = tower.mesh.parent;
        parent.remove(tower.mesh);

        const mesh = DefenseTower.buildMesh(this.shared, tower.towerId, tower.tier);
        tower.mesh = mesh;
        tower.turret = mesh.userData ? mesh.userData.turret : null;
        tower.attachHealthBar(this.shared, { width: 1.8, y: 3.4 + (tower.tier - 1) * 0.16 });
        tower.syncMesh();
        parent.add(mesh);
    }

    /* ------------------------------ 每帧 ------------------------------ */

    updateEconomyUI() {
        this._refreshOptionButtons();
        if (this.selectedTower) this._refreshSelectedPanel();
    }

    reset() {
        this.active = false;
        this.selectedType = null;
        this.selectedTower = null;
        this.hideGhost();
        this._refreshOptionButtons();
        this._refreshSelectedPanel();
        this._updateHint();
    }
}