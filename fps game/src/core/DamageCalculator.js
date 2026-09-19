// 伤害计算系统 - 纯函数集中处理伤害逻辑
class DamageCalculator {
    // 基础伤害计算
    static calculateDamage(attacker, defender, baseDamage, context = {}) {
        if (baseDamage <= 0) return 0;
        
        const config = context.config || {};
        
        // 基础攻击力加成
        let attackBonus = 0;
        if (attacker && typeof attacker.getAttackPower === 'function') {
            attackBonus = attacker.getAttackPower();
        }
        
        // 防御减伤
        let armor = 0;
        if (defender && typeof defender.getArmor === 'function') {
            armor = defender.getArmor();
        }
        
        // 爆击判定
        let isCrit = false;
        if (attacker && Math.random() < (attacker.critRate || 0)) {
            isCrit = true;
        }
        if (context.forceCrit) {
            isCrit = true;
        }
        
        // 击中判定
        if (attacker && typeof attacker.getAccuracy === 'function') {
            if (Math.random() > attacker.getAccuracy()) {
                return 0; // 闪避
            }
        }
        
        const totalBase = baseDamage + attackBonus;
        const armorReduction = armor / (armor + 100); // 线性递减公式
        let damage = totalBase * (1 - armorReduction * 0.5);
        
        // 爆击伤害
        if (isCrit) {
            damage *= context.critMultiplier || 1.5;
        }
        
        // 头部击中
        if (context.headshot) {
            damage *= context.headshotMultiplier || 2.0;
        }
        
        // 连击加成
        if (context.comboCount && context.comboCount > 0) {
            const bonus = DamageCalculator.getComboBonus(context.comboCount);
            damage *= (1 + bonus);
        }
        
        return Math.max(0, Math.round(damage));
    }

    // 连击加成 - 根据连击加次数获取伤害加成
    static getComboBonus(comboCount) {
        if (comboCount >= 20) return 0.25;
        if (comboCount >= 10) return 0.15;
        if (comboCount >= 5) return 0.1;
        return 0;
    }

    // 爆头判定
    static checkHeadshot(bulletPos, enemy, enemySize) {
        const headY = enemy.position.y + enemy.headY;
        const dy = bulletPos.y - headY;
        const distSq = (bulletPos.x - enemy.position.x) ** 2 + (bulletPos.z - enemy.position.z) ** 2;
        const headRadiusSq = (enemySize.head * enemySize.head) * 2;
        
        return distSq < headRadiusSq && Math.abs(dy) < enemySize.head * 1.2;
    }

    // 范围伤害计算
    static calculateSplashDamage(centerPos, targets, baseDamage, radius) {
        const results = [];
        
        targets.forEach(target => {
            const dx = target.position.x - centerPos.x;
            const dz = target.position.z - centerPos.z;
            const distanceSq = dx * dx + dz * dz;
            
            if (distanceSq <= radius * radius) {
                const distance = Math.sqrt(distanceSq);
                const damageRatio = 1 - (distance / radius);
                const splashDamage = baseDamage * Math.max(0.3, damageRatio);
                results.push({ target, damage: Math.round(splashDamage) });
            }
        });
        
        return results;
    }
}

window.DamageCalculator = DamageCalculator;