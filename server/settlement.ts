import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DAILY_GAME_TOKEN_CAP } from "../shared/constants";
import type { GameModeId, PlayerSettlementReceipt, PlayerState } from "../shared/types";
import { computeMatchReward } from "./anticheat";

export interface SettlementRecord {
  matchHash: string;
  roomId: string;
  mode: GameModeId;
  recordedAt: string;
  eligibleAt: string;
  walletAddress: string;
  stealthMetaAddress?: string;
  playerId: string;
  playerName: string;
  gameTokenAmount: number;
  rankedPointsDelta: number;
  status: "pending_review" | "flagged";
  reason: string;
}

const EPOCH_DELAY_MS = 24 * 60 * 60 * 1000;
const WIN_TRADE_WINDOW_MS = 60 * 60 * 1000;
const WIN_TRADE_THRESHOLD = 4;

export class EpochSettlementLedger {
  private readonly dailyClaimedByWallet = new Map<string, { dayKey: string; total: number }>();
  private readonly pairHistory = new Map<string, number[]>();
  private readonly records: SettlementRecord[] = [];
  private readonly logFilePath?: string;

  constructor(logFilePath?: string) {
    this.logFilePath = logFilePath ?? process.env.FOUNDRY_SETTLEMENT_LOG;
  }

  private getDayKey(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
  }

  getDailyClaimed(walletAddress: string, nowMs = Date.now()): number {
    const entry = this.dailyClaimedByWallet.get(walletAddress);
    const dayKey = this.getDayKey(nowMs);
    if (!entry || entry.dayKey !== dayKey) return 0;
    return entry.total;
  }

  getRemainingDailyCap(walletAddress: string, nowMs = Date.now()): number {
    return Math.max(0, DAILY_GAME_TOKEN_CAP - this.getDailyClaimed(walletAddress, nowMs));
  }

  private addDailyClaim(walletAddress: string, amount: number, nowMs: number): void {
    const dayKey = this.getDayKey(nowMs);
    const current = this.getDailyClaimed(walletAddress, nowMs);
    this.dailyClaimedByWallet.set(walletAddress, { dayKey, total: current + amount });
  }

  /**
   * Detects repeated win-trading loops between the same pair of human wallets
   * within a rolling 60-minute window.
   */
  private checkAndRecordPair(winnerWallet: string, loserWallet: string, nowMs: number): boolean {
    if (winnerWallet === loserWallet) return true;
    const key = `${winnerWallet}->${loserWallet}`;
    const prev = (this.pairHistory.get(key) ?? []).filter((ts) => nowMs - ts <= WIN_TRADE_WINDOW_MS);
    prev.push(nowMs);
    this.pairHistory.set(key, prev);
    return prev.length >= WIN_TRADE_THRESHOLD;
  }

  computeMatchHash(params: {
    roomId: string;
    mode: GameModeId;
    tick: number;
    goldScore: number;
    tealScore: number;
    players: PlayerState[];
  }): string {
    const canonical = JSON.stringify({
      roomId: params.roomId,
      mode: params.mode,
      tick: params.tick,
      goldScore: params.goldScore,
      tealScore: params.tealScore,
      players: params.players
        .map((p) => ({
          id: p.id,
          wallet: p.walletAddress ?? null,
          bot: p.isBot,
          team: p.team,
          k: p.kills,
          d: p.deaths,
          c: p.captures,
          s: p.score,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  settleMatch(params: {
    roomId: string;
    mode: GameModeId;
    tick: number;
    goldScore: number;
    tealScore: number;
    hasBots: boolean;
    humanCount: number;
    players: PlayerState[];
    winnerTeam: string;
    isTeamMode: boolean;
    antiCheatStatus: "clean" | "flagged";
    nowMs?: number;
  }): {
    matchHash: string;
    epochEligibleAt: string;
    playerRewards: Record<string, PlayerSettlementReceipt>;
  } {
    const nowMs = params.nowMs ?? Date.now();
    const matchHash = this.computeMatchHash(params);
    const recordedAt = new Date(nowMs).toISOString();
    const epochEligibleAt = new Date(nowMs + EPOCH_DELAY_MS).toISOString();
    const playerRewards: Record<string, PlayerSettlementReceipt> = {};

    const humanPlayers = params.players.filter((p) => !p.isBot);

    // Check win-trading between winning and losing human wallets
    let winTradeFlagged = false;
    if (!params.hasBots && params.humanCount >= 2 && params.antiCheatStatus === "clean") {
      const winners = humanPlayers.filter((p) =>
        params.isTeamMode ? p.team === params.winnerTeam : p.id === params.winnerTeam
      );
      const losers = humanPlayers.filter((p) => !winners.includes(p));
      for (const w of winners) {
        if (!w.walletAddress) continue;
        for (const l of losers) {
          if (!l.walletAddress) continue;
          if (this.checkAndRecordPair(w.walletAddress, l.walletAddress, nowMs)) {
            winTradeFlagged = true;
          }
        }
      }
    }

    const effectiveAntiCheat: "clean" | "flagged" =
      params.antiCheatStatus === "flagged" || winTradeFlagged ? "flagged" : "clean";

    for (const p of humanPlayers) {
      const won = params.isTeamMode ? p.team === params.winnerTeam : p.id === params.winnerTeam;
      const remainingCap = p.walletAddress
        ? this.getRemainingDailyCap(p.walletAddress, nowMs)
        : DAILY_GAME_TOKEN_CAP;

      const computed = computeMatchReward({
        hasBots: params.hasBots,
        humanCount: params.humanCount,
        player: p,
        won,
        antiCheatStatus: effectiveAntiCheat,
        remainingDailyCap: remainingCap,
        winTradeDetected: winTradeFlagged,
      });

      if (computed.isRewardEligible && p.walletAddress) {
        this.addDailyClaim(p.walletAddress, computed.estimatedGameToken, nowMs);
        const rec: SettlementRecord = {
          matchHash,
          roomId: params.roomId,
          mode: params.mode,
          recordedAt,
          eligibleAt: epochEligibleAt,
          walletAddress: p.walletAddress,
          stealthMetaAddress: p.stealthMetaAddress,
          playerId: p.id,
          playerName: p.name,
          gameTokenAmount: computed.estimatedGameToken,
          rankedPointsDelta: computed.rankedPointsDelta,
          status: "pending_review",
          reason: computed.reason,
        };
        this.records.push(rec);
        this.persistRecord(rec);
      }

      const postRemainingCap = p.walletAddress
        ? this.getRemainingDailyCap(p.walletAddress, nowMs)
        : DAILY_GAME_TOKEN_CAP;

      playerRewards[p.id] = {
        isRewardEligible: computed.isRewardEligible,
        reason: computed.reason,
        estimatedGameToken: computed.estimatedGameToken,
        rankedPointsDelta: computed.rankedPointsDelta,
        dailyCapRemaining: postRemainingCap,
        status: computed.isRewardEligible
          ? "pending_24h_review"
          : effectiveAntiCheat === "flagged"
            ? "flagged"
            : "ineligible",
      };
    }

    return { matchHash, epochEligibleAt, playerRewards };
  }

  private persistRecord(rec: SettlementRecord): void {
    if (!this.logFilePath) return;
    try {
      mkdirSync(dirname(this.logFilePath), { recursive: true });
      appendFileSync(this.logFilePath, `${JSON.stringify(rec)}\n`, "utf8");
    } catch {
      // Non-fatal in dev/test environments with read-only paths
    }
  }

  getRecords(): readonly SettlementRecord[] {
    return this.records;
  }
}
