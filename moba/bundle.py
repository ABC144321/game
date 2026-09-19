#!/usr/bin/env python3
"""
将 moba 项目打包为单个 HTML 文件（可直接双击打开）。
- 读取所有 JS 模块，按依赖顺序拼接
- 剥离 import/export 语句（改为全局作用域）
- 嵌入 three.min.js + CSS
- 输出到 moba/single.html
"""

import os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))

# ── 依赖顺序（拓扑）─────────────────────────────────────────────
FILES = [
    'js/core/MathUtils.js',
    'js/core/EventBus.js',
    'js/core/ObjectPool.js',
    'js/core/GameLoop.js',
    'js/core/GeometryUtils.js',
    'js/config/GameConfig.js',
    'js/world/Terrain.js',
    'js/world/Chunk.js',
    'js/world/ChunkManager.js',
    'js/world/NavGrid.js',
    'js/world/Pathfinder.js',
    'js/entities/Entity.js',
    'js/entities/SharedAssets.js',
    'js/entities/Hero.js',
    'js/entities/Minion.js',
    'js/entities/Monster.js',
    'js/entities/Structures.js',
    'js/entities/Projectile.js',
    'js/systems/SpatialGrid.js',
    'js/systems/World.js',
    'js/systems/CombatSystem.js',
    'js/systems/EconomySystem.js',
    'js/systems/EffectsSystem.js',
    'js/systems/SpawnSystem.js',
    'js/systems/MapBuilder.js',
    'js/systems/CameraController.js',
    'js/systems/InputSystem.js',
    'js/systems/RenderSystem.js',
    'js/ai/Behaviors.js',
    'js/ai/AIController.js',
    'js/ai/AICommander.js',
    'js/ui/HUD.js',
    'js/ui/BuildPanel.js',
    'js/Main.js',
]

# ── 剥离 import / export ────────────────────────────────────────
IMPORT_RE = re.compile(r"^import\s+.*?from\s+['\"].*?['\"];\s*$", re.M)
EXPORT_CLASS_RE = re.compile(r'^export\s+class\s+', re.M)
EXPORT_FUNCTION_RE = re.compile(r'^export\s+function\s+', re.M)
EXPORT_CONST_RE = re.compile(r'^export\s+const\s+', re.M)
EXPORT_LET_RE = re.compile(r'^export\s+let\s+', re.M)
EXPORT_VAR_RE = re.compile(r'^export\s+var\s+', re.M)
EXPORT_BRACE_RE = re.compile(r'^export\s+\{', re.M)
EXPORT_DEFAULT_RE = re.compile(r'^export\s+default\s+', re.M)

def strip_exports(src):
    src = EXPORT_CLASS_RE.sub('class ', src)
    src = EXPORT_FUNCTION_RE.sub('function ', src)
    src = EXPORT_CONST_RE.sub('const ', src)
    src = EXPORT_LET_RE.sub('let ', src)
    src = EXPORT_VAR_RE.sub('var ', src)
    src = EXPORT_BRACE_RE.sub('{ ', src)
    src = EXPORT_DEFAULT_RE.sub('', src)
    return src

def process_file(rel_path):
    full = os.path.join(ROOT, rel_path)
    with open(full, 'r', encoding='utf-8') as f:
        src = f.read()
    src = IMPORT_RE.sub('', src)
    src = strip_exports(src)
    # 在每段代码前加注释标记，便于调试
    src = f"\n// ═══ {rel_path} ═══\n{src}\n"
    return src

def main():
    print("=== 打包 moba 单文件 HTML ===\n")

    # 1. 拼接所有模块
    parts = []
    for rel in FILES:
        full = os.path.join(ROOT, rel)
        if not os.path.exists(full):
            print(f"  [MISS] {rel}")
            sys.exit(1)
        parts.append(process_file(rel))
        print(f"  [OK]   {rel}")

    game_code = '\n'.join(parts)

    # 2. 读取 three.js
    three_path = os.path.join(ROOT, 'vendor', 'three.min.js')
    if not os.path.exists(three_path):
        print(f"\n[ERROR] three.min.js 不存在: {three_path}")
        sys.exit(1)
    with open(three_path, 'r', encoding='utf-8') as f:
        three_js = f.read()
    print(f"\n  three.min.js: {len(three_js):,} bytes")

    # 3. 读取 CSS
    css_path = os.path.join(ROOT, 'css', 'style.css')
    with open(css_path, 'r', encoding='utf-8') as f:
        css = f.read()

    # 4. 构建 HTML
    html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>裂谷战线 · MOBA + 塔防</title>
<style>{css}</style>
</head>
<body>
<div id="gameContainer">
    <canvas id="gameCanvas"></canvas>

    <!-- ===================== 顶部状态条 ===================== -->
    <div id="topBar">
        <div class="stat-block" id="waveBlock">
            <div class="stat-label">怪物波次</div>
            <div class="stat-value" id="waveValue">—</div>
            <div class="stat-sub" id="waveTimer">准备中</div>
        </div>
        <div class="stat-block">
            <div class="stat-label">金币</div>
            <div class="stat-value gold" id="goldValue">0</div>
        </div>
        <div class="stat-block">
            <div class="stat-label">得分</div>
            <div class="stat-value score" id="scoreValue">0</div>
        </div>
        <div class="stat-block">
            <div class="stat-label">击杀</div>
            <div class="stat-value" id="killValue">0</div>
        </div>
        <div class="stat-block wide">
            <div class="stat-label">我方基地</div>
            <div class="mini-bar"><div class="mini-fill player" id="baseHpFill"></div></div>
            <div class="stat-label enemy-base">敌方基地</div>
            <div class="mini-bar"><div class="mini-fill enemy" id="enemyBaseHpFill"></div></div>
        </div>
        <div class="stat-block">
            <div class="stat-label">敌方动向</div>
            <div class="stat-value stance" id="stanceValue">僵持</div>
        </div>
    </div>

    <!-- ===================== 小地图 ===================== -->
    <div id="minimapWrap">
        <canvas id="minimap" width="220" height="220"></canvas>
        <div class="minimap-hint">点击小地图可跳转视角</div>
    </div>

    <!-- ===================== 英雄面板 ===================== -->
    <div id="heroPanel">
        <div class="hero-head">
            <span class="hero-name" id="heroName">英雄</span>
            <span class="hero-level" id="heroLevel">Lv.1</span>
        </div>
        <div class="hero-hp-bar"><div id="heroHpFill"></div></div>
        <div class="hero-hp-text" id="heroHpText">0 / 0</div>
        <div class="hero-xp-bar"><div id="heroXpFill"></div></div>
        <div class="upgrade-list" id="upgradeList"></div>
    </div>

    <!-- ===================== 技能栏 ===================== -->
    <div id="abilityBar"></div>

    <!-- ===================== 建造面板 ===================== -->
    <div id="buildPanel">
        <div class="panel-title">
            防御塔建造
            <span class="build-hint" id="buildHint">B 进入建造</span>
        </div>
        <div class="tower-options" id="towerOptions"></div>
        <div class="selected-tower hidden" id="selectedTower">
            <div class="sel-title" id="selTowerTitle">—</div>
            <div class="sel-stats" id="selTowerStats">—</div>
            <div class="sel-actions">
                <button class="mini-btn" id="upgradeTowerBtn">升级</button>
                <button class="mini-btn danger" id="sellTowerBtn">出售</button>
            </div>
        </div>
    </div>

    <!-- ===================== 设置面板 ===================== -->
    <div id="settingsPanel">
        <div class="panel-title">画面设置</div>
        <label class="setting-row">
            <span>渲染距离</span>
            <span class="setting-value" id="viewDistanceValue">260</span>
        </label>
        <input type="range" id="viewDistanceSlider" min="120" max="520" step="10" value="260">
        <label class="setting-row">
            <span>视角距离</span>
            <span class="setting-value" id="zoomValue">78</span>
        </label>
        <input type="range" id="zoomSlider" min="28" max="190" step="2" value="78">
        <label class="setting-row">
            <span>画质档位</span>
            <select id="qualitySelect">
                <option value="low">低</option>
                <option value="medium" selected>中</option>
                <option value="high">高</option>
            </select>
        </label>
        <label class="setting-row checkbox">
            <input type="checkbox" id="perfToggle" checked>
            <span>显示性能面板</span>
        </label>
        <label class="setting-row checkbox">
            <input type="checkbox" id="followToggle" checked>
            <span>镜头跟随英雄</span>
        </label>
    </div>

    <!-- ===================== 性能面板 ===================== -->
    <div id="perfPanel">
        <div><span>FPS</span><b id="perfFps">0</b></div>
        <div><span>逻辑</span><b id="perfUpdate">0.0ms</b></div>
        <div><span>渲染</span><b id="perfRender">0.0ms</b></div>
        <div><span>分块</span><b id="perfChunks">0 / 0</b></div>
        <div><span>视锥剔除</span><b id="perfCulled">0</b></div>
        <div><span>绘制调用</span><b id="perfDraw">0</b></div>
        <div><span>三角面</span><b id="perfTris">0</b></div>
        <div><span>实体</span><b id="perfEntities">0</b></div>
        <div><span>投射物</span><b id="perfProjectiles">0</b></div>
        <div><span>材质池</span><b id="perfMaterials">0</b></div>
    </div>

    <!-- ===================== 提示 ===================== -->
    <div id="toastBox"></div>

    <!-- ===================== 开始界面 ===================== -->
    <div id="startScreen" class="overlay">
        <h1 class="title">裂谷战线</h1>
        <p class="subtitle">MOBA + 塔防 · 无限地图 · 动态分块加载</p>
        <div class="start-columns">
            <div class="start-card">
                <h3>选择英雄</h3>
                <div class="hero-picker" id="heroPicker"></div>
            </div>
            <div class="start-card">
                <h3>操作说明</h3>
                <ul class="key-list">
                    <li><b>右键</b> 移动 / 攻击目标</li>
                    <li><b>Q W E R</b> 释放技能（朝鼠标位置）</li>
                    <li><b>WASD</b> 平移镜头</li>
                    <li><b>滚轮</b> 缩放 · <b>中键拖拽</b> 旋转视角</li>
                    <li><b>空格</b> 镜头回到英雄 · <b>F</b> 切换跟随</li>
                    <li><b>Z / X / C</b> 选择要建造的防御塔</li>
                    <li><b>B</b> 进入 / 退出建造模式</li>
                    <li><b>左键</b> 放置防御塔 / 选中建筑</li>
                    <li><b>Esc</b> 取消建造 / 暂停</li>
                </ul>
            </div>
            <div class="start-card">
                <h3>玩法目标</h3>
                <ul class="key-list">
                    <li>指挥英雄摧毁 <b class="enemy-c">红方基地</b> 即可获胜</li>
                    <li>守住 <b class="player-c">蓝方基地</b>，抵挡裂隙怪物波次</li>
                    <li>用金币建造防御塔封锁怪物路线</li>
                    <li>升级英雄属性，配合 AI 队友推进兵线</li>
                </ul>
            </div>
        </div>
        <button class="primary-btn" id="startButton">开始战斗</button>
        <div class="boot-note" id="bootNote"></div>
    </div>

    <!-- ===================== 暂停界面 ===================== -->
    <div id="pauseScreen" class="overlay hidden">
        <h1 class="title small">已暂停</h1>
        <div class="pause-actions">
            <button class="primary-btn" id="resumeButton">继续战斗</button>
            <button class="primary-btn ghost" id="restartButton2">重新开始</button>
            <button class="primary-btn ghost" id="quitButton">返回主菜单</button>
        </div>
    </div>

    <!-- ===================== 结算界面 ===================== -->
    <div id="resultScreen" class="overlay hidden">
        <h1 class="title small" id="resultTitle">战斗结束</h1>
        <p class="subtitle" id="resultSubtitle"></p>
        <div class="result-stats" id="resultStats"></div>
        <div class="pause-actions">
            <button class="primary-btn" id="restartButton">再来一局</button>
            <button class="primary-btn ghost" id="quitButton2">返回主菜单</button>
        </div>
    </div>
</div>

<!-- Three.js 全局变量（file:// 模式下必须放在 game code 之前） -->
<script>{three_js}</script>
<script>
// 启动检测
(function () {{
    var note = document.getElementById('bootNote');
    if (!window.THREE) {{
        if (note) {{ note.textContent = 'three.js 未能加载。'; note.style.color = '#ff7b7b'; }}
        console.error('[Boot] three.js 未加载');
        return;
    }}
    var script = document.createElement('script');
    script.textContent = {repr(game_code)};
    document.body.appendChild(script);
}})();
</script>
</body>
</html>'''

    # 5. 写入
    out_path = os.path.join(ROOT, 'single.html')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)

    size_mb = len(html.encode('utf-8')) / 1024 / 1024
    print(f"\n=== 打包完成 ===")
    print(f"  输出: {out_path}")
    print(f"  大小: {size_mb:.1f} MB")
    print(f"  打开方式: 双击 single.html 即可游玩（无需服务器）")

if __name__ == '__main__':
    main()
