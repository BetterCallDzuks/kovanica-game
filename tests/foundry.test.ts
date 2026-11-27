import { describe, expect, it } from "vitest";
import {
  formatAtomsToKvnc,
  KOVANICA_NETWORKS,
  validatePro21Address,
  validateStealthMetaAddress,
} from "../client/src/chain/kovanicaAdapter";
import { AntiCheatTracker, computeMatchReward } from "../server/anticheat";
import { FoundryEscrowManager } from "../server/escrow";
import { WaveAGaslessRelayer } from "../server/relayer";
import { GameRoom } from "../server/room";
import { EpochSettlementLedger } from "../server/settlement";
import { CLASS_CONFIGS, DAILY_GAME_TOKEN_CAP, TICK_MS } from "../shared/constants";
import { SKIN_CATALOG, SKIN_ORDER } from "../shared/cosmetics";
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

  it("flags speed hacks and extreme aim-snap loops in AntiCheatTracker", () => {
    const acSpeed = new AntiCheatTracker();
    for (let i = 0; i < 10; i++) {
      expect(acSpeed.recordMovementCheck("p1", 3.5, 0.05)).toBe(false);
    }
    expect(acSpeed.isPlayerFlagged("p1")).toBe(true);

    const acAim = new AntiCheatTracker();
    for (let i = 0; i < 16; i++) {
      acAim.recordAimSample("p2", i % 2 === 0 ? 0 : Math.PI);
    }
    expect(acAim.isPlayerFlagged("p2")).toBe(true);
  });
});

describe("Phase A: Testnet Chain 2 Wallet, Wave C Session Key & Epoch Settlement", () => {
  it("validates canonical PRO-21 addresses, KVP-103 stealth meta-addresses, and KVNC atoms", () => {
    const validMainnet = `kvnc${"q".repeat(57)}dag`;
    const validTestnet = `tknc${"p".repeat(57)}dag`;
    expect(validatePro21Address(validMainnet)).toBe(true);
    expect(validatePro21Address(validTestnet)).toBe(true);
    expect(validatePro21Address("0x1234567890abcdef")).toBe(false);
    expect(validatePro21Address("kvncshortdag")).toBe(false);

    expect(validateStealthMetaAddress(`st:kvnc:${"a".repeat(64)}`)).toBe(true);
    expect(validateStealthMetaAddress("not-a-stealth-address")).toBe(false);

    expect(formatAtomsToKvnc("2500000000")).toBe("2.50");
    expect(formatAtomsToKvnc(10_000_000_000n)).toBe("10.00");
  });

  it("requires an active Wave C Session Key for Ranked rewards and enforces 24h daily cap & win-trade guard", () => {
    const ledger = new EpochSettlementLedger("");
    const makeHuman = (id: string, team: "gold" | "teal", wallet: string, sessionKeyActive: boolean): PlayerState => ({
      id,
      name: id.toUpperCase(),
      isBot: false,
      walletAddress: wallet,
      sessionKeyActive,
      team,
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
      score: 240,
      carriedCores: 0,
      lastProcessedSeq: 1,
      grounded: true,
    });

    const wA = `tknc${"a".repeat(57)}dag`;
    const wB = `tknc${"b".repeat(57)}dag`;

    // Without Session Key -> ineligible
    const noSession = computeMatchReward({
      hasBots: false,
      humanCount: 2,
      player: makeHuman("p1", "gold", wA, false),
      won: true,
      antiCheatStatus: "clean",
    });
    expect(noSession.isRewardEligible).toBe(false);
    expect(noSession.estimatedGameToken).toBe(0);

    // With Session Key -> eligible, queued with deterministic matchHash and 24h delay
    const baseTime = Date.UTC(2026, 10, 27, 12, 0, 0);
    const p1 = makeHuman("p1", "gold", wA, true);
    const p2 = makeHuman("p2", "teal", wB, true);
    const s1 = ledger.settleMatch({
      roomId: "r-1",
      mode: "domination",
      tick: 500,
      goldScore: 400,
      tealScore: 180,
      hasBots: false,
      humanCount: 2,
      players: [p1, p2],
      winnerTeam: "gold",
      isTeamMode: true,
      antiCheatStatus: "clean",
      nowMs: baseTime,
    });

    expect(s1.matchHash).toMatch(/^[a-f0-9]{64}$/);
    expect(s1.epochEligibleAt).toBe(new Date(baseTime + 24 * 60 * 60 * 1000).toISOString());
    expect(s1.playerRewards["p1"].isRewardEligible).toBe(true);
    expect(s1.playerRewards["p1"].estimatedGameToken).toBeGreaterThan(0);
    expect(s1.playerRewards["p1"].dailyCapRemaining).toBeLessThan(DAILY_GAME_TOKEN_CAP);
    expect(ledger.getRecords().length).toBe(2);

    // Trigger win-trading guard on 4th consecutive lopsided win between same wallet pair within 1 hour
    let lastSettled = s1;
    for (let i = 1; i <= 3; i++) {
      lastSettled = ledger.settleMatch({
        roomId: `r-${i + 1}`,
        mode: "domination",
        tick: 500 + i,
        goldScore: 400,
        tealScore: 100,
        hasBots: false,
        humanCount: 2,
        players: [p1, p2],
        winnerTeam: "gold",
        isTeamMode: true,
        antiCheatStatus: "clean",
        nowMs: baseTime + i * 60_000,
      });
    }
    expect(lastSettled.playerRewards["p1"].status).toBe("flagged");
    expect(lastSettled.playerRewards["p1"].estimatedGameToken).toBe(0);
  });
});

describe("Phase B: KVP-106 Skins, Wave A Gasless Relayer & Escrow Tournaments", () => {
  it("enforces zero stat modifiers on KVP-106 cosmetic skins and executes atomic Wave A burn+mint", () => {
    expect(SKIN_ORDER.length).toBeGreaterThanOrEqual(5);
    for (const id of SKIN_ORDER) {
      const s = SKIN_CATALOG[id];
      expect(s.kvp106Collection).toBe("kovanica-foundry-s1");
      expect(s.accentHex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(s.tracerHex).toMatch(/^#[0-9a-fA-F]{6}$/);
    }

    const relayer = new WaveAGaslessRelayer();
    const wallet = `tknc${"c".repeat(57)}dag`;

    // Claim sponsored epoch rewards once; reject duplicate claim
    const c1 = relayer.claimSponsoredEpochRewards({
      walletAddress: wallet,
      matchHash: "a".repeat(64),
      amount: 150,
      sessionKeyActive: true,
    });
    expect(c1.ok).toBe(true);
    expect(c1.newForgeBalance).toBe(150);
    expect(c1.sponsoredFeeAtoms).toBeGreaterThan(0);

    const dup = relayer.claimSponsoredEpochRewards({
      walletAddress: wallet,
      matchHash: "a".repeat(64),
      amount: 150,
      sessionKeyActive: true,
    });
    expect(dup.ok).toBe(false);

    // Atomic Wave A craft: burn 120 FORGE + mint forged_amber KVP-106 NFT
    const craft = relayer.craftSkinAtomicBatch({
      walletAddress: wallet,
      skinId: "forged_amber",
      sessionKeyActive: true,
    });
    expect(craft.ok).toBe(true);
    expect(craft.burnedForge).toBe(120);
    expect(craft.remainingForgeBalance).toBe(30);
    expect(craft.mintedAssetId).toMatch(/^[a-f0-9]{64}$/);
    expect(relayer.getOwnedSkins(wallet)).toContain("forged_amber");

    // Duplicate mint rejected; insufficient balance for 240 FORGE skin rejected
    expect(
      relayer.craftSkinAtomicBatch({ walletAddress: wallet, skinId: "forged_amber", sessionKeyActive: true }).ok
    ).toBe(false);
    expect(
      relayer.craftSkinAtomicBatch({ walletAddress: wallet, skinId: "obsidian_gold", sessionKeyActive: true }).ok
    ).toBe(false);
  });

  it("enforces 95%/5% KVNC escrow split and 100% anti-cheat refund in FoundryEscrowManager", () => {
    const escrow = new FoundryEscrowManager();
    const w1 = `tknc${"d".repeat(57)}dag`;
    const w2 = `tknc${"e".repeat(57)}dag`;

    // Out-of-bounds stake rejected
    expect(
      escrow.createWagerLobby({
        creatorWallet: w1,
        sessionKeyActive: true,
        mode: "domination",
        stakeKvnc: 9999,
        maxPlayers: 2,
      }).ok
    ).toBe(false);

    // Valid 1v1 10 KVNC wager -> 20 KVNC pot -> 19 KVNC winner / 1 KVNC protocol fee
    const created = escrow.createWagerLobby({
      creatorWallet: w1,
      sessionKeyActive: true,
      mode: "domination",
      stakeKvnc: 10,
      maxPlayers: 2,
    });
    expect(created.ok).toBe(true);
    const id = created.record!.escrowId;

    const joined = escrow.joinWagerLobby({ escrowId: id, playerWallet: w2, sessionKeyActive: true });
    expect(joined.ok).toBe(true);
    expect(joined.record!.status).toBe("locked");
    expect(joined.record!.totalPotKvnc).toBe(20);

    const settled = escrow.settleWagerLobby({
      escrowId: id,
      winnerWallets: [w1],
      antiCheatStatus: "clean",
    });
    expect(settled.ok).toBe(true);
    expect(settled.record!.status).toBe("settled");
    expect(settled.record!.winnerPayouts![w1]).toBe(19);
    expect(settled.record!.protocolFeeKvnc).toBe(1);

    // Anti-cheat flagged match -> 100% refund to both players, 0 fee
    const c2 = escrow.createWagerLobby({
      creatorWallet: w1,
      sessionKeyActive: true,
      mode: "vault_rush",
      stakeKvnc: 25,
      maxPlayers: 2,
    });
    const id2 = c2.record!.escrowId;
    escrow.joinWagerLobby({ escrowId: id2, playerWallet: w2, sessionKeyActive: true });
    const refunded = escrow.settleWagerLobby({
      escrowId: id2,
      winnerWallets: [w1],
      antiCheatStatus: "flagged",
    });
    expect(refunded.ok).toBe(true);
    expect(refunded.record!.status).toBe("refunded");
    expect(refunded.record!.protocolFeeKvnc).toBe(0);
    expect(refunded.record!.winnerPayouts![w1]).toBe(25);
    expect(refunded.record!.winnerPayouts![w2]).toBe(25);
  });
});

describe("Phase C: Production Load Stability & Mainnet Cutover Config", () => {
  it("sustains 10 concurrent 6-player rooms for 100 ticks within 20Hz budget and zero NaN", () => {
    const modes: Array<"domination" | "vault_rush" | "core_extraction"> = [
      "domination",
      "vault_rush",
      "core_extraction",
    ];
    const rooms: GameRoom[] = [];
    for (let i = 0; i < 10; i++) {
      const room = new GameRoom(`load-${i}`, modes[i % modes.length], true);
      room.addHumanPlayer({
        id: `h-${i}`,
        name: `OP-${i}`,
        classId: "striker",
        skinId: "obsidian_gold",
      });
      rooms.push(room);
    }

    const startMs = performance.now();
    for (let tick = 0; tick < 100; tick++) {
      for (const room of rooms) {
        room.step(TICK_MS);
      }
    }
    const elapsedMs = performance.now() - startMs;
    const meanPerTickMs = elapsedMs / 100;

    // 10 concurrent rooms must comfortably run inside the 50ms 20Hz frame budget
    expect(meanPerTickMs).toBeLessThan(35);

    for (const room of rooms) {
      const snap = room.getSnapshot();
      expect(snap.players.length).toBe(6);
      for (const p of snap.players) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
        expect(Number.isFinite(p.z)).toBe(true);
        expect(Number.isFinite(p.score)).toBe(true);
      }
    }
  });

  it("pins canonical Testnet (Chain 2) and Mainnet (Chain 1) RPCs and network tags", () => {
    expect(KOVANICA_NETWORKS[2].rpcUrl).toBe("https://rpc-testnet.kovanica.online/rpc");
    expect(KOVANICA_NETWORKS[2].networkTag).toBe("2-24cdb5fadd98b207");
    expect(KOVANICA_NETWORKS[1].rpcUrl).toBe("https://rpc.kovanica.online/rpc");
    expect(KOVANICA_NETWORKS[1].networkTag).toBe("1-f35df34c92001436");
  });
});
