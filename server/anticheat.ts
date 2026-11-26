import { BOT_MATCH_REWARD_MULTIPLIER, DAILY_GAME_TOKEN_CAP } from "../shared/constants";
import type { PlayerState } from "../shared/types";

export interface PlayerTelemetry {
  shotsFired: number;
  hits: number;
  headshots: number;
  fireRateViolations: number;
  speedViolations: number;
  lastShotAt: number;
}

export class AntiCheatTracker {
  private readonly records = new Map<string, PlayerTelemetry>();

  private getOrCreate(playerId: string): PlayerTelemetry {
    let rec = this.records.get(playerId);
    if (!rec) {
      rec = {
        shotsFired: 0,
        hits: 0,
        headshots: 0,
        fireRateViolations: 0,
        speedViolations: 0,
        lastShotAt: 0,
      };
      this.records.set(playerId, rec);
    }
    return rec;
  }

  recordShot(playerId: string, nowMs: number, minFireRateMs: number): boolean {
    const rec = this.getOrCreate(playerId);
    if (rec.lastShotAt > 0 && nowMs - rec.lastShotAt < minFireRateMs * 0.85) {
      rec.fireRateViolations += 1;
      return false;
    }
    rec.lastShotAt = nowMs;
    rec.shotsFired += 1;
    return true;
  }

  recordHit(playerId: string, headshot: boolean): void {
    const rec = this.getOrCreate(playerId);
    rec.hits += 1;
    if (headshot) rec.headshots += 1;
  }

  isPlayerFlagged(playerId: string): boolean {
    const rec = this.records.get(playerId);
    if (!rec) return false;
    if (rec.fireRateViolations >= 12 || rec.speedViolations >= 10) return true;
    // Impossible headshot streak check (only meaningful after >= 15 hits)
    if (rec.hits >= 15 && rec.headshots / rec.hits > 0.92) return true;
    return false;
  }

  getOverallStatus(players: PlayerState[]): "clean" | "flagged" {
    for (const p of players) {
      if (!p.isBot && this.isPlayerFlagged(p.id)) {
        return "flagged";
      }
    }
    return "clean";
  }

  reset(): void {
    this.records.clear();
  }
}

export interface RewardComputation {
  isRewardEligible: boolean;
  reason: string;
  estimatedGameToken: number;
  rankedPointsDelta: number;
}

/**
 * Enforces GDD anti-bot & zero-P2E-death-spiral reward invariants:
 * - Any match with AI bots pays strictly 0 KVNC and 0 <GAME_TOKEN>.
 * - Human-only verified matches with wallet connected earn capped <GAME_TOKEN>
 *   and Ranked MMR points (settled after 24h epoch review).
 */
export function computeMatchReward(params: {
  hasBots: boolean;
  humanCount: number;
  player: PlayerState;
  won: boolean;
  antiCheatStatus: "clean" | "flagged";
}): RewardComputation {
  if (params.antiCheatStatus === "flagged") {
    return {
      isRewardEligible: false,
      reason: "Match flagged for automated anti-cheat review (0 tokens issued).",
      estimatedGameToken: 0,
      rankedPointsDelta: 0,
    };
  }

  if (params.hasBots || params.humanCount < 2) {
    return {
      isRewardEligible: false,
      reason: "Bot Warmup / Solo Practice — 0 KVNC & 0 <GAME_TOKEN> (connect with human players in Ranked PvP to earn).",
      estimatedGameToken: Math.round(params.player.score * BOT_MATCH_REWARD_MULTIPLIER),
      rankedPointsDelta: 0,
    };
  }

  if (!params.player.walletAddress) {
    return {
      isRewardEligible: false,
      reason: "Guest session — connect your Kovanica wallet + Session Key to bank Ranked KVNC & <GAME_TOKEN>.",
      estimatedGameToken: 0,
      rankedPointsDelta: 0,
    };
  }

  const baseToken = params.won ? 28 : 14;
  const objectiveBonus = Math.min(22, params.player.captures * 5 + Math.floor(params.player.kills * 1.5));
  const estimatedGameToken = Math.min(DAILY_GAME_TOKEN_CAP, baseToken + objectiveBonus);
  const rankedPointsDelta = params.won ? 24 : -10;

  return {
    isRewardEligible: true,
    reason: "Verified Human PvP — queued for 24h epoch settlement (Wave A gasless claim).",
    estimatedGameToken,
    rankedPointsDelta,
  };
}
