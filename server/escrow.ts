import { createHash } from "node:crypto";
import type { GameModeId } from "../shared/types";

export const MIN_ESCROW_STAKE_KVNC = 1;
export const MAX_ESCROW_STAKE_KVNC = 500;
export const ESCROW_WINNER_BPS = 9500; // 95%
export const ESCROW_PROTOCOL_FEE_BPS = 500; // 5%

export interface EscrowLobbyRecord {
  escrowId: string;
  mode: GameModeId;
  stakeKvnc: number;
  maxPlayers: number;
  participants: string[];
  totalPotKvnc: number;
  status: "open" | "locked" | "settled" | "refunded";
  createdAt: string;
  settlementTxHash?: string;
  winnerPayouts?: Record<string, number>;
  protocolFeeKvnc?: number;
}

export interface EscrowSettlementResult {
  ok: boolean;
  error?: string;
  record?: EscrowLobbyRecord;
}

/**
 * Trustless Opt-In Skill Wager & Tournament Escrow Manager (EscrowClient bridge).
 *
 * GDD §6.1 Invariants:
 * - Winner(s) take 95% of escrowed KVNC pot; 5% protocol fee recycles into
 *   Free Ranked pool & FORGE buyback/burn.
 * - Any match flagged by Anti-Cheat triggers a 100% refund to all participants.
 */
export class FoundryEscrowManager {
  private readonly lobbies = new Map<string, EscrowLobbyRecord>();
  private seq = 1;

  createWagerLobby(params: {
    creatorWallet: string;
    sessionKeyActive: boolean;
    mode: GameModeId;
    stakeKvnc: number;
    maxPlayers: number;
  }): EscrowSettlementResult {
    if (!params.creatorWallet || !params.sessionKeyActive) {
      return {
        ok: false,
        error: "Connected wallet and active Wave C Session Key required to create a wager lobby.",
      };
    }
    if (
      !Number.isFinite(params.stakeKvnc) ||
      params.stakeKvnc < MIN_ESCROW_STAKE_KVNC ||
      params.stakeKvnc > MAX_ESCROW_STAKE_KVNC
    ) {
      return {
        ok: false,
        error: `Stake must be between ${MIN_ESCROW_STAKE_KVNC} and ${MAX_ESCROW_STAKE_KVNC} KVNC.`,
      };
    }
    if (params.maxPlayers < 2 || params.maxPlayers > 6 || params.maxPlayers % 2 !== 0) {
      return {
        ok: false,
        error: "Wager lobbies support 2, 4, or 6 human players.",
      };
    }

    const escrowId = `escrow_${this.seq++}_${createHash("sha256")
      .update(`${params.creatorWallet}:${Date.now()}:${this.seq}`)
      .digest("hex")
      .slice(0, 8)}`;

    const record: EscrowLobbyRecord = {
      escrowId,
      mode: params.mode,
      stakeKvnc: params.stakeKvnc,
      maxPlayers: params.maxPlayers,
      participants: [params.creatorWallet],
      totalPotKvnc: params.stakeKvnc,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    this.lobbies.set(escrowId, record);
    return { ok: true, record };
  }

  joinWagerLobby(params: {
    escrowId: string;
    playerWallet: string;
    sessionKeyActive: boolean;
  }): EscrowSettlementResult {
    const rec = this.lobbies.get(params.escrowId);
    if (!rec) return { ok: false, error: "Escrow lobby not found." };
    if (rec.status !== "open") return { ok: false, error: `Escrow lobby is already ${rec.status}.` };
    if (!params.playerWallet || !params.sessionKeyActive) {
      return { ok: false, error: "Connected wallet and active Wave C Session Key required." };
    }
    if (rec.participants.includes(params.playerWallet)) {
      return { ok: false, error: "Wallet is already staked in this escrow lobby." };
    }

    rec.participants.push(params.playerWallet);
    rec.totalPotKvnc = Number((rec.participants.length * rec.stakeKvnc).toFixed(6));
    if (rec.participants.length >= rec.maxPlayers) {
      rec.status = "locked";
    }
    return { ok: true, record: rec };
  }

  settleWagerLobby(params: {
    escrowId: string;
    winnerWallets: string[];
    antiCheatStatus: "clean" | "flagged";
  }): EscrowSettlementResult {
    const rec = this.lobbies.get(params.escrowId);
    if (!rec) return { ok: false, error: "Escrow lobby not found." };
    if (rec.status === "settled" || rec.status === "refunded") {
      return { ok: false, error: `Escrow lobby already finalized (${rec.status}).` };
    }

    // Anti-cheat flagged or no valid winners -> 100% refund
    const validWinners = params.winnerWallets.filter((w) => rec.participants.includes(w));
    if (params.antiCheatStatus === "flagged" || validWinners.length === 0) {
      const refunds: Record<string, number> = {};
      for (const p of rec.participants) {
        refunds[p] = rec.stakeKvnc;
      }
      rec.status = "refunded";
      rec.protocolFeeKvnc = 0;
      rec.winnerPayouts = refunds;
      rec.settlementTxHash = createHash("sha256")
        .update(`ESCROW_REFUND:${rec.escrowId}:${rec.totalPotKvnc}`)
        .digest("hex");
      return { ok: true, record: rec };
    }

    const winnerPool = Number(((rec.totalPotKvnc * ESCROW_WINNER_BPS) / 10_000).toFixed(6));
    const protocolFee = Number((rec.totalPotKvnc - winnerPool).toFixed(6));
    const perWinner = Number((winnerPool / validWinners.length).toFixed(6));
    const payouts: Record<string, number> = {};
    for (const w of validWinners) {
      payouts[w] = perWinner;
    }

    rec.status = "settled";
    rec.protocolFeeKvnc = protocolFee;
    rec.winnerPayouts = payouts;
    rec.settlementTxHash = createHash("sha256")
      .update(`ESCROW_SETTLE:${rec.escrowId}:${validWinners.join(",")}:${winnerPool}`)
      .digest("hex");

    return { ok: true, record: rec };
  }

  getLobby(escrowId: string): EscrowLobbyRecord | undefined {
    return this.lobbies.get(escrowId);
  }
}
