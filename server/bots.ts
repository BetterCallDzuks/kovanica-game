import { CLASS_CONFIGS } from "../shared/constants";
import { GOLD_RELAY_POS, TEAL_RELAY_POS } from "../shared/map";
import { getEyePosition, raycastCombat } from "../shared/physics";
import type {
  BarrierState,
  ControlNodeState,
  CoreDropState,
  GameModeId,
  InputFrame,
  PlayerState,
  Vec3,
} from "../shared/types";

interface BotMemory {
  strafeDir: number;
  strafeSwapAt: number;
  seq: number;
  wanderOffset: Vec3;
}

export class BotController {
  private readonly mem = new Map<string, BotMemory>();

  generateInput(
    bot: PlayerState,
    nowMs: number,
    mode: GameModeId,
    isTeamMode: boolean,
    players: PlayerState[],
    nodes: ControlNodeState[],
    barriers: BarrierState[],
    cores: CoreDropState[]
  ): InputFrame {
    let m = this.mem.get(bot.id);
    if (!m) {
      m = {
        strafeDir: Math.random() < 0.5 ? -1 : 1,
        strafeSwapAt: nowMs + 1400 + Math.random() * 1400,
        seq: 0,
        wanderOffset: { x: (Math.random() - 0.5) * 3.5, y: 0, z: (Math.random() - 0.5) * 3.5 },
      };
      this.mem.set(bot.id, m);
    }
    m.seq += 1;

    if (nowMs >= m.strafeSwapAt) {
      m.strafeDir = -m.strafeDir;
      m.strafeSwapAt = nowMs + 1100 + Math.random() * 1600;
      m.wanderOffset = { x: (Math.random() - 0.5) * 3.5, y: 0, z: (Math.random() - 0.5) * 3.5 };
    }

    const eye = getEyePosition(bot);
    const cls = CLASS_CONFIGS[bot.classId];

    // 1. Find nearest visible enemy
    let targetEnemy: PlayerState | null = null;
    let bestEnemyDist = cls.weapon.range * 0.85;

    for (const other of players) {
      if (!other.alive || other.id === bot.id) continue;
      if (isTeamMode && other.team === bot.team) continue;

      const dx = other.x - eye.x;
      const dy = other.y + 1.15 - eye.y;
      const dz = other.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist >= bestEnemyDist) continue;

      const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
      const hit = raycastCombat(eye, dir, dist + 1.0, bot, players, barriers, isTeamMode);
      if (hit.hitPlayerId === other.id) {
        bestEnemyDist = dist;
        targetEnemy = other;
      }
    }

    // 2. Pick objective waypoint
    const goal = this.pickObjectiveGoal(bot, mode, nodes, cores, m.wanderOffset);
    const toGoalX = goal.x - bot.x;
    const toGoalZ = goal.z - bot.z;
    const goalDist = Math.hypot(toGoalX, toGoalZ);

    let yaw = bot.yaw;
    let pitch = 0;
    let fire = false;
    let moveX = 0;
    let moveZ = 0;
    let sprint = false;
    let jump = false;
    let ability = false;

    if (targetEnemy) {
      // Aim at enemy with natural human-like sway
      const aimX = targetEnemy.x - eye.x + (Math.random() - 0.5) * 0.55;
      const aimY = targetEnemy.y + 1.15 - eye.y + (Math.random() - 0.5) * 0.35;
      const aimZ = targetEnemy.z - eye.z + (Math.random() - 0.5) * 0.55;
      const horiz = Math.hypot(aimX, aimZ) || 0.001;
      yaw = Math.atan2(-aimX, -aimZ);
      pitch = Math.atan2(aimY, horiz);
      fire = Math.random() < 0.72;

      // Strafe while maintaining comfortable range
      moveX = m.strafeDir * 0.85;
      if (bestEnemyDist > 16) moveZ = 0.7;
      else if (bestEnemyDist < 6) moveZ = -0.6;
      else moveZ = 0.15;

      if (bot.abilityCooldownMs <= 0 && Math.random() < 0.05) {
        ability = true;
      }
    } else {
      // Move toward objective
      if (goalDist > 1.5) {
        yaw = Math.atan2(-toGoalX, -toGoalZ);
        pitch = 0;
        moveZ = 1;
        moveX = m.strafeDir * 0.15;
        sprint = goalDist > 8;
        // Hop if stuck against a low obstacle
        if (Math.hypot(bot.vx, bot.vz) < 1.2 && bot.grounded) {
          jump = true;
          m.strafeDir = -m.strafeDir;
        }
      } else {
        // Guard the node
        yaw = bot.yaw + 0.04 * m.strafeDir;
        moveX = m.strafeDir * 0.4;
      }
    }

    return {
      seq: m.seq,
      moveX,
      moveZ,
      yaw,
      pitch,
      jump,
      sprint,
      fire,
      ads: false,
      reload: bot.ammo === 0,
      ability,
    };
  }

  private pickObjectiveGoal(
    bot: PlayerState,
    mode: GameModeId,
    nodes: ControlNodeState[],
    cores: CoreDropState[],
    offset: Vec3
  ): Vec3 {
    if (mode === "core_extraction") {
      if (bot.carriedCores >= 2) {
        const relay = bot.team === "gold" ? GOLD_RELAY_POS : TEAL_RELAY_POS;
        return { x: relay.x, y: relay.y, z: relay.z };
      }
      if (cores.length > 0) {
        let nearest = cores[0];
        let bestD = Infinity;
        for (const c of cores) {
          const d = Math.hypot(c.x - bot.x, c.z - bot.z);
          if (d < bestD) {
            bestD = d;
            nearest = c;
          }
        }
        return { x: nearest.x, y: 0, z: nearest.z };
      }
    }

    if (mode === "vault_rush") {
      const active = nodes.find((n) => n.active) ?? nodes[1];
      return { x: active.x + offset.x, y: active.y, z: active.z + offset.z };
    }

    // Domination: prefer unowned or contested nodes, weighted by distance
    let bestNode = nodes[1];
    let bestScore = -Infinity;
    for (const n of nodes) {
      if (!n.active) continue;
      const dist = Math.hypot(n.x - bot.x, n.z - bot.z);
      const priority = n.owner !== bot.team ? 35 : n.contested ? 28 : 5;
      const score = priority - dist * 0.7;
      if (score > bestScore) {
        bestScore = score;
        bestNode = n;
      }
    }
    return { x: bestNode.x + offset.x, y: bestNode.y, z: bestNode.z + offset.z };
  }
}
