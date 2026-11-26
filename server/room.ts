import {
  BARRIER_DURATION_MS,
  BARRIER_MAX_HP,
  CLASS_CONFIGS,
  CLASS_ORDER,
  MODE_CONFIGS,
  RECON_DURATION_MS,
  RESPAWN_TIME_MS,
  TICK_DT,
  TICK_MS,
} from "../shared/constants";
import {
  CONTROL_NODES,
  FFA_SPAWNS,
  GOLD_RELAY_POS,
  GOLD_SPAWNS,
  RELAY_RADIUS,
  TEAL_RELAY_POS,
  TEAL_SPAWNS,
} from "../shared/map";
import { getAimDirection, getEyePosition, raycastCombat, stepPlayerPhysics } from "../shared/physics";
import type {
  BarrierState,
  ClassId,
  ControlNodeState,
  CoreDropState,
  GameModeId,
  HitConfirmEvent,
  InputFrame,
  KillEvent,
  MatchEndSummary,
  OwnerId,
  PlayerState,
  ServerSnapshot,
  TeamId,
  TracerEvent,
} from "../shared/types";
import { AntiCheatTracker, computeMatchReward } from "./anticheat";
import { BotController } from "./bots";

const BOT_NAMES = [
  "FORGE-01",
  "CRUCIBLE-X",
  "VEX-MINT",
  "KILN-7",
  "ANVIL-9",
  "DAG-SPECTRE",
];

const VAULT_ROTATION_MS = 45_000;
const VAULT_SEQUENCE: Array<"A" | "B" | "C"> = ["B", "A", "C"];

export class GameRoom {
  readonly id: string;
  mode: GameModeId;
  phase: "playing" | "ended" = "playing";
  tick = 0;
  remainingMs: number;
  goldScore = 0;
  tealScore = 0;
  overclockTeam: "gold" | "teal" | null = null;
  vaultIndex = 0;
  vaultRotateMs = VAULT_ROTATION_MS;

  readonly players = new Map<string, PlayerState>();
  readonly latestInputs = new Map<string, InputFrame>();
  readonly lastFireAt = new Map<string, number>();
  readonly pendingHitConfirms = new Map<string, HitConfirmEvent>();
  nodes: ControlNodeState[] = [];
  barriers: BarrierState[] = [];
  cores: CoreDropState[] = [];
  tracers: TracerEvent[] = [];
  kills: KillEvent[] = [];
  matchEnd?: MatchEndSummary;

  private readonly antiCheat = new AntiCheatTracker();
  private readonly botAi = new BotController();
  private readonly fillBots: boolean;
  private eventSeq = 1;
  private scoreTickAccumMs = 0;
  private serverTimeMs = 0;

  constructor(id: string, mode: GameModeId, fillBots = true) {
    this.id = id;
    this.mode = mode;
    this.fillBots = fillBots;
    this.remainingMs = MODE_CONFIGS[mode].durationMs;
    this.initNodes();
  }

  private initNodes(): void {
    this.nodes = CONTROL_NODES.map((n) => ({
      id: n.id,
      label: n.label,
      x: n.x,
      y: n.y,
      z: n.z,
      radius: n.radius,
      active: this.mode === "vault_rush" ? n.id === VAULT_SEQUENCE[this.vaultIndex] : true,
      owner: "neutral",
      progress: 0,
      capturingBy: null,
      contested: false,
      coreReadyMs: 4000,
    }));
  }

  get humanCount(): number {
    let count = 0;
    for (const p of this.players.values()) {
      if (!p.isBot) count++;
    }
    return count;
  }

  get hasBots(): boolean {
    for (const p of this.players.values()) {
      if (p.isBot) return true;
    }
    return false;
  }

  addHumanPlayer(params: {
    id: string;
    name: string;
    classId: ClassId;
    walletAddress?: string;
  }): PlayerState {
    const team = this.assignTeam();
    const player = this.createPlayer({
      id: params.id,
      name: params.name.trim().slice(0, 18) || "OPERATOR",
      isBot: false,
      team,
      classId: params.classId,
      walletAddress: params.walletAddress,
    });
    this.players.set(player.id, player);
    if (this.fillBots) {
      this.balanceBots();
    }
    return player;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    this.latestInputs.delete(id);
    this.lastFireAt.delete(id);
    if (this.humanCount > 0 && this.fillBots) {
      this.balanceBots();
    }
  }

  submitInput(playerId: string, frame: InputFrame): void {
    const p = this.players.get(playerId);
    if (!p) return;
    if (frame.desiredClass && CLASS_CONFIGS[frame.desiredClass]) {
      p.queuedClassId = frame.desiredClass;
    }
    this.latestInputs.set(playerId, frame);
  }

  rematch(nextMode?: GameModeId): void {
    if (nextMode && MODE_CONFIGS[nextMode]) {
      this.mode = nextMode;
    }
    this.phase = "playing";
    this.remainingMs = MODE_CONFIGS[this.mode].durationMs;
    this.goldScore = 0;
    this.tealScore = 0;
    this.overclockTeam = null;
    this.vaultIndex = 0;
    this.vaultRotateMs = VAULT_ROTATION_MS;
    this.barriers = [];
    this.cores = [];
    this.tracers = [];
    this.kills = [];
    this.matchEnd = undefined;
    this.antiCheat.reset();
    this.initNodes();

    // Re-assign teams cleanly for new mode
    const humans: PlayerState[] = [];
    for (const p of this.players.values()) {
      if (!p.isBot) humans.push(p);
    }
    this.players.clear();
    for (const h of humans) {
      h.team = this.assignTeam();
      h.kills = 0;
      h.deaths = 0;
      h.captures = 0;
      h.score = 0;
      h.carriedCores = 0;
      this.spawnPlayer(h);
      this.players.set(h.id, h);
    }
    if (this.fillBots) {
      this.balanceBots();
    }
  }

  private assignTeam(): TeamId {
    if (!MODE_CONFIGS[this.mode].isTeamMode) return "ffa";
    let gold = 0;
    let teal = 0;
    for (const p of this.players.values()) {
      if (p.team === "gold") gold++;
      else if (p.team === "teal") teal++;
    }
    return gold <= teal ? "gold" : "teal";
  }

  private balanceBots(): void {
    const maxPlayers = MODE_CONFIGS[this.mode].maxPlayers;
    // Remove excess bots if humans joined
    while (this.players.size > maxPlayers) {
      const bot = Array.from(this.players.values()).find((p) => p.isBot);
      if (!bot) break;
      this.players.delete(bot.id);
    }
    // Fill up to maxPlayers with bots
    let botIdx = 0;
    while (this.players.size < maxPlayers) {
      const id = `bot_${this.eventSeq++}`;
      const name = BOT_NAMES[botIdx % BOT_NAMES.length];
      botIdx++;
      const classId = CLASS_ORDER[(this.players.size + botIdx) % CLASS_ORDER.length];
      const team = this.assignTeam();
      const bot = this.createPlayer({ id, name, isBot: true, team, classId });
      this.players.set(id, bot);
    }
  }

  private createPlayer(params: {
    id: string;
    name: string;
    isBot: boolean;
    team: TeamId;
    classId: ClassId;
    walletAddress?: string;
  }): PlayerState {
    const cls = CLASS_CONFIGS[params.classId];
    const p: PlayerState = {
      id: params.id,
      name: params.name,
      isBot: params.isBot,
      walletAddress: params.walletAddress,
      team: params.team,
      classId: params.classId,
      queuedClassId: params.classId,
      x: 0,
      y: 0.1,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      hp: cls.maxHp,
      maxHp: cls.maxHp,
      alive: true,
      respawnMs: 0,
      ammo: cls.weapon.magSize,
      maxAmmo: cls.weapon.magSize,
      reloadingMs: 0,
      abilityCooldownMs: 0,
      reconActiveMs: 0,
      kills: 0,
      deaths: 0,
      captures: 0,
      score: 0,
      carriedCores: 0,
      lastProcessedSeq: 0,
      grounded: true,
    };
    this.spawnPlayer(p);
    return p;
  }

  private spawnPlayer(p: PlayerState): void {
    p.classId = p.queuedClassId;
    const cls = CLASS_CONFIGS[p.classId];
    const pool = p.team === "gold" ? GOLD_SPAWNS : p.team === "teal" ? TEAL_SPAWNS : FFA_SPAWNS;
    const spot = pool[Math.floor(Math.random() * pool.length)];
    p.x = spot.x + (Math.random() - 0.5) * 1.4;
    p.y = spot.y;
    p.z = spot.z + (Math.random() - 0.5) * 1.4;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.yaw = p.team === "gold" ? 0 : p.team === "teal" ? Math.PI : Math.atan2(-p.x, -p.z);
    p.pitch = 0;
    p.maxHp = cls.maxHp;
    p.hp = cls.maxHp;
    p.alive = true;
    p.respawnMs = 0;
    p.maxAmmo = cls.weapon.magSize;
    p.ammo = cls.weapon.magSize;
    p.reloadingMs = 0;
    p.carriedCores = 0;
    p.grounded = true;
  }

  step(dtMs = TICK_MS): void {
    this.tick += 1;
    this.serverTimeMs += dtMs;
    this.tracers = [];
    this.kills = [];
    this.pendingHitConfirms.clear();

    if (this.phase === "ended") return;

    const dt = dtMs / 1000;
    const modeCfg = MODE_CONFIGS[this.mode];
    const allPlayers = Array.from(this.players.values());

    // 1. Update timers & barriers & cores
    this.remainingMs = Math.max(0, this.remainingMs - dtMs);
    this.barriers = this.barriers.filter((b) => {
      b.remainingMs -= dtMs;
      return b.remainingMs > 0 && b.hp > 0;
    });
    this.cores = this.cores.filter((c) => {
      c.ttlMs -= dtMs;
      return c.ttlMs > 0;
    });

    // 2. Step each player
    for (const p of allPlayers) {
      if (!p.alive) {
        p.respawnMs -= dtMs;
        if (p.respawnMs <= 0) {
          this.spawnPlayer(p);
        }
        continue;
      }

      if (p.abilityCooldownMs > 0) p.abilityCooldownMs = Math.max(0, p.abilityCooldownMs - dtMs);
      if (p.reconActiveMs > 0) p.reconActiveMs = Math.max(0, p.reconActiveMs - dtMs);
      if (p.reloadingMs > 0) {
        p.reloadingMs -= dtMs;
        if (p.reloadingMs <= 0) {
          p.reloadingMs = 0;
          p.ammo = p.maxAmmo;
        }
      }

      const input = p.isBot
        ? this.botAi.generateInput(
            p,
            this.serverTimeMs,
            this.mode,
            modeCfg.isTeamMode,
            allPlayers,
            this.nodes,
            this.barriers,
            this.cores
          )
        : this.latestInputs.get(p.id);

      if (!input) continue;

      stepPlayerPhysics(p, input, dt, this.barriers);
      p.lastProcessedSeq = input.seq;

      if (input.reload && p.reloadingMs === 0 && p.ammo < p.maxAmmo) {
        p.reloadingMs = CLASS_CONFIGS[p.classId].weapon.reloadMs;
      }

      if (input.ability && p.abilityCooldownMs <= 0) {
        this.triggerAbility(p, input, allPlayers, modeCfg.isTeamMode);
      }

      if (input.fire && p.reloadingMs === 0) {
        this.tryFireWeapon(p, input, allPlayers, modeCfg.isTeamMode);
      }
    }

    // 3. Mode objectives & scoring
    this.stepObjectives(dtMs, allPlayers);

    // 4. Check win conditions
    this.checkMatchEnd(allPlayers);
  }

  private triggerAbility(
    p: PlayerState,
    input: InputFrame,
    allPlayers: PlayerState[],
    isTeamMode: boolean
  ): void {
    const cls = CLASS_CONFIGS[p.classId];
    p.abilityCooldownMs = cls.abilityCooldownMs;

    const sinY = Math.sin(p.yaw);
    const cosY = Math.cos(p.yaw);
    const fwdX = -sinY;
    const fwdZ = -cosY;
    const rightX = cosY;
    const rightZ = -sinY;

    if (p.classId === "striker") {
      // Vector Dash
      const mx = input.moveX || 0;
      const mz = input.moveZ || 1;
      const len = Math.hypot(mx, mz) || 1;
      const dx = (fwdX * mz + rightX * mx) / len;
      const dz = (fwdZ * mz + rightZ * mx) / len;
      p.vx = dx * 21;
      p.vz = dz * 21;
      p.vy = Math.max(p.vy, 3.2);
    } else if (p.classId === "breacher") {
      // Kinetic Impulse: lunge + 7.5m enemy knockback
      p.vx = fwdX * 15;
      p.vz = fwdZ * 15;
      for (const other of allPlayers) {
        if (!other.alive || other.id === p.id) continue;
        if (isTeamMode && other.team === p.team) continue;
        const dx = other.x - p.x;
        const dz = other.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.01 && d <= 7.5) {
          other.vx += (dx / d) * 16;
          other.vz += (dz / d) * 16;
          other.vy = Math.max(other.vy, 6.2);
        }
      }
    } else if (p.classId === "marksman") {
      // Recon Pulse
      p.reconActiveMs = RECON_DURATION_MS;
    } else if (p.classId === "warden") {
      // Hardlight Barrier 2.6m ahead
      this.barriers.push({
        id: `bar_${this.eventSeq++}`,
        ownerId: p.id,
        team: p.team,
        x: p.x + fwdX * 2.6,
        y: p.y,
        z: p.z + fwdZ * 2.6,
        yaw: p.yaw,
        hp: BARRIER_MAX_HP,
        maxHp: BARRIER_MAX_HP,
        remainingMs: BARRIER_DURATION_MS,
      });
    }
  }

  private tryFireWeapon(
    shooter: PlayerState,
    input: InputFrame,
    allPlayers: PlayerState[],
    isTeamMode: boolean
  ): void {
    const cls = CLASS_CONFIGS[shooter.classId];
    const weapon = cls.weapon;
    const last = this.lastFireAt.get(shooter.id) ?? -99999;
    if (this.serverTimeMs - last < weapon.fireRateMs) return;

    if (shooter.ammo <= 0) {
      shooter.reloadingMs = weapon.reloadMs;
      return;
    }

    if (!shooter.isBot) {
      const ok = this.antiCheat.recordShot(shooter.id, this.serverTimeMs, weapon.fireRateMs);
      if (!ok) return;
    }

    this.lastFireAt.set(shooter.id, this.serverTimeMs);
    shooter.ammo -= 1;
    if (shooter.ammo === 0) {
      shooter.reloadingMs = weapon.reloadMs;
    }

    const origin = getEyePosition(shooter);
    const spread = input.ads ? weapon.adsSpreadRad : weapon.spreadRad;
    let totalDamageDealt = 0;
    let anyHeadshot = false;
    let killedTarget = false;
    let hitTargetId = "";

    for (let i = 0; i < weapon.pellets; i++) {
      const yawJitter = (Math.random() - 0.5) * 2 * spread;
      const pitchJitter = (Math.random() - 0.5) * 2 * spread;
      const dir = getAimDirection(shooter.yaw + yawJitter, shooter.pitch + pitchJitter);
      const hit = raycastCombat(origin, dir, weapon.range, shooter, allPlayers, this.barriers, isTeamMode);

      this.tracers.push({
        id: this.eventSeq++,
        shooterId: shooter.id,
        team: shooter.team,
        from: origin,
        to: hit.point,
        color: shooter.team === "gold" ? "#F2A900" : shooter.team === "teal" ? "#2fbaa4" : weapon.tracerColor,
        headshot: hit.headshot,
      });

      if (hit.hitBarrierId) {
        const b = this.barriers.find((x) => x.id === hit.hitBarrierId);
        if (b) b.hp = Math.max(0, b.hp - weapon.damage);
      } else if (hit.hitPlayerId) {
        const victim = this.players.get(hit.hitPlayerId);
        if (victim && victim.alive) {
          const dmg = Math.round(weapon.damage * (hit.headshot ? weapon.headshotMult : 1));
          victim.hp -= dmg;
          totalDamageDealt += dmg;
          hitTargetId = victim.id;
          if (hit.headshot) anyHeadshot = true;
          if (!shooter.isBot) {
            this.antiCheat.recordHit(shooter.id, hit.headshot);
          }

          if (victim.hp <= 0) {
            killedTarget = true;
            this.handleKill(shooter, victim, weapon.name, hit.headshot);
          }
        }
      }
    }

    if (totalDamageDealt > 0 && !shooter.isBot) {
      this.pendingHitConfirms.set(shooter.id, {
        targetId: hitTargetId,
        damage: totalDamageDealt,
        headshot: anyHeadshot,
        killed: killedTarget,
      });
    }
  }

  private handleKill(
    killer: PlayerState,
    victim: PlayerState,
    weaponName: string,
    headshot: boolean
  ): void {
    victim.alive = false;
    victim.hp = 0;
    victim.respawnMs = RESPAWN_TIME_MS;
    victim.deaths += 1;

    killer.kills += 1;
    killer.score += headshot ? 15 : 10;

    // Vault Rush bonus for kills near active Vault
    if (this.mode === "vault_rush") {
      const activeNode = this.nodes.find((n) => n.active);
      if (activeNode) {
        const d = Math.hypot(victim.x - activeNode.x, victim.z - activeNode.z);
        if (d <= activeNode.radius * 1.6) {
          killer.score += 10;
        }
      }
    }

    // Core Extraction: victim drops 50% (min 1) of carried cores
    if (this.mode === "core_extraction" && victim.carriedCores > 0) {
      const dropCount = Math.max(1, Math.ceil(victim.carriedCores / 2));
      victim.carriedCores = 0;
      this.cores.push({
        id: `core_${this.eventSeq++}`,
        x: victim.x,
        y: victim.y + 0.5,
        z: victim.z,
        value: dropCount,
        ttlMs: 25_000,
      });
    }

    this.kills.push({
      id: this.eventSeq++,
      killerId: killer.id,
      killerName: killer.name,
      killerTeam: killer.team,
      victimId: victim.id,
      victimName: victim.name,
      victimTeam: victim.team,
      weapon: weaponName,
      headshot,
    });
  }

  private stepObjectives(dtMs: number, allPlayers: PlayerState[]): void {
    const dt = dtMs / 1000;

    // Mode 2: Rotate active Vault every 45s
    if (this.mode === "vault_rush") {
      this.vaultRotateMs -= dtMs;
      if (this.vaultRotateMs <= 0) {
        this.vaultRotateMs = VAULT_ROTATION_MS;
        this.vaultIndex = (this.vaultIndex + 1) % VAULT_SEQUENCE.length;
        const activeId = VAULT_SEQUENCE[this.vaultIndex];
        for (const n of this.nodes) {
          n.active = n.id === activeId;
          n.owner = "neutral";
          n.progress = 0;
          n.contested = false;
        }
      }
    }

    // Evaluate capture presence on each active node
    for (const node of this.nodes) {
      if (!node.active) continue;

      const inside = allPlayers.filter(
        (p) => p.alive && Math.hypot(p.x - node.x, p.z - node.z) <= node.radius && Math.abs(p.y - node.y) < 3.2
      );

      if (this.mode === "vault_rush") {
        // FFA King of the Hill
        if (inside.length === 1) {
          const holder = inside[0];
          node.contested = false;
          node.capturingBy = holder.id;
          node.owner = holder.id;
          node.progress = 100;
        } else if (inside.length > 1) {
          node.contested = true;
          node.capturingBy = null;
        } else {
          node.contested = false;
          node.capturingBy = null;
          node.owner = "neutral";
          node.progress = 0;
        }
      } else {
        // Team capture (-100 = Teal, +100 = Gold)
        const goldIn = inside.filter((p) => p.team === "gold");
        const tealIn = inside.filter((p) => p.team === "teal");

        if (goldIn.length > 0 && tealIn.length > 0) {
          node.contested = true;
          node.capturingBy = null;
        } else if (goldIn.length > 0) {
          node.contested = false;
          node.capturingBy = "gold";
          const rate = 28 + (goldIn.length - 1) * 12;
          const prevOwner = node.owner;
          node.progress = Math.min(100, node.progress + rate * dt);
          if (node.progress >= 100 && prevOwner !== "gold") {
            node.owner = "gold";
            for (const p of goldIn) {
              p.captures += 1;
              p.score += 25;
            }
          } else if (node.progress > 0 && prevOwner === "teal") {
            node.owner = "neutral";
          }
        } else if (tealIn.length > 0) {
          node.contested = false;
          node.capturingBy = "teal";
          const rate = 28 + (tealIn.length - 1) * 12;
          const prevOwner = node.owner;
          node.progress = Math.max(-100, node.progress - rate * dt);
          if (node.progress <= -100 && prevOwner !== "teal") {
            node.owner = "teal";
            for (const p of tealIn) {
              p.captures += 1;
              p.score += 25;
            }
          } else if (node.progress < 0 && prevOwner === "gold") {
            node.owner = "neutral";
          }
        } else {
          node.contested = false;
          node.capturingBy = null;
        }

        // Core Extraction: owned nodes spawn a pickupable Energy Core every 6.5s
        if (this.mode === "core_extraction" && node.owner !== "neutral") {
          node.coreReadyMs -= dtMs;
          if (node.coreReadyMs <= 0 && this.cores.length < 12) {
            node.coreReadyMs = 6500;
            this.cores.push({
              id: `core_${this.eventSeq++}`,
              x: node.x + (Math.random() - 0.5) * 2.2,
              y: node.y + 0.5,
              z: node.z + (Math.random() - 0.5) * 2.2,
              value: 1,
              ttlMs: 30_000,
            });
          }
        }
      }
    }

    // Core Extraction pickups & relay banking
    if (this.mode === "core_extraction") {
      for (const p of allPlayers) {
        if (!p.alive) continue;
        // Pick up nearby cores
        this.cores = this.cores.filter((c) => {
          if (Math.hypot(p.x - c.x, p.z - c.z) <= 1.7 && p.carriedCores < 5) {
            p.carriedCores = Math.min(5, p.carriedCores + c.value);
            return false;
          }
          return true;
        });

        // Bank at team relay
        if (p.carriedCores > 0) {
          const relay = p.team === "gold" ? GOLD_RELAY_POS : TEAL_RELAY_POS;
          if (Math.hypot(p.x - relay.x, p.z - relay.z) <= RELAY_RADIUS) {
            const banked = p.carriedCores;
            p.carriedCores = 0;
            p.captures += banked;
            p.score += banked * 30;
            if (p.team === "gold") this.goldScore += banked;
            else if (p.team === "teal") this.tealScore += banked;
          }
        }
      }
    }

    // Update Overclock state immediately when a team holds all 3 nodes
    if (this.mode === "domination") {
      const goldNodes = this.nodes.filter((n) => n.owner === "gold").length;
      const tealNodes = this.nodes.filter((n) => n.owner === "teal").length;
      this.overclockTeam = goldNodes === 3 ? "gold" : tealNodes === 3 ? "teal" : null;
    }

    // 1-second score ticks for Domination & Vault Rush
    this.scoreTickAccumMs += dtMs;
    if (this.scoreTickAccumMs >= 1000) {
      this.scoreTickAccumMs -= 1000;

      if (this.mode === "domination") {
        const goldNodes = this.nodes.filter((n) => n.owner === "gold").length;
        const tealNodes = this.nodes.filter((n) => n.owner === "teal").length;
        this.goldScore += goldNodes === 3 ? 6 : goldNodes;
        this.tealScore += tealNodes === 3 ? 6 : tealNodes;
      } else if (this.mode === "vault_rush") {
        const active = this.nodes.find((n) => n.active);
        if (active && active.owner !== "neutral" && !active.contested) {
          const holder = this.players.get(active.owner);
          if (holder && holder.alive) {
            holder.score += 3;
            holder.captures += 1;
          }
        }
      }
    }
  }

  private checkMatchEnd(allPlayers: PlayerState[]): void {
    const modeCfg = MODE_CONFIGS[this.mode];
    let ended = this.remainingMs <= 0;
    let winnerTeam: OwnerId = "neutral";
    let winnerLabel = "DRAW";

    if (modeCfg.isTeamMode) {
      if (this.goldScore >= modeCfg.targetScore || this.tealScore >= modeCfg.targetScore) {
        ended = true;
      }
      if (ended) {
        if (this.goldScore > this.tealScore) {
          winnerTeam = "gold";
          winnerLabel = "TEAM GOLD VICTORY";
        } else if (this.tealScore > this.goldScore) {
          winnerTeam = "teal";
          winnerLabel = "TEAM TEAL VICTORY";
        } else {
          winnerLabel = "FOUNDRY DRAW";
        }
      }
    } else {
      const sorted = [...allPlayers].sort((a, b) => b.score - a.score);
      if (sorted[0] && sorted[0].score >= modeCfg.targetScore) {
        ended = true;
      }
      if (ended && sorted[0]) {
        winnerTeam = sorted[0].id;
        winnerLabel = `${sorted[0].name} CLAIMS THE VAULT`;
      }
    }

    if (!ended) return;

    this.phase = "ended";
    const leaderboard = [...allPlayers]
      .sort((a, b) => b.score - a.score || b.kills - a.kills)
      .map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        classId: p.classId,
        isBot: p.isBot,
        kills: p.kills,
        deaths: p.deaths,
        captures: p.captures,
        score: p.score,
      }));

    const mvp = leaderboard[0] ?? { name: "NONE", score: 0 };
    const antiCheatStatus = this.antiCheat.getOverallStatus(allPlayers);
    const sampleHuman = allPlayers.find((p) => !p.isBot) ?? allPlayers[0];
    const won = sampleHuman
      ? modeCfg.isTeamMode
        ? sampleHuman.team === winnerTeam
        : sampleHuman.id === winnerTeam
      : false;

    const reward = sampleHuman
      ? computeMatchReward({
          hasBots: this.hasBots,
          humanCount: this.humanCount,
          player: sampleHuman,
          won,
          antiCheatStatus,
        })
      : {
          isRewardEligible: false,
          reason: "No human players.",
          estimatedGameToken: 0,
          rankedPointsDelta: 0,
        };

    this.matchEnd = {
      mode: this.mode,
      winnerLabel,
      winnerTeam,
      goldScore: this.goldScore,
      tealScore: this.tealScore,
      isRewardEligible: reward.isRewardEligible,
      rewardReason: reward.reason,
      estimatedGameToken: reward.estimatedGameToken,
      rankedPointsDelta: reward.rankedPointsDelta,
      mvpName: mvp.name,
      mvpScore: mvp.score,
      leaderboard,
      antiCheatStatus,
    };
  }

  getSnapshot(): ServerSnapshot {
    return {
      tick: this.tick,
      serverTime: this.serverTimeMs,
      roomId: this.id,
      mode: this.mode,
      phase: this.phase,
      remainingMs: this.remainingMs,
      targetScore: MODE_CONFIGS[this.mode].targetScore,
      goldScore: this.goldScore,
      tealScore: this.tealScore,
      overclockTeam: this.overclockTeam,
      vaultRotateMs: this.vaultRotateMs,
      isRewardEligible: !this.hasBots && this.humanCount >= 2,
      players: Array.from(this.players.values()),
      nodes: this.nodes,
      barriers: this.barriers,
      cores: this.cores,
      tracers: this.tracers,
      kills: this.kills,
      matchEnd: this.matchEnd,
    };
  }
}
