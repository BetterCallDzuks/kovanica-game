import { describe, expect, it } from "vitest";
import { AntiCheatTracker, computeMatchReward } from "../server/anticheat";
import { GameRoom } from "../server/room";
import { CLASS_CONFIGS, TICK_MS } from "../shared/constants";
import { ARENA_HALF_X, CONTROL_NODES, GOLD_RELAY_POS, JUMP_PADS } from "../shared/map";
import { getEyePosition, raycastCombat, stepPlayerPhysics } from "../shared/physics";
import type { BarrierState, InputFrame, PlayerState } from "../shared/types";

function makeInput(partial: Partial<InputFrame> = {}): InputFrame {
  return {
    seq: 1,
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    jump: false,
    sprint: false,
    fire: false,
    ads: false,
    reload: false,
    ability: false,
    ...partial,
  };
}

describe("Shared Physics & Combat Hit-Reg", () => {
  it("clamps players inside arena bounds and launches on jump pads", () => {
    const room = new GameRoom("test-phys", "domination", false);
    const p = room.addHumanPlayer({ id: "p1", name: "ALPHA", classId: "striker" });

    // Place on jump pad
    const pad = JUMP_PADS[0];
    p.x = pad.x;
    p.y = 0;
    p.z = pad.z;
    p.vy = 0;
    stepPlayerPhysics(p, makeInput(), 0.05, []);
    expect(p.vy).toBeGreaterThan(10);

    // Try walking past east wall
    p.x = ARENA_HALF_X + 10;
    p.y = 0;
    p.z = 0;
    stepPlayerPhysics(p, makeInput({ moveX: 1 }), 0.05, []);
    expect(p.x).toBeLessThanOrEqual(ARENA_HALF_X);
  });

  it("detects headshots vs body shots and respects enemy Hardlight Barriers", () => {
    const room = new GameRoom("test-ray", "domination", false);
    const shooter = room.addHumanPlayer({ id: "s1", name: "SHOOTER", classId: "marksman" });
    const target = room.addHumanPlayer({ id: "t1", name: "TARGET", classId: "striker" });
    shooter.team = "gold";
    target.team = "teal";

    shooter.x = 0;
    shooter.y = 0;
    shooter.z = 5;
    target.x = 0;
    target.y = 0;
    target.z = -5;

    const origin = getEyePosition(shooter);
    // Straight horizontal shot at eye height (1.54m >= HEAD_MIN_Y 1.32m) -> headshot
    const headHit = raycastCombat(origin, { x: 0, y: 0, z: -1 }, 50, shooter, [shooter, target], [], true);
    expect(headHit.hitPlayerId).toBe("t1");
    expect(headHit.headshot).toBe(true);

    // Enemy barrier placed between them blocks the shot
    const barrier: BarrierState = {
      id: "b1",
      ownerId: "t1",
      team: "teal",
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      hp: 250,
      maxHp: 250,
      remainingMs: 5000,
    };
    const blocked = raycastCombat(
      origin,
      { x: 0, y: 0, z: -1 },
      50,
      shooter,
      [shooter, target],
      [barrier],
      true
    );
    expect(blocked.hitBarrierId).toBe("b1");
    expect(blocked.hitPlayerId).toBeUndefined();
  });
});

describe("Authoritative Multi-Mode GameRoom", () => {
  it("Foundry Domination captures nodes and activates Overclock 2x on 3-cap", () => {
    const room = new GameRoom("test-dom", "domination", false);
    const p = room.addHumanPlayer({ id: "p1", name: "CAPPER", classId: "striker" });
    p.team = "gold";

    // Capture all 3 nodes sequentially
    for (const nodeDef of CONTROL_NODES) {
      p.x = nodeDef.x;
      p.y = 0;
      p.z = nodeDef.z;
      room.submitInput(p.id, makeInput());
      for (let i = 0; i < 85; i++) {
        room.step(TICK_MS);
      }
    }

    const snap = room.getSnapshot();
    expect(snap.nodes.every((n) => n.owner === "gold")).toBe(true);
    expect(snap.overclockTeam).toBe("gold");
    expect(snap.goldScore).toBeGreaterThan(0);
  });

  it("Vault Rush (KOTH) keeps 1 active node and awards +3 pts/sec to controller", () => {
    const room = new GameRoom("test-koth", "vault_rush", false);
    const p = room.addHumanPlayer({ id: "p1", name: "VAULTER", classId: "breacher" });
    const activeNode = room.nodes.find((n) => n.active)!;
    expect(room.nodes.filter((n) => n.active).length).toBe(1);

    p.x = activeNode.x;
    p.y = 0;
    p.z = activeNode.z;
    room.submitInput(p.id, makeInput());
    for (let i = 0; i < 45; i++) {
      room.step(TICK_MS);
    }
    expect(p.score).toBeGreaterThanOrEqual(6);
  });

  it("Core Extraction banks carried cores at the team relay", () => {
    const room = new GameRoom("test-core", "core_extraction", false);
    const p = room.addHumanPlayer({ id: "p1", name: "RUNNER", classId: "striker" });
    p.team = "gold";
    p.carriedCores = 3;
    p.x = GOLD_RELAY_POS.x;
    p.y = 0;
    p.z = GOLD_RELAY_POS.z;
    room.submitInput(p.id, makeInput());
    room.step(TICK_MS);

    expect(p.carriedCores).toBe(0);
    expect(room.goldScore).toBe(3);
  });
});

describe("Anti-Cheat & Sustainable Economy Invariants", () => {
  it("pays strictly 0 tokens in bot matches and rewards verified human PvP with wallet", () => {
    const dummyPlayer: PlayerState = {
      id: "p1",
      name: "PRO",
      isBot: false,
      walletAddress: "tkvnc1foundry1234567890ab",
      team: "gold",
      classId: "striker",
      queuedClassId: "striker",
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      hp: 100,
      maxHp: 100,
      alive: true,
      respawnMs: 0,
      ammo: 28,
      maxAmmo: 28,
      reloadingMs: 0,
      abilityCooldownMs: 0,
      reconActiveMs: 0,
      kills: 10,
      deaths: 2,
      captures: 4,
      score: 250,
      carriedCores: 0,
      lastProcessedSeq: 1,
      grounded: true,
    };

    const botReward = computeMatchReward({
      hasBots: true,
      humanCount: 1,
      player: dummyPlayer,
      won: true,
      antiCheatStatus: "clean",
    });
    expect(botReward.isRewardEligible).toBe(false);
    expect(botReward.estimatedGameToken).toBe(0);

    const humanReward = computeMatchReward({
      hasBots: false,
      humanCount: 6,
      player: dummyPlayer,
      won: true,
      antiCheatStatus: "clean",
    });
    expect(humanReward.isRewardEligible).toBe(true);
    expect(humanReward.estimatedGameToken).toBeGreaterThan(0);
    expect(humanReward.rankedPointsDelta).toBeGreaterThan(0);
  });

  it("flags rapid-fire abuse in AntiCheatTracker", () => {
    const ac = new AntiCheatTracker();
    const fireRate = CLASS_CONFIGS.striker.weapon.fireRateMs;
    expect(ac.recordShot("p1", 1000, fireRate)).toBe(true);
    for (let i = 1; i <= 15; i++) {
      expect(ac.recordShot("p1", 1000 + i * 5, fireRate)).toBe(false);
    }
    expect(ac.isPlayerFlagged("p1")).toBe(true);
  });
});
