const GAME_STATE = {
    MENU: 'menu',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAME_OVER: 'gameover'
};

const WEAPONS = [
    {
        id: 1, name: '手枪', damage: 25, fireRate: 280, magSize: 12, reserveAmmo: 48,
        reloadTime: 1400, spread: 0.018, bulletSpeed: 90, bulletColor: 0xffaa00,
        auto: false, pellets: 1, recoil: 0.012
    },
    {
        id: 2, name: '冲锋枪', damage: 14, fireRate: 90, magSize: 40, reserveAmmo: 160,
        reloadTime: 1800, spread: 0.055, bulletSpeed: 75, bulletColor: 0xffff00,
        auto: true, pellets: 1, recoil: 0.01
    },
    {
        id: 3, name: '步枪', damage: 42, fireRate: 140, magSize: 30, reserveAmmo: 90,
        reloadTime: 2300, spread: 0.012, bulletSpeed: 110, bulletColor: 0x00ff00,
        auto: true, pellets: 1, recoil: 0.018
    },
    {
        id: 4, name: '霰弹枪', damage: 16, fireRate: 650, magSize: 6, reserveAmmo: 24,
        reloadTime: 2800, spread: 0.14, bulletSpeed: 65, bulletColor: 0xff6600,
        auto: false, pellets: 8, recoil: 0.032
    },
    {
        id: 5, name: '火箭筒', damage: 120, fireRate: 1400, magSize: 4, reserveAmmo: 12,
        reloadTime: 3200, spread: 0.02, bulletSpeed: 40, bulletColor: 0xff4400,
        auto: false, pellets: 1, recoil: 0.06, explosive: true, explosiveRadius: 6, explosiveDamage: 60
    }
];

const SKINS = {
    default: { primary: 0x4a5568, secondary: 0x2d3748, accent: 0x00ccff, ground: 0x3d4a5c, fog: 0x87ceeb, sky: 0x87ceeb },
    desert: { primary: 0xd4a574, secondary: 0x8b6914, accent: 0xff9933, ground: 0xc4a574, fog: 0xedd9b0, sky: 0xedd9b0 },
    forest: { primary: 0x48bb78, secondary: 0x276749, accent: 0x66ff66, ground: 0x2f5d3a, fog: 0x8fbc8f, sky: 0x7eb6d9 },
    urban: { primary: 0x718096, secondary: 0x2d3748, accent: 0x00ccff, ground: 0x4a5568, fog: 0x8899aa, sky: 0x6b7c8c }
};

class AudioFX {
    constructor() {
        this.ctx = null;
    }

    ensure() {
        if (!this.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            this.ctx = new Ctx();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
    }

    tone(freq, duration, type, gainValue, slide) {
        const ctx = this.ensure();
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        if (slide) osc.frequency.exponentialRampToValueAtTime(slide, ctx.currentTime + duration);
        gain.gain.setValueAtTime(gainValue, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
    }

    shoot(weaponId) {
        const base = weaponId === 4 ? 90 : weaponId === 2 ? 220 : weaponId === 3 ? 160 : 180;
        this.tone(base, 0.08, 'square', 0.05, base * 0.4);
        this.tone(base * 2, 0.04, 'sawtooth', 0.025, 80);
    }

    hit(headshot) {
        this.tone(headshot ? 880 : 420, 0.06, 'triangle', 0.04, headshot ? 1400 : 200);
    }

    pickup() {
        this.tone(520, 0.12, 'sine', 0.05, 880);
    }

    damage() {
        this.tone(140, 0.18, 'sawtooth', 0.06, 60);
    }

    reload() {
        this.tone(240, 0.1, 'square', 0.03, 180);
    }
}

class FPSGame {
    constructor() {
        this.state = GAME_STATE.MENU;
        this.selectedSkin = 'default';
        this.score = 0;
        this.kills = 0;
        this.wave = 1;
        this.waveEnemiesRemaining = 0;
        this.waveAdvancing = false;
        this.timers = [];
        this.audio = new AudioFX();

        this.gold = 0;
        this.combo = null;
        this.slowmoUntil = 0;
        this.skillSystem = null;
        this.towerSystem = null;

        this._tmpA = new THREE.Vector3();
        this._tmpB = new THREE.Vector3();
        this._tmpC = new THREE.Vector3();
        this._forward = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._moveDir = new THREE.Vector3();

        this.initThree();
        this.initShared();
        this.initPlayer();
        this.initWeapons();
        this.initWorld();
        this.initEnemies();
        this.initAllies();
        this.initSystems();
        this.initEvents();
        this.initUI();
        this.animate();
    }

    initSystems() {
        this.eventBus = new EventBus();
        this.combo = new ComboSystem(this.eventBus, GAME_CONFIG);
        this.skillSystem = new SkillSystem(this, this.eventBus, GAME_CONFIG);
        this.towerSystem = new TowerSystem(this, this.eventBus, GAME_CONFIG);
        this.towerSystem.initShared(this.geo.barrel, this.mat.gunMetal);
        this.updateHUD();
    }

    initThree() {
        const skin = SKINS[this.selectedSkin];
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(skin.sky);
        this.scene.fog = new THREE.Fog(skin.fog, 60, 160);

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 280);
        this.baseFov = 75;

        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
        this.renderer = new THREE.WebGLRenderer({
            canvas: document.getElementById('gameCanvas'),
            antialias: pixelRatio < 1.5,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;

        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.58);
        this.scene.add(this.ambientLight);

        this.sun = new THREE.DirectionalLight(0xfff4dd, 0.85);
        this.sun.position.set(40, 80, 30);
        this.sun.castShadow = true;
        this.sun.shadow.mapSize.width = 1024;
        this.sun.shadow.mapSize.height = 1024;
        this.sun.shadow.camera.near = 1;
        this.sun.shadow.camera.far = 220;
        this.sun.shadow.camera.left = -55;
        this.sun.shadow.camera.right = 55;
        this.sun.shadow.camera.top = 55;
        this.sun.shadow.camera.bottom = -55;
        this.sun.shadow.bias = -0.0004;
        this.scene.add(this.sun);
        this.scene.add(this.sun.target);

        this.bullets = [];
        this.enemyBullets = [];
        this.enemies = [];
        this.allies = [];
        this.pickups = [];
        this.bulletPool = [];
        this.clock = new THREE.Clock();
        this.fpsAccum = 0;
        this.fpsFrames = 0;
        this.hitMarkerTimer = 0;
        this.damageFlash = 0;
        this.weaponBob = 0;
        this.reloadStartedAt = 0;
    }

    initShared() {
        this.geo = {
            bullet: new THREE.SphereGeometry(0.05, 6, 6),
            enemyBullet: new THREE.SphereGeometry(0.08, 6, 6),
            barrel: new THREE.CylinderGeometry(0.5, 0.5, 1.2, 8),
            healthPickup: new THREE.BoxGeometry(0.55, 0.55, 0.55),
            ammoPickup: new THREE.CylinderGeometry(0.28, 0.28, 0.55, 8),
            healthBar: new THREE.PlaneGeometry(1, 0.1)
        };

        this.mat = {
            wall: new THREE.MeshStandardMaterial({ color: 0x6a6a72, roughness: 0.85 }),
            barrel: new THREE.MeshStandardMaterial({ color: 0x883322, roughness: 0.8, metalness: 0.25 }),
            enemyNormal: new THREE.MeshLambertMaterial({ color: 0xaa4444 }),
            enemyFast: new THREE.MeshLambertMaterial({ color: 0xaa44aa }),
            enemyTank: new THREE.MeshLambertMaterial({ color: 0x44aa44 }),
            eye: new THREE.MeshBasicMaterial({ color: 0xff2222 }),
            healthBg: new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.DoubleSide }),
            allySkin: new THREE.MeshLambertMaterial({ color: 0xffccaa }),
            gunMetal: new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.85, roughness: 0.25 })
        };
    }

    acquireBullet(color, enemy) {
        const geo = enemy ? this.geo.enemyBullet : this.geo.bullet;
        let mesh = this.bulletPool.pop();
        if (!mesh) {
            mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
        } else {
            mesh.geometry = geo;
            mesh.material.color.setHex(color);
        }
        mesh.visible = true;
        this.scene.add(mesh);
        return mesh;
    }

    releaseBullet(mesh) {
        mesh.visible = false;
        this.scene.remove(mesh);
        this.bulletPool.push(mesh);
    }

    setTimer(fn, ms) {
        const id = setTimeout(() => {
            const idx = this.timers.indexOf(id);
            if (idx >= 0) this.timers.splice(idx, 1);
            fn();
        }, ms);
        this.timers.push(id);
        return id;
    }

    clearTimers() {
        for (let i = 0; i < this.timers.length; i++) clearTimeout(this.timers[i]);
        this.timers.length = 0;
    }

    initPlayer() {
        this.player = {
            position: new THREE.Vector3(0, 1.6, -25),
            velocity: new THREE.Vector3(0, 0, 0),
            health: 100,
            maxHealth: 100,
            onGround: false,
            yaw: Math.PI,
            pitch: 0,
            height: 1.6,
            radius: 0.4,
            speed: 8.5,
            sprintMultiplier: 1.55,
            jumpForce: 10.5,
            isSprinting: false
        };
        this.camera.position.copy(this.player.position);
    }

    initWeapons() {
        this.currentWeaponIndex = 0;
        this.weaponGroups = [];
        this.weaponData = WEAPONS.map(w => ({
            ...w,
            currentAmmo: w.magSize,
            currentReserve: w.reserveAmmo,
            lastShot: 0,
            isReloading: false
        }));

        WEAPONS.forEach((weapon, index) => {
            const group = new THREE.Group();
            this.buildWeaponModel(group, index);
            group.visible = index === 0;
            this.weaponGroups.push(group);
            this.camera.add(group);
        });

        this.weaponGroups[0].visible = true;
        this.scene.add(this.camera);
    }

    disposeObject(obj, sharedOk) {
        obj.traverse(child => {
            if (!child.isMesh) return;
            if (child.geometry && !sharedOk) child.geometry.dispose();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(m => {
                if (m && !sharedOk) m.dispose();
            });
        });
    }

    buildWeaponModel(group, index) {
        const skin = SKINS[this.selectedSkin];
        const bodyMat = new THREE.MeshStandardMaterial({ color: skin.secondary, metalness: 0.7, roughness: 0.3 });
        const trimMat = new THREE.MeshStandardMaterial({ color: skin.primary, roughness: 0.75 });

        const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.5), bodyMat);
        body.position.set(0.3, -0.25, -0.4);
        group.add(body);

        if (index === 0) {
            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.2, 8), this.mat.gunMetal);
            barrel.rotation.x = -Math.PI / 2;
            barrel.position.set(0.3, -0.23, -0.75);
            group.add(barrel);
            const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.08), trimMat);
            grip.position.set(0.3, -0.38, -0.3);
            grip.rotation.x = 0.2;
            group.add(grip);
        } else if (index === 1) {
            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 8), this.mat.gunMetal);
            barrel.rotation.x = -Math.PI / 2;
            barrel.position.set(0.3, -0.22, -0.85);
            group.add(barrel);
            const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.25), trimMat);
            stock.position.set(0.3, -0.25, -0.1);
            group.add(stock);
            const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.06), this.mat.gunMetal);
            mag.position.set(0.3, -0.4, -0.45);
            group.add(mag);
        } else if (index === 2) {
            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.55, 8), this.mat.gunMetal);
            barrel.rotation.x = -Math.PI / 2;
            barrel.position.set(0.3, -0.22, -0.95);
            group.add(barrel);
            const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.35), trimMat);
            stock.position.set(0.3, -0.25, -0.05);
            group.add(stock);
            const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8), this.mat.gunMetal);
            scope.rotation.z = Math.PI / 2;
            scope.position.set(0.3, -0.14, -0.45);
            group.add(scope);
            const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.08), trimMat);
            mag.position.set(0.3, -0.42, -0.5);
            group.add(mag);
        } else {
            for (let i = 0; i < 2; i++) {
                const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.5, 8), this.mat.gunMetal);
                barrel.rotation.x = -Math.PI / 2;
                barrel.position.set(0.3 + (i - 0.5) * 0.04, -0.24, -0.85);
                group.add(barrel);
            }
            const stock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 0.35), trimMat);
            stock.position.set(0.3, -0.28, -0.05);
            group.add(stock);
            const pump = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.12), this.mat.gunMetal);
            pump.position.set(0.3, -0.32, -0.65);
            group.add(pump);
        }

        const accent = new THREE.Mesh(
            new THREE.BoxGeometry(0.02, 0.02, 0.05),
            new THREE.MeshStandardMaterial({ color: skin.accent, emissive: skin.accent, emissiveIntensity: 0.5 })
        );
        accent.position.set(0.3, -0.19, -0.55);
        group.add(accent);
    }

    initWorld() {
        const groundGeo = new THREE.PlaneGeometry(200, 200);
        this.groundMat = new THREE.MeshLambertMaterial({ color: SKINS[this.selectedSkin].ground });
        this.ground = new THREE.Mesh(groundGeo, this.groundMat);
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.receiveShadow = true;
        this.scene.add(this.ground);
        this.colliders = [];
        this.envMeshes = [];
        this.buildEnvironment();
    }

    addBoxCollider(pos, size, owner = null) {
        const c = {
            min: new THREE.Vector3(pos[0] - size[0] / 2, 0, pos[2] - size[2] / 2),
            max: new THREE.Vector3(pos[0] + size[0] / 2, size[1], pos[2] + size[2] / 2),
            active: true,
            owner: owner
        };
        this.colliders.push(c);
        return c;
    }

    buildEnvironment() {
        const arenaSize = 80;
        const wallHeight = 6;
        const wallThickness = 2;

        const walls = [
            { pos: [0, wallHeight / 2, -arenaSize / 2], size: [arenaSize, wallHeight, wallThickness] },
            { pos: [0, wallHeight / 2, arenaSize / 2], size: [arenaSize, wallHeight, wallThickness] },
            { pos: [-arenaSize / 2, wallHeight / 2, 0], size: [wallThickness, wallHeight, arenaSize] },
            { pos: [arenaSize / 2, wallHeight / 2, 0], size: [wallThickness, wallHeight, arenaSize] }
        ];

        walls.forEach(w => {
            const wall = new THREE.Mesh(new THREE.BoxGeometry(...w.size), this.mat.wall);
            wall.position.set(...w.pos);
            wall.castShadow = true;
            wall.receiveShadow = true;
            this.scene.add(wall);
            this.envMeshes.push(wall);
            this.addBoxCollider(w.pos, w.size);
        });

        const obstacles = [
            { pos: [-20, 1.5, -20], size: [3, 3, 3], color: 0x7a4a8a },
            { pos: [20, 1.5, -20], size: [3, 3, 3], color: 0x7a4a8a },
            { pos: [-20, 1.5, 20], size: [3, 3, 3], color: 0x7a4a8a },
            { pos: [20, 1.5, 20], size: [3, 3, 3], color: 0x7a4a8a },
            { pos: [0, 2, 0], size: [6, 4, 6], color: 0x4a4a68 },
            { pos: [-35, 1, 0], size: [2, 2, 15], color: 0x776655 },
            { pos: [35, 1, 0], size: [2, 2, 15], color: 0x776655 },
            { pos: [0, 1, -35], size: [15, 2, 2], color: 0x776655 },
            { pos: [0, 1, 35], size: [15, 2, 2], color: 0x776655 },
            { pos: [-15, 1.25, 10], size: [2.5, 2.5, 2.5], color: 0x667788 },
            { pos: [15, 1.25, -10], size: [2.5, 2.5, 2.5], color: 0x667788 },
            { pos: [-10, 0.75, 30], size: [4, 1.5, 1.5], color: 0x998877 },
            { pos: [10, 0.75, -30], size: [4, 1.5, 1.5], color: 0x998877 },
            { pos: [-8, 0.6, -8], size: [3, 1.2, 1.2], color: 0x556677 },
            { pos: [8, 0.6, 8], size: [3, 1.2, 1.2], color: 0x556677 }
        ];

        obstacles.forEach(o => {
            const obs = new THREE.Mesh(
                new THREE.BoxGeometry(...o.size),
                new THREE.MeshLambertMaterial({ color: o.color })
            );
            obs.position.set(...o.pos);
            obs.castShadow = true;
            obs.receiveShadow = true;
            this.scene.add(obs);
            this.envMeshes.push(obs);
            this.addBoxCollider(o.pos, [o.size[0], o.size[1], o.size[2]]);
        });

        const barrelSpots = [
            [-12, -18], [14, -22], [-28, 12], [22, 16], [-6, 22], [18, -6],
            [-24, -8], [30, -14], [-16, 28], [8, 32], [-32, -28], [26, 28],
            [4, -16], [-18, 4], [12, 12]
        ];
        this.barrels = [];
        barrelSpots.forEach(([x, z]) => {
            const barrel = new THREE.Mesh(this.geo.barrel, this.mat.barrel);
            barrel.position.set(x, 0.6, z);
            barrel.castShadow = true;
            barrel.receiveShadow = true;
            this.scene.add(barrel);
            
            const collider = this.addBoxCollider([x, 0.6, z], [1.0, 1.2, 1.0], barrel);
            
            this.barrels.push({
                mesh: barrel,
                collider: collider,
                health: 40,
                position: new THREE.Vector3(x, 0.6, z),
                active: true
            });
        });
    }

    initEnemies() {
        this.enemySpawnPoints = [
            new THREE.Vector3(-35, 0, -35),
            new THREE.Vector3(35, 0, -35),
            new THREE.Vector3(-35, 0, 35),
            new THREE.Vector3(35, 0, 35),
            new THREE.Vector3(0, 0, -38),
            new THREE.Vector3(0, 0, 38),
            new THREE.Vector3(-38, 0, 0),
            new THREE.Vector3(38, 0, 0)
        ];
    }

    initAllies() {
        this.spawnAlly(new THREE.Vector3(-5, 0, 0), 0);
        this.spawnAlly(new THREE.Vector3(5, 0, 5), 1);
    }

    spawnAlly(position, index) {
        const group = new THREE.Group();
        const skin = SKINS[this.selectedSkin];
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 1.4, 0.4),
            new THREE.MeshLambertMaterial({ color: skin.primary })
        );
        body.position.y = 0.7;
        body.castShadow = true;
        group.add(body);

        const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 10), this.mat.allySkin);
        head.position.y = 1.7;
        head.castShadow = true;
        group.add(head);

        const helmet = new THREE.Mesh(
            new THREE.SphereGeometry(0.27, 10, 10, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshLambertMaterial({ color: skin.secondary })
        );
        helmet.position.y = 1.75;
        group.add(helmet);

        const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.5), this.mat.gunMetal);
        weapon.position.set(0.4, 0.9, -0.15);
        group.add(weapon);

        group.position.copy(position);
        this.scene.add(group);

        this.allies.push({
            mesh: group,
            position: position.clone(),
            health: 90,
            maxHealth: 90,
            damage: 14,
            fireRate: 380,
            lastShot: 0,
            range: 32,
            speed: 3.2,
            patrolTarget: null,
            index
        });
    }

    spawnEnemy(type = 'normal') {
        const spawnPoint = this.enemySpawnPoints[Math.floor(Math.random() * this.enemySpawnPoints.length)];
        const group = new THREE.Group();

        let size, health, damage, speed, scoreValue, mat, attackRange, cooldown;
        switch (type) {
            case 'tank':
                size = { body: [1, 2, 0.8], head: 0.45 };
                health = 200; damage = 24; speed = 1.9; scoreValue = 200;
                mat = this.mat.enemyTank; attackRange = 2.8; cooldown = 1100;
                break;
            case 'fast':
                size = { body: [0.5, 1.2, 0.35], head: 0.22 };
                health = 40; damage = 10; speed = 6.2; scoreValue = 100;
                mat = this.mat.enemyFast; attackRange = 2.2; cooldown = 800;
                break;
            default:
                size = { body: [0.7, 1.6, 0.5], head: 0.3 };
                health = 60; damage = 15; speed = 3.1; scoreValue = 50;
                mat = this.mat.enemyNormal; attackRange = 2.5; cooldown = 1000;
        }

        const body = new THREE.Mesh(new THREE.BoxGeometry(...size.body), mat);
        body.position.y = size.body[1] / 2;
        body.castShadow = true;
        group.add(body);

        const head = new THREE.Mesh(new THREE.SphereGeometry(size.head, 10, 10), mat);
        head.position.y = size.body[1] + size.head * 0.8;
        head.castShadow = true;
        group.add(head);

        const leftEye = new THREE.Mesh(new THREE.SphereGeometry(size.head * 0.15, 6, 6), this.mat.eye);
        leftEye.position.set(-size.head * 0.35, size.body[1] + size.head * 0.9, size.head * 0.6);
        group.add(leftEye);
        const rightEye = new THREE.Mesh(new THREE.SphereGeometry(size.head * 0.15, 6, 6), this.mat.eye);
        rightEye.position.set(size.head * 0.35, size.body[1] + size.head * 0.9, size.head * 0.6);
        group.add(rightEye);

        const healthBarBg = new THREE.Mesh(this.geo.healthBar, this.mat.healthBg);
        healthBarBg.position.y = size.body[1] + size.head * 1.55;
        group.add(healthBarBg);

        const healthBar = new THREE.Mesh(
            this.geo.healthBar,
            new THREE.MeshBasicMaterial({ color: 0xff4444, side: THREE.DoubleSide })
        );
        healthBar.position.y = size.body[1] + size.head * 1.55;
        healthBar.position.z = 0.02;
        group.add(healthBar);

        group.position.copy(spawnPoint);
        group.position.x += (Math.random() - 0.5) * 4;
        group.position.z += (Math.random() - 0.5) * 4;
        this.scene.add(group);

        const radius = Math.max(size.body[0], size.body[2]) * 0.5 + 0.12;
        this.enemies.push({
            mesh: group,
            healthBar,
            healthBarBg,
            position: group.position,
            health,
            maxHealth: health,
            damage,
            speed,
            attackRange,
            attackCooldown: cooldown,
            lastAttack: 0,
            lastRanged: 0,
            scoreValue,
            type,
            size,
            radius,
            hitFlash: 0,
            headY: size.body[1] + size.head * 0.8,
            knockbackVelocity: new THREE.Vector3(),
            knockbackTime: 0,
            knockbackDuration: 0
        });
    }

    startWave() {
        this.waveAdvancing = false;
        this.showMessage(`第 ${this.wave} 波来袭！`, 'warning');

        const enemyCount = 3 + Math.floor(this.wave * 1.6);
        this.waveEnemiesRemaining = enemyCount;

        for (let i = 0; i < enemyCount; i++) {
            this.setTimer(() => {
                if (this.state !== GAME_STATE.PLAYING) return;
                let type = 'normal';
                const rand = Math.random();
                if (this.wave >= 5 && rand < 0.08) type = 'tank';
                else if (this.wave >= 3 && rand < 0.18) type = 'tank';
                else if (this.wave >= 2 && rand < 0.38) type = 'fast';
                this.spawnEnemy(type);
            }, i * 700);
        }
    }

    initEvents() {
        this.keys = {};
        this.mouseDown = false;
        this._ignoreLockPause = false;
        this._hadPointerLock = false;

        window.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            if (e.code === 'Space') e.preventDefault();

            if (this.state === GAME_STATE.PLAYING) {
                if (e.code >= 'Digit1' && e.code <= 'Digit4') {
                    this.switchWeapon(parseInt(e.code.replace('Digit', ''), 10) - 1);
                }
                if (e.code === 'KeyR') this.reload();
                if (e.code === 'Escape') this.pauseGame();
            } else if (this.state === GAME_STATE.PAUSED && e.code === 'Escape') {
                this.resumeGame();
            }
        });

        window.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
        });

        window.addEventListener('mousedown', (e) => {
            if (e.button === 0) this.mouseDown = true;
        });

        window.addEventListener('mouseup', (e) => {
            if (e.button === 0) this.mouseDown = false;
        });

        window.addEventListener('mousemove', (e) => {
            if (this.state !== GAME_STATE.PLAYING || !document.pointerLockElement) return;
            this.player.yaw -= e.movementX * 0.0022;
            this.player.pitch -= e.movementY * 0.0022;
            this.player.pitch = Math.max(-1.45, Math.min(1.45, this.player.pitch));
        });

        window.addEventListener('wheel', (e) => {
            if (this.state !== GAME_STATE.PLAYING) return;
            e.preventDefault();
            const dir = e.deltaY > 0 ? 1 : -1;
            const next = (this.currentWeaponIndex + dir + WEAPONS.length) % WEAPONS.length;
            this.switchWeapon(next);
        }, { passive: false });

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });

        document.addEventListener('pointerlockchange', () => {
            const locked = !!document.pointerLockElement;
            if (this.state === GAME_STATE.PLAYING && this._hadPointerLock && !locked && !this._ignoreLockPause) {
                this.pauseGame();
            }
            this._hadPointerLock = locked;
        });

        document.getElementById('gameCanvas').addEventListener('click', () => {
            if (this.state === GAME_STATE.PLAYING) {
                document.getElementById('gameCanvas').requestPointerLock();
            }
        });

        document.getElementById('startButton').addEventListener('click', () => this.startGame());
        document.getElementById('restartButton').addEventListener('click', () => {
            this.resetGame();
            this.startGame();
        });
        document.getElementById('resumeButton').addEventListener('click', () => this.resumeGame());
        document.getElementById('quitButton').addEventListener('click', () => this.quitToMenu());

        document.querySelectorAll('.skin-option').forEach(opt => {
            opt.addEventListener('click', () => {
                document.querySelectorAll('.skin-option').forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                this.selectedSkin = opt.dataset.skin;
            });
        });
    }

    initUI() {
        this.els = {
            container: document.getElementById('gameContainer'),
            healthFill: document.getElementById('healthFill'),
            healthText: document.getElementById('healthText'),
            ammoText: document.getElementById('ammoText'),
            weaponName: document.getElementById('weaponName'),
            scoreText: document.getElementById('scoreText'),
            killsText: document.getElementById('killsText'),
            waveText: document.getElementById('waveText'),
            damageOverlay: document.getElementById('damageOverlay'),
            muzzleFlash: document.getElementById('muzzleFlash'),
            hitMarker: document.getElementById('hitMarker'),
            reloadBar: document.getElementById('reloadBar'),
            reloadFill: document.getElementById('reloadFill'),
            crosshair: document.getElementById('crosshair'),
            fps: document.getElementById('fpsCounter'),
            messageBox: document.getElementById('messageBox')
        };
        this.updateHUD();
    }

    setPlayingUI(on) {
        this.els.container.classList.toggle('playing', on);
    }

    startGame() {
        this.audio.ensure();
        this.state = GAME_STATE.PLAYING;
        document.getElementById('startScreen').classList.add('hidden');
        document.getElementById('gameOverScreen').classList.add('hidden');
        this.setPlayingUI(true);
        this._ignoreLockPause = true;
        document.getElementById('gameCanvas').requestPointerLock();
        this.setTimer(() => { this._ignoreLockPause = false; }, 250);
        this.applySkin();
        this.startWave();
    }

    pauseGame() {
        if (this.state !== GAME_STATE.PLAYING) return;
        this.state = GAME_STATE.PAUSED;
        document.getElementById('pauseScreen').classList.remove('hidden');
        if (document.pointerLockElement) document.exitPointerLock();
    }

    resumeGame() {
        this.state = GAME_STATE.PLAYING;
        document.getElementById('pauseScreen').classList.add('hidden');
        this._ignoreLockPause = true;
        document.getElementById('gameCanvas').requestPointerLock();
        this.setTimer(() => { this._ignoreLockPause = false; }, 250);
    }

    quitToMenu() {
        this.state = GAME_STATE.MENU;
        document.getElementById('pauseScreen').classList.add('hidden');
        document.getElementById('gameOverScreen').classList.add('hidden');
        document.getElementById('startScreen').classList.remove('hidden');
        this.setPlayingUI(false);
        this.resetGame();
    }

    gameOver() {
        this.state = GAME_STATE.GAME_OVER;
        this.clearTimers();
        document.getElementById('pauseScreen').classList.add('hidden');
        document.getElementById('gameOverScreen').classList.remove('hidden');
        document.getElementById('finalScore').textContent = this.score;
        document.getElementById('finalKills').textContent = this.kills;
        document.getElementById('finalWave').textContent = this.wave;
        this.setPlayingUI(false);
        if (document.pointerLockElement) document.exitPointerLock();
    }

    resetGame() {
        this.clearTimers();
        this.score = 0;
        this.kills = 0;
        this.wave = 1;
        this.waveEnemiesRemaining = 0;
        this.waveAdvancing = false;

        this.player.health = this.player.maxHealth;
        this.player.position.set(0, 1.6, -25);
        this.player.velocity.set(0, 0, 0);
        this.player.yaw = Math.PI;
        this.player.pitch = 0;
        this.camera.fov = this.baseFov;
        this.camera.updateProjectionMatrix();

        this.enemies.forEach(e => this.scene.remove(e.mesh));
        this.enemies.length = 0;
        this.bullets.forEach(b => this.releaseBullet(b.mesh));
        this.bullets.length = 0;
        this.enemyBullets.forEach(b => this.releaseBullet(b.mesh));
        this.enemyBullets.length = 0;
        this.pickups.forEach(p => this.scene.remove(p.mesh));
        this.pickups.length = 0;

        this.allies.forEach(a => this.scene.remove(a.mesh));
        this.allies.length = 0;
        this.initAllies();

        this.weaponData.forEach(w => {
            w.currentAmmo = w.magSize;
            w.currentReserve = w.reserveAmmo;
            w.isReloading = false;
        });
        this.currentWeaponIndex = 0;
        this.weaponGroups.forEach((g, i) => { g.visible = i === 0; });
        document.querySelectorAll('.weapon-slot').forEach((slot, i) => {
            slot.classList.toggle('active', i === 0);
        });
        this.els.reloadBar.classList.remove('active');
        this.updateHUD();
    }

    applySkin() {
        const skin = SKINS[this.selectedSkin];
        this.scene.background.setHex(skin.sky);
        this.scene.fog.color.setHex(skin.fog);
        this.groundMat.color.setHex(skin.ground);

        this.weaponGroups.forEach(group => {
            this.camera.remove(group);
        });
        this.weaponGroups = [];
        WEAPONS.forEach((_, index) => {
            const group = new THREE.Group();
            this.buildWeaponModel(group, index);
            group.visible = index === this.currentWeaponIndex;
            this.weaponGroups.push(group);
            this.camera.add(group);
        });

        this.allies.forEach(a => this.scene.remove(a.mesh));
        this.allies.length = 0;
        this.initAllies();
    }

    switchWeapon(index) {
        if (index < 0 || index >= WEAPONS.length || index === this.currentWeaponIndex) return;
        if (this.weaponData[this.currentWeaponIndex].isReloading) return;

        this.weaponGroups[this.currentWeaponIndex].visible = false;
        this.currentWeaponIndex = index;
        this.weaponGroups[this.currentWeaponIndex].visible = true;

        document.querySelectorAll('.weapon-slot').forEach((slot, i) => {
            slot.classList.toggle('active', i === index);
        });
        this.updateHUD();
        this.showMessage(`切换到 ${WEAPONS[index].name}`, 'info');
    }

    reload() {
        const weapon = this.weaponData[this.currentWeaponIndex];
        if (weapon.isReloading) return;
        if (weapon.currentAmmo >= weapon.magSize) return;
        if (weapon.currentReserve <= 0) {
            this.showMessage('没有备用弹药！', 'danger');
            return;
        }

        weapon.isReloading = true;
        this.reloadStartedAt = performance.now();
        this.els.reloadBar.classList.add('active');
        this.showMessage('换弹中...', 'warning');
        this.audio.reload();

        this.setTimer(() => {
            if (this.state !== GAME_STATE.PLAYING && this.state !== GAME_STATE.PAUSED) return;
            const needed = weapon.magSize - weapon.currentAmmo;
            const available = Math.min(needed, weapon.currentReserve);
            weapon.currentAmmo += available;
            weapon.currentReserve -= available;
            weapon.isReloading = false;
            this.els.reloadBar.classList.remove('active');
            this.updateHUD();
            this.showMessage('换弹完成', 'success');
        }, weapon.reloadTime);
    }

    shoot() {
        const weapon = this.weaponData[this.currentWeaponIndex];
        const now = performance.now();
        if (weapon.isReloading) return;
        if (now - weapon.lastShot < weapon.fireRate) return;
        if (weapon.currentAmmo <= 0) {
            this.reload();
            return;
        }

        weapon.lastShot = now;
        weapon.currentAmmo--;
        this.showMuzzleFlash();
        this.applyRecoil();
        this.audio.shoot(weapon.id);

        const dir = this._tmpA;
        this.camera.getWorldDirection(dir);

        let comboResult = { count: 0, bonus: 0, headshot: false };

        for (let i = 0; i < weapon.pellets; i++) {
            const pelletDir = this._tmpB.copy(dir);
            pelletDir.x += (Math.random() - 0.5) * weapon.spread;
            pelletDir.y += (Math.random() - 0.5) * weapon.spread;
            pelletDir.z += (Math.random() - 0.5) * weapon.spread * 0.45;
            pelletDir.normalize();

            const mesh = this.acquireBullet(weapon.bulletColor, false);
            mesh.position.copy(this.camera.position);
            this.bullets.push({
                mesh,
                velocity: pelletDir.clone().multiplyScalar(weapon.bulletSpeed),
                damage: weapon.damage * (1 + comboResult.bonus),
                life: 1.6,
                pelletIndex: i,
                totalPellets: weapon.pellets
            });
        }
        this.updateHUD();
    }

    allyShoot(ally, target) {
        const now = performance.now();
        if (now - ally.lastShot < ally.fireRate) return;
        ally.lastShot = now;

        const dir = this._tmpA.subVectors(target.position, ally.position).normalize();
        dir.y += 0.12;
        dir.x += (Math.random() - 0.5) * 0.04;
        dir.normalize();

        const mesh = this.acquireBullet(0x66ff66, false);
        mesh.position.copy(ally.position);
        mesh.position.y += 1.1;
        this.bullets.push({
            mesh,
            velocity: dir.clone().multiplyScalar(62),
            damage: ally.damage,
            life: 1.8,
            fromAlly: true
        });
    }

    enemyShoot(enemy, targetPos) {
        const now = performance.now();
        if (now - enemy.lastRanged < 1400) return;
        enemy.lastRanged = now;

        const dir = this._tmpA.subVectors(targetPos, enemy.position).normalize();
        dir.y += 0.04;
        const mesh = this.acquireBullet(0xff4444, true);
        mesh.position.copy(enemy.position);
        mesh.position.y += 1.1;
        this.enemyBullets.push({
            mesh,
            velocity: dir.clone().multiplyScalar(28),
            damage: enemy.damage * 0.45,
            life: 2.4
        });
    }

    showMuzzleFlash() {
        const el = this.els.muzzleFlash;
        el.classList.remove('show');
        void el.offsetWidth;
        el.classList.add('show');
    }

    applyRecoil() {
        const weapon = WEAPONS[this.currentWeaponIndex];
        this.player.pitch += weapon.recoil * (0.45 + Math.random() * 0.55);
        this.player.yaw += (Math.random() - 0.5) * weapon.recoil * 0.35;
        this.player.pitch = Math.min(1.45, this.player.pitch);
    }

    showHitMarker(headshot) {
        this.hitMarkerTimer = 0.12;
        this.els.hitMarker.classList.add('show');
        this.els.hitMarker.classList.toggle('headshot', !!headshot);
        this.audio.hit(headshot);
    }

    updatePlayer(dt) {
        this.player.isSprinting = (this.keys['ShiftLeft'] || this.keys['ShiftRight']) && this.player.onGround;

        this._forward.set(-Math.sin(this.player.yaw), 0, -Math.cos(this.player.yaw));
        this._right.set(Math.cos(this.player.yaw), 0, -Math.sin(this.player.yaw));

        this._moveDir.set(0, 0, 0);
        if (this.keys['KeyW']) this._moveDir.add(this._forward);
        if (this.keys['KeyS']) this._moveDir.sub(this._forward);
        if (this.keys['KeyD']) this._moveDir.add(this._right);
        if (this.keys['KeyA']) this._moveDir.sub(this._right);

        const moving = this._moveDir.lengthSq() > 0;
        const targetSpeed = this.player.speed * (this.player.isSprinting ? this.player.sprintMultiplier : 1);
        
        if (moving) {
            this._moveDir.normalize();
            this.player.velocity.x += this._moveDir.x * 60.0 * dt;
            this.player.velocity.z += this._moveDir.z * 60.0 * dt;
            
            const horizSpeedSq = this.player.velocity.x * this.player.velocity.x + this.player.velocity.z * this.player.velocity.z;
            if (horizSpeedSq > targetSpeed * targetSpeed) {
                const ratio = targetSpeed / Math.sqrt(horizSpeedSq);
                this.player.velocity.x *= ratio;
                this.player.velocity.z *= ratio;
            }
        }
        
        const friction = this.player.onGround ? 10.0 : 2.0;
        const frictionFactor = Math.exp(-friction * dt);
        
        if (!moving || !this.player.onGround) {
            this.player.velocity.x *= frictionFactor;
            this.player.velocity.z *= frictionFactor;
        } else {
            this.player.velocity.x = this.player.velocity.x * 0.85 + this._moveDir.x * targetSpeed * 0.15;
            this.player.velocity.z = this.player.velocity.z * 0.85 + this._moveDir.z * targetSpeed * 0.15;
        }

        if (this.keys['Space'] && this.player.onGround) {
            this.player.velocity.y = this.player.jumpForce;
            this.player.onGround = false;
        }

        this.player.velocity.y -= 26 * dt;

        let newY = this.player.position.y + this.player.velocity.y * dt;
        let onGround = false;
        const feet = newY - this.player.height;
        const head = newY + 0.12;
        let groundY = 0;
        let hitCeiling = false;

        for (let i = 0; i < this.colliders.length; i++) {
            const c = this.colliders[i];
            if (this.player.position.x + this.player.radius > c.min.x && this.player.position.x - this.player.radius < c.max.x &&
                this.player.position.z + this.player.radius > c.min.z && this.player.position.z - this.player.radius < c.max.z) {
                if (this.player.velocity.y <= 0 && this.player.position.y - this.player.height >= c.max.y - 0.1) {
                    if (c.max.y > groundY) groundY = c.max.y;
                } else if (this.player.velocity.y > 0 && this.player.position.y + 0.12 <= c.min.y + 0.1) {
                    if (head > c.min.y) {
                        newY = c.min.y - 0.12 - 0.01;
                        hitCeiling = true;
                    }
                }
            }
        }

        if (feet <= groundY) {
            newY = groundY + this.player.height;
            this.player.velocity.y = 0;
            onGround = true;
        } else if (hitCeiling) {
            this.player.velocity.y = 0;
        }

        this.player.position.y = newY;
        this.player.onGround = onGround;

        const newX = this.player.position.x + this.player.velocity.x * dt;
        if (!this.blockedAt(newX, this.player.position.y, this.player.position.z, this.player.radius)) {
            this.player.position.x = newX;
        } else {
            this.player.velocity.x = 0;
        }

        const newZ = this.player.position.z + this.player.velocity.z * dt;
        if (!this.blockedAt(this.player.position.x, this.player.position.y, newZ, this.player.radius)) {
            this.player.position.z = newZ;
        } else {
            this.player.velocity.z = 0;
        }

        this.camera.position.copy(this.player.position);
        if (moving && this.player.onGround) {
            this.weaponBob += dt * (this.player.isSprinting ? 12 : 8);
            this.camera.position.y += Math.sin(this.weaponBob) * 0.04;
        }

        const group = this.weaponGroups[this.currentWeaponIndex];
        if (group) {
            group.position.y = moving ? Math.sin(this.weaponBob) * 0.018 : 0;
            group.position.x = moving ? Math.cos(this.weaponBob * 0.5) * 0.01 : 0;
        }

        this.camera.rotation.order = 'YXZ';
        this.camera.rotation.y = this.player.yaw;
        this.camera.rotation.x = this.player.pitch;

        const targetFov = this.player.isSprinting && moving ? 84 : this.baseFov;
        this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 8);
        this.camera.updateProjectionMatrix();

        this.els.crosshair.classList.toggle('spread', moving || this.player.isSprinting);

        if (this.mouseDown) {
            const weapon = WEAPONS[this.currentWeaponIndex];
            if (weapon.auto || !this._lastMouseDown) this.shoot();
        }
        this._lastMouseDown = this.mouseDown;

        const weapon = this.weaponData[this.currentWeaponIndex];
        if (weapon.isReloading) {
            const t = Math.min(1, (performance.now() - this.reloadStartedAt) / weapon.reloadTime);
            this.els.reloadFill.style.width = (t * 100) + '%';
        }
    }

    blockedAt(px, py, pz, radius) {
        const feet = py - this.player.height + 0.08;
        const head = py + 0.12;
        for (let i = 0; i < this.colliders.length; i++) {
            const c = this.colliders[i];
            if (head <= c.min.y + 0.02 || feet >= c.max.y - 0.02) continue;
            if (px + radius > c.min.x && px - radius < c.max.x &&
                pz + radius > c.min.z && pz - radius < c.max.z) {
                return true;
            }
        }
        return false;
    }

    entityBlocked(px, pz, radius, height, py = 0) {
        for (let i = 0; i < this.colliders.length; i++) {
            const c = this.colliders[i];
            if (py + height <= c.min.y + 0.02 || py >= c.max.y - 0.02) continue;
            if (px + radius > c.min.x && px - radius < c.max.x &&
                pz + radius > c.min.z && pz - radius < c.max.z) {
                return true;
            }
        }
        return false;
    }

    bulletHitsWorld(pos) {
        if (pos.y < 0.05) return true;
        for (let i = 0; i < this.colliders.length; i++) {
            const c = this.colliders[i];
            if (pos.x > c.min.x && pos.x < c.max.x &&
                pos.z > c.min.z && pos.z < c.max.z &&
                pos.y > c.min.y && pos.y < c.max.y) {
                return true;
            }
        }
        return false;
    }

    updateBullets(dt) {
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];
            bullet.mesh.position.addScaledVector(bullet.velocity, dt);
            bullet.life -= dt;
            let hit = false;

            for (let j = this.enemies.length - 1; j >= 0; j--) {
                const enemy = this.enemies[j];
                const pos = bullet.mesh.position;
                const dx = pos.x - enemy.position.x;
                const dz = pos.z - enemy.position.z;
                const bodyY = enemy.position.y + enemy.size.body[1] * 0.5;
                const dy = pos.y - bodyY;
                const r = enemy.radius + 0.18;
                if (dx * dx + dz * dz + dy * dy * 0.45 > r * r) continue;

                const headDy = pos.y - (enemy.position.y + enemy.headY);
                const headshot = (dx * dx + dz * dz) < (enemy.size.head * enemy.size.head) && Math.abs(headDy) < enemy.size.head * 1.2;
                const dmg = headshot ? bullet.damage * 2 : bullet.damage;
                enemy.health -= dmg;
                enemy.hitFlash = 0.08;

                const healthPercent = Math.max(0, enemy.health / enemy.maxHealth);
                enemy.healthBar.scale.x = Math.max(0.02, healthPercent);
                enemy.healthBar.material.color.setHSL(healthPercent * 0.33, 1, 0.5);

                if (!bullet.fromAlly) this.showHitMarker(headshot);
                hit = true;
                if (enemy.health <= 0) this.killEnemy(j);
                break;
            }

            if (!hit && this.bulletHitsWorld(bullet.mesh.position)) hit = true;

            if (hit || bullet.life <= 0) {
                this.releaseBullet(bullet.mesh);
                this.bullets.splice(i, 1);
            }
        }

        for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
            const bullet = this.enemyBullets[i];
            bullet.mesh.position.addScaledVector(bullet.velocity, dt);
            bullet.life -= dt;
            let hit = false;
            const pos = bullet.mesh.position;

            const pdx = pos.x - this.player.position.x;
            const pdy = pos.y - (this.player.position.y - 0.75);
            const pdz = pos.z - this.player.position.z;
            if (pdx * pdx + pdy * pdy + pdz * pdz < 0.7 * 0.7) {
                this.damagePlayer(bullet.damage);
                hit = true;
            }

            if (!hit) {
                for (let j = this.allies.length - 1; j >= 0; j--) {
                    const ally = this.allies[j];
                    const adx = pos.x - ally.position.x;
                    const ady = pos.y - 1;
                    const adz = pos.z - ally.position.z;
                    if (adx * adx + ady * ady + adz * adz < 0.7 * 0.7) {
                        this.hurtAlly(j, bullet.damage);
                        hit = true;
                        break;
                    }
                }
            }

            if (!hit && this.bulletHitsWorld(pos)) hit = true;

            if (hit || bullet.life <= 0) {
                this.releaseBullet(bullet.mesh);
                this.enemyBullets.splice(i, 1);
            }
        }
    }

    hurtAlly(index, amount) {
        const ally = this.allies[index];
        ally.health -= amount;
        if (ally.health <= 0) {
            this.scene.remove(ally.mesh);
            this.allies.splice(index, 1);
            this.showMessage('队友阵亡！', 'danger');
        }
    }

    killEnemy(index) {
        const enemy = this.enemies[index];
        this.score += enemy.scoreValue;
        this.kills++;
        this.waveEnemiesRemaining--;
        this.scene.remove(enemy.mesh);
        this.enemies.splice(index, 1);

        if (Math.random() < 0.28) this.spawnPickup(enemy.position.clone());
        this.updateHUD();

        if (this.enemies.length === 0 && this.waveEnemiesRemaining <= 0 && !this.waveAdvancing) {
            this.waveAdvancing = true;
            this.setTimer(() => {
                if (this.state !== GAME_STATE.PLAYING) return;
                this.wave++;
                this.showMessage(`波次完成！准备迎接第 ${this.wave} 波`, 'success');
                this.player.health = Math.min(this.player.maxHealth, this.player.health + 30);
                this.weaponData.forEach(w => {
                    w.currentReserve = Math.min(w.reserveAmmo + w.magSize, w.currentReserve + Math.ceil(w.magSize * 0.5));
                });
                this.updateHUD();
                this.setTimer(() => {
                    if (this.state === GAME_STATE.PLAYING) this.startWave();
                }, 2800);
            }, 1200);
        }
    }

    spawnPickup(position) {
        const type = Math.random() < 0.55 ? 'health' : 'ammo';
        const color = type === 'health' ? 0xff4444 : 0xffcc00;
        const group = new THREE.Group();
        const mesh = new THREE.Mesh(
            type === 'health' ? this.geo.healthPickup : this.geo.ammoPickup,
            new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.35 })
        );
        group.add(mesh);
        group.position.copy(position);
        group.position.y = 0.5;
        this.scene.add(group);
        this.pickups.push({
            mesh: group,
            type,
            bobOffset: Math.random() * Math.PI * 2
        });
    }

    damagePlayer(amount) {
        this.player.health -= amount;
        this.damageFlash = 0.18;
        this.audio.damage();
        this.updateHUD();
        if (this.player.health <= 0) {
            this.player.health = 0;
            this.gameOver();
        }
    }

    updateEnemies(dt) {
        for (let i = 0; i < this.enemies.length; i++) {
            const enemy = this.enemies[i];
            let nearestIsPlayer = true;
            let nearestPos = this.player.position;
            let nearestDist = enemy.position.distanceTo(this.player.position);
            let nearestAlly = null;

            for (let a = 0; a < this.allies.length; a++) {
                const ally = this.allies[a];
                const d = enemy.position.distanceTo(ally.position);
                if (d < nearestDist) {
                    nearestDist = d;
                    nearestPos = ally.position;
                    nearestIsPlayer = false;
                    nearestAlly = ally;
                }
            }

            enemy.mesh.lookAt(nearestPos.x, enemy.position.y, nearestPos.z);
            enemy.healthBar.quaternion.copy(this.camera.quaternion);
            enemy.healthBarBg.quaternion.copy(this.camera.quaternion);

            const dir = this._tmpA.set(nearestPos.x - enemy.position.x, 0, nearestPos.z - enemy.position.z);
            if (dir.lengthSq() > 0.0001) dir.normalize();

            if (nearestDist > enemy.attackRange) {
                const step = enemy.speed * dt;
                const nx = enemy.position.x + dir.x * step;
                const nz = enemy.position.z + dir.z * step;
                if (!this.entityBlocked(nx, nz, enemy.radius, enemy.size.body[1], enemy.position.y)) {
                    enemy.position.x = nx;
                    enemy.position.z = nz;
                } else if (!this.entityBlocked(nx, enemy.position.z, enemy.radius, enemy.size.body[1], enemy.position.y)) {
                    enemy.position.x = nx;
                } else if (!this.entityBlocked(enemy.position.x, nz, enemy.radius, enemy.size.body[1], enemy.position.y)) {
                    enemy.position.z = nz;
                } else {
                    const side = this._tmpB.set(-dir.z, 0, dir.x);
                    const sx = enemy.position.x + side.x * step;
                    const sz = enemy.position.z + side.z * step;
                    if (!this.entityBlocked(sx, sz, enemy.radius, enemy.size.body[1], enemy.position.y)) {
                        enemy.position.x = sx;
                        enemy.position.z = sz;
                    }
                }
            } else {
                const now = performance.now();
                if (now - enemy.lastAttack > enemy.attackCooldown) {
                    enemy.lastAttack = now;
                    if (nearestIsPlayer) this.damagePlayer(enemy.damage);
                    else if (nearestAlly) {
                        const idx = this.allies.indexOf(nearestAlly);
                        if (idx >= 0) this.hurtAlly(idx, enemy.damage);
                    }
                }
            }

            if (enemy.type === 'normal' && nearestDist < 26 && nearestDist > enemy.attackRange + 1.5) {
                this.enemyShoot(enemy, nearestPos);
            }

            if (enemy.hitFlash > 0) {
                enemy.hitFlash -= dt;
                enemy.mesh.scale.setScalar(1 + enemy.hitFlash * 1.6);
            } else if (enemy.mesh.scale.x !== 1) {
                enemy.mesh.scale.setScalar(1);
            }
        }
    }

    updateAllies(dt) {
        for (let i = 0; i < this.allies.length; i++) {
            const ally = this.allies[i];
            let nearestEnemy = null;
            let nearestDist = Infinity;
            for (let j = 0; j < this.enemies.length; j++) {
                const enemy = this.enemies[j];
                const dist = ally.position.distanceTo(enemy.position);
                if (dist < nearestDist && dist < ally.range) {
                    nearestDist = dist;
                    nearestEnemy = enemy;
                }
            }

            if (nearestEnemy) {
                ally.mesh.lookAt(nearestEnemy.position.x, ally.position.y, nearestEnemy.position.z);
                if (nearestDist > 14) {
                    const dir = this._tmpA.subVectors(nearestEnemy.position, ally.position);
                    dir.y = 0;
                    dir.normalize();
                    const nx = ally.position.x + dir.x * ally.speed * dt;
                    const nz = ally.position.z + dir.z * ally.speed * dt;
                    if (!this.entityBlocked(nx, nz, 0.35, 1.4, ally.position.y)) {
                        ally.position.x = nx;
                        ally.position.z = nz;
                    }
                }
                this.allyShoot(ally, nearestEnemy);
            } else {
                if (!ally.patrolTarget || ally.position.distanceToSquared(ally.patrolTarget) < 4) {
                    ally.patrolTarget = new THREE.Vector3((Math.random() - 0.5) * 28, 0, (Math.random() - 0.5) * 28);
                }
                const dir = this._tmpA.subVectors(ally.patrolTarget, ally.position);
                dir.y = 0;
                if (dir.lengthSq() > 0.01) {
                    dir.normalize();
                    ally.position.x += dir.x * ally.speed * 0.45 * dt;
                    ally.position.z += dir.z * ally.speed * 0.45 * dt;
                    ally.mesh.lookAt(ally.patrolTarget.x, ally.position.y, ally.patrolTarget.z);
                }
            }
            ally.mesh.position.copy(ally.position);
        }
    }

    updatePickups(dt) {
        const time = performance.now() * 0.001;
        for (let i = this.pickups.length - 1; i >= 0; i--) {
            const pickup = this.pickups[i];
            pickup.mesh.rotation.y += dt * 2.2;
            pickup.mesh.position.y = 0.5 + Math.sin(time * 2 + pickup.bobOffset) * 0.14;
            const dx = this.player.position.x - pickup.mesh.position.x;
            const dz = this.player.position.z - pickup.mesh.position.z;
            if (dx * dx + dz * dz < 2.1) {
                if (pickup.type === 'health') {
                    this.player.health = Math.min(this.player.maxHealth, this.player.health + 35);
                    this.showMessage('+35 生命值', 'success');
                } else {
                    this.weaponData.forEach(w => {
                        w.currentReserve += Math.ceil(w.magSize * 0.5);
                    });
                    this.showMessage('全武器补给弹药', 'success');
                }
                this.audio.pickup();
                this.scene.remove(pickup.mesh);
                this.pickups.splice(i, 1);
                this.updateHUD();
            }
        }
    }

    updateHUD() {
        const healthPercent = Math.max(0, (this.player.health / this.player.maxHealth) * 100);
        this.els.healthFill.style.width = healthPercent + '%';
        this.els.healthFill.style.background = `linear-gradient(90deg, hsl(${healthPercent * 1.2}, 85%, 42%), hsl(${healthPercent * 1.2}, 85%, 55%))`;
        this.els.healthText.textContent = `${Math.ceil(Math.max(0, this.player.health))} / ${this.player.maxHealth}`;
        const weapon = this.weaponData[this.currentWeaponIndex];
        this.els.ammoText.textContent = `${weapon.currentAmmo} / ${weapon.currentReserve}`;
        this.els.ammoText.classList.toggle('low', weapon.currentAmmo <= Math.max(2, weapon.magSize * 0.2));
        this.els.weaponName.textContent = WEAPONS[this.currentWeaponIndex].name;
        this.els.scoreText.textContent = this.score;
        this.els.killsText.textContent = this.kills;
        this.els.waveText.textContent = this.wave;
        this.els.damageOverlay.classList.toggle('low-health', this.player.health > 0 && this.player.health <= 30);
    }

    showMessage(text, type = 'info') {
        const msg = document.createElement('div');
        msg.className = `message ${type}`;
        msg.textContent = text;
        this.els.messageBox.appendChild(msg);
        this.setTimer(() => msg.remove(), 3000);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        const dt = Math.min(this.clock.getDelta(), 0.05);

        this.fpsAccum += dt;
        this.fpsFrames++;
        if (this.fpsAccum >= 0.4) {
            this.els.fps.textContent = `${Math.round(this.fpsFrames / this.fpsAccum)} FPS`;
            this.fpsAccum = 0;
            this.fpsFrames = 0;
        }

        if (this.hitMarkerTimer > 0) {
            this.hitMarkerTimer -= dt;
            if (this.hitMarkerTimer <= 0) this.els.hitMarker.classList.remove('show', 'headshot');
        }

        if (this.damageFlash > 0) {
            this.damageFlash -= dt;
            if (!this.els.damageOverlay.classList.contains('low-health')) {
                this.els.damageOverlay.style.opacity = String(Math.max(0, this.damageFlash * 4));
            }
        } else if (!this.els.damageOverlay.classList.contains('low-health')) {
            this.els.damageOverlay.style.opacity = '0';
        }

        if (this.state === GAME_STATE.PLAYING) {
            this.updatePlayer(dt);
            this.updateBullets(dt);
            this.updateEnemies(dt);
            this.updateAllies(dt);
            this.updatePickups(dt);
        }

        this.sun.position.x = this.player.position.x + 40;
        this.sun.position.z = this.player.position.z + 30;
        this.sun.target.position.copy(this.player.position);
        this.sun.target.updateMatrixWorld();

        this.renderer.render(this.scene, this.camera);
    }
}

window.addEventListener('load', () => {
    const game = new FPSGame();
    window._game = game;
});
