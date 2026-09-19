// 连击系统：命中后短时间内连续击杀/命中会提高伤害和金币收益
class ComboSystem {
    constructor(eventBus, config) {
        this.eventBus = eventBus;
        this.config = config;
        this.count = 0;
        this.best = 0;
        this.lastHitAt = 0;
        this.bonus = 0;
    }

    onHit({ headshot = false } = {}) {
        const now = performance.now();
        const windowMs = this.config.COMBO_WINDOW_MS || 2000;

        if (now - this.lastHitAt > windowMs) {
            this.count = 0;
            this.bonus = 0;
        }

        this.count += 1;
        this.best = Math.max(this.best, this.count);
        this.lastHitAt = now;
        this.bonus = this.getBonus(this.count);

        this.eventBus.emit(GAME_EVENTS.COMBO_UPDATE, {
            count: this.count,
            best: this.best,
            bonus: this.bonus,
            headshot
        });

        return { count: this.count, bonus: this.bonus, headshot };
    }

    getBonus(count = this.count) {
        const thresholds = this.config.COMBO_BONUS_THRESHOLDS || [];
        let bonus = 0;
        thresholds.forEach(item => {
            if (count >= item.count) bonus = Math.max(bonus, item.multiplier || 0);
        });
        return bonus;
    }

    reset() {
        this.count = 0;
        this.best = 0;
        this.lastHitAt = 0;
        this.bonus = 0;
    }
}

// 物理工具：击退、扫掠碰撞、轴向移动辅助
class PhysicsSystem {
    static applyKnockback(entity, impulse, duration = 0.28) {
        if (!entity || !impulse) return;
        entity.knockbackVelocity = entity.knockbackVelocity || new THREE.Vector3();
        entity.knockbackVelocity.copy(impulse);
        entity.knockbackTime = duration;
        entity.knockbackDuration = duration;
    }

    static updateKnockback(entity, dt) {
        if (!entity || !entity.knockbackVelocity || entity.knockbackTime <= 0) return;
        entity.knockbackTime = Math.max(0, entity.knockbackTime - dt);
        const ratio = entity.knockbackDuration > 0 ? entity.knockbackTime / entity.knockbackDuration : 0;
        const decay = 0.35 + ratio * 0.65;
        entity.position.x += entity.knockbackVelocity.x * dt * decay;
        entity.position.z += entity.knockbackVelocity.z * dt * decay;
        if (entity.knockbackTime <= 0) {
            entity.knockbackVelocity.set(0, 0, 0);
        }
    }

    static moveWithAxisCollision(entity, dt, colliders, radius, height, blockedAt) {
        // 先应用击退，再应用玩家/单位自身速度，最后分轴碰撞
        PhysicsSystem.updateKnockback(entity, dt);

        const newX = entity.position.x + entity.velocity.x * dt;
        if (!blockedAt(newX, entity.position.y, entity.position.z, radius)) {
            entity.position.x = newX;
        } else {
            entity.velocity.x = 0;
        }

        const newZ = entity.position.z + entity.velocity.z * dt;
        if (!blockedAt(entity.position.x, entity.position.y, newZ, radius)) {
            entity.position.z = newZ;
        } else {
            entity.velocity.z = 0;
        }

        return entity.position;
    }

    static segmentHitsAabb(from, to, radius, box) {
        // 将线段采样为短步，兼顾高速子弹与简单 AABB 碰撞
        const distance = from.distanceTo(to);
        const steps = Math.max(1, Math.ceil(distance / Math.max(0.35, radius)));
        const step = new THREE.Vector3().subVectors(to, from).divideScalar(steps);
        const point = from.clone();

        for (let i = 0; i <= steps; i++) {
            point.add(i === 0 ? new THREE.Vector3() : step);
            if (
                point.x > box.min.x - radius && point.x < box.max.x + radius &&
                point.z > box.min.z - radius && point.z < box.max.z + radius &&
                point.y > box.min.y && point.y < box.max.y
            ) {
                return true;
            }
        }
        return false;
    }
}

// 防御塔系统：消耗金币部署，自动索敌，限时存在
class TowerSystem {
    constructor(game, eventBus, config) {
        this.game = game;
        this.eventBus = eventBus;
        this.config = config;
        this.towers = [];
        this.geo = null;
        this.mat = null;
    }

    initShared(geo, mat) {
        this.geo = geo;
        this.mat = mat;
    }

    canBuild(position) {
        if (!position) return false;
        if (position.y < 0) return false;
        if (this.game.entityBlocked(position.x, position.z, 0.55, 1.2, 0)) return false;
        if (this.game.blockedAt(position.x, 1.0, position.z, 0.55)) return false;
        return true;
    }

    build(type = 'basic', position) {
        const typeConfig = this.config.TOWER_TYPES[type];
        if (!typeConfig) return false;
        if (!this.canBuild(position)) {
            this.game.showMessage('这里不能建造防御塔', 'warning');
            return false;
        }
        if (this.game.gold < typeConfig.cost) {
            this.game.showMessage(`金币不足，需要 ${typeConfig.cost}`, 'danger');
            return false;
        }

        this.game.gold = Math.max(0, this.game.gold - typeConfig.cost);
        const group = new THREE.Group();
        const base = new THREE.Mesh(
            new THREE.CylinderGeometry(0.45, 0.62, 0.35, 12),
            new THREE.MeshStandardMaterial({ color: 0x263238, roughness: 0.7, metalness: 0.35 })
        );
        base.position.y = 0.18;
        base.castShadow = true;
        base.receiveShadow = true;
        group.add(base);

        const turret = new THREE.Mesh(
            new THREE.CylinderGeometry(0.28, 0.36, 0.45, 12),
            new THREE.MeshStandardMaterial({ color: typeConfig.color, emissive: typeConfig.color, emissiveIntensity: 0.22, roughness: 0.45, metalness: 0.45 })
        );
        turret.position.y = 0.58;
        turret.castShadow = true;
        group.add(turret);

        const barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.06, 0.85, 8),
            this.mat.gunMetal
        );
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.62, -0.45);
        barrel.castShadow = true;
        group.add(barrel);

        group.position.copy(position);
        group.position.y = 0;
        this.game.scene.add(group);

        const collider = this.game.addBoxCollider([position.x, 0.55, position.z], [1.0, 1.1, 1.0], group);
        const tower = {
            id: `tower_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            type,
            group,
            turret,
            barrel,
            collider,
            position: group.position,
            health: typeConfig.cost * 1.5,
            maxHealth: typeConfig.cost * 1.5,
            damage: typeConfig.damage,
            range: typeConfig.range,
            fireRate: typeConfig.fireRate,
            splashRadius: typeConfig.splashRadius || 0,
            duration: typeConfig.duration,
            lifetime: typeConfig.duration,
            lastShot: 0,
            active: true
        };

        this.towers.push(tower);
        this.eventBus.emit(GAME_EVENTS.TOWER_BUILT, tower);
        this.game.updateHUD();
        return true;
    }

    update(dt) {
        const now = performance.now();
        for (let i = this.towers.length - 1; i >= 0; i--) {
            const tower = this.towers[i];
            if (!tower.active) continue;

            tower.lifetime -= dt * 1000;
            if (tower.lifetime <= 0) {
                this.destroy(i);
                continue;
            }

            let nearest = null;
            let nearestDistSq = tower.range * tower.range;
            for (const enemy of this.game.enemies) {
                const dx = enemy.position.x - tower.position.x;
                const dz = enemy.position.z - tower.position.z;
                const distSq = dx * dx + dz * dz;
                if (distSq < nearestDistSq) {
                    nearest = enemy;
                    nearestDistSq = distSq;
                }
            }

            if (nearest) {
                const targetY = tower.position.y + 0.62;
                tower.group.lookAt(nearest.position.x, targetY, nearest.position.z);
                if (now - tower.lastShot >= tower.fireRate * 1000) {
                    tower.lastShot = now;
                    this.fire(tower, nearest);
                }
            }

            const scale = 0.88 + 0.12 * Math.max(0, tower.lifetime / tower.duration);
            tower.group.scale.setScalar(scale);
        }
    }

    fire(tower, target) {
        const origin = tower.position.clone();
        origin.y += 0.62;
        const dir = new THREE.Vector3().subVectors(target.position, origin);
        dir.y += 0.35;
        dir.normalize();

        const mesh = this.game.acquireBullet(0x66ffff, false);
        if (!mesh) return;
        mesh.position.copy(origin);
        this.game.bullets.push({
            mesh,
            velocity: dir.clone().multiplyScalar(86),
            damage: tower.damage,
            life: 1.5,
            fromTower: true,
            towerId: tower.id,
            splashRadius: tower.splashRadius
        });
    }

    destroy(index) {
        const tower = this.towers[index];
        if (!tower) return;
        tower.active = false;
        if (tower.collider) tower.collider.active = false;
        this.game.scene.remove(tower.group);
        this.towers.splice(index, 1);
        this.eventBus.emit(GAME_EVENTS.TOWER_DESTROYED, tower);
    }

    clear() {
        for (let i = this.towers.length - 1; i >= 0; i--) {
            this.destroy(i);
        }
    }
}

// 技能系统：子弹时间、近战震退、快速部署防御塔
class SkillSystem {
    constructor(game, eventBus, config) {
        this.game = game;
        this.eventBus = eventBus;
        this.config = config;
        this.cooldowns = {
            bulletTime: 0,
            melee: 0,
            tower: 0
        };
    }

    update(dt) {
        for (const key of Object.keys(this.cooldowns)) {
            this.cooldowns[key] = Math.max(0, this.cooldowns[key] - dt);
        }
    }

    isReady(name) {
        return this.cooldowns[name] <= 0;
    }

    useBulletTime() {
        const skill = this.config.SKILLS.bulletTime;
        if (!this.isReady('bulletTime')) {
            this.game.showMessage('子弹时间冷却中', 'warning');
            return false;
        }

        this.cooldowns.bulletTime = skill.cooldown / 1000;
        this.game.slowmoUntil = performance.now() + skill.duration;
        this.eventBus.emit(GAME_EVENTS.SKILL_USED, { skill: 'bulletTime' });
        this.game.showMessage('子弹时间启动', 'success');
        return true;
    }

    useMelee() {
        const skill = this.config.SKILLS.melee;
        if (!this.isReady('melee')) {
            this.game.showMessage('近战技能冷却中', 'warning');
            return false;
        }

        this.cooldowns.melee = skill.cooldown / 1000;
        const origin = this.game.player.position.clone();
        let hitCount = 0;

        for (let i = this.game.enemies.length - 1; i >= 0; i--) {
            const enemy = this.game.enemies[i];
            const dx = enemy.position.x - origin.x;
            const dz = enemy.position.z - origin.z;
            const distSq = dx * dx + dz * dz;
            if (distSq <= skill.range * skill.range) {
                const dir = new THREE.Vector3(dx, 0, dz).normalize();
                PhysicsSystem.applyKnockback(enemy, dir.multiplyScalar(13), 0.36);
                enemy.health -= skill.damage;
                enemy.hitFlash = 0.12;
                hitCount += 1;
                if (enemy.health <= 0) {
                    enemy.pendingHeadshot = false;
                    this.game.killEnemy(i);
                }
            }
        }

        this.eventBus.emit(GAME_EVENTS.SKILL_USED, { skill: 'melee', hitCount });
        this.game.showMessage(hitCount > 0 ? `近战震退 ${hitCount} 个目标` : '近战挥空', hitCount > 0 ? 'success' : 'warning');
        return true;
    }

    useTower() {
        const type = 'basic';
        const typeConfig = this.config.TOWER_TYPES[type];
        if (!this.isReady('tower')) {
            this.game.showMessage('部署冷却中', 'warning');
            return false;
        }
        if (this.game.gold < typeConfig.cost) {
            this.game.showMessage(`金币不足，需要 ${typeConfig.cost}`, 'danger');
            return false;
        }

        const forward = new THREE.Vector3(-Math.sin(this.game.player.yaw), 0, -Math.cos(this.game.player.yaw));
        const position = this.game.player.position.clone().addScaledVector(forward, 3.2);
        position.y = 0;

        if (this.towerBuildSpotBlocked(position)) {
            this.game.showMessage('前方位置无法建造', 'warning');
            return false;
        }

        this.cooldowns.tower = 2.5;
        if (this.towerSystemBuild(type, position)) {
            this.eventBus.emit(GAME_EVENTS.SKILL_USED, { skill: 'tower', type });
            return true;
        }
        return false;
    }

    towerBuildSpotBlocked(position) {
        return this.game.entityBlocked(position.x, position.z, 0.55, 1.2, 0) || this.game.blockedAt(position.x, 1.0, position.z, 0.55);
    }

    towerSystemBuild(type, position) {
        return this.game.towerSystem.build(type, position);
    }

    reset() {
        this.cooldowns.bulletTime = 0;
        this.cooldowns.melee = 0;
        this.cooldowns.tower = 0;
    }
}

window.ComboSystem = ComboSystem;
window.PhysicsSystem = PhysicsSystem;
window.TowerSystem = TowerSystem;
window.SkillSystem = SkillSystem;
