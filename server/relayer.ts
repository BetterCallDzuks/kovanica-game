import { createHash } from "node:crypto";
import { SKIN_CATALOG, type SkinId } from "../shared/cosmetics";

export interface RelayerBatchReceipt {
  ok: boolean;
  error?: string;
  txHash?: string;
  sponsoredFeeAtoms: number;
  burnedForge: number;
  mintedAssetId?: string;
  skinId?: SkinId;
  remainingForgeBalance: number;
}

export interface RelayerClaimReceipt {
  ok: boolean;
  error?: string;
  txHash?: string;
  sponsoredFeeAtoms: number;
  claimedForge: number;
  newForgeBalance: number;
}

const SPONSORED_BATCH_FEE_ATOMS = 250_000; // 0.00025 KVNC paid by Foundry relayer
const SPONSORED_CLAIM_FEE_ATOMS = 100_000; // 0.00010 KVNC paid by Foundry relayer

/**
 * Wave A Gasless Relayer for KOVANICA: FOUNDRY (Testnet Beta -> Mainnet).
 *
 * Sponsors gas for:
 * 1. Free-to-play FORGE epoch reward claims (deduplicated per matchHash)
 * 2. Atomic Wave A batches: burn FORGE + mint KVP-106 cosmetic skin NFT
 */
export class WaveAGaslessRelayer {
  private readonly forgeBalances = new Map<string, number>();
  private readonly ownedSkins = new Map<string, Set<SkinId>>();
  private readonly claimedKeys = new Set<string>();

  getForgeBalance(walletAddress: string): number {
    return this.forgeBalances.get(walletAddress) ?? 0;
  }

  getOwnedSkins(walletAddress: string): SkinId[] {
    const owned = this.ownedSkins.get(walletAddress);
    if (!owned) return ["standard_foundry"];
    return Array.from(new Set<SkinId>(["standard_foundry", ...owned]));
  }

  creditForgeBalance(walletAddress: string, amount: number): number {
    if (amount <= 0) return this.getForgeBalance(walletAddress);
    const next = this.getForgeBalance(walletAddress) + amount;
    this.forgeBalances.set(walletAddress, next);
    return next;
  }

  deriveKvp106AssetId(walletAddress: string, skinId: SkinId): string {
    return createHash("sha256")
      .update(`KVP-106:kovanica-foundry-s1:${walletAddress}:${skinId}`)
      .digest("hex");
  }

  claimSponsoredEpochRewards(params: {
    walletAddress: string;
    matchHash: string;
    amount: number;
    sessionKeyActive: boolean;
  }): RelayerClaimReceipt {
    const bal = this.getForgeBalance(params.walletAddress);
    if (!params.sessionKeyActive) {
      return {
        ok: false,
        error: "Active Wave C Session Key required for gasless relayer claim.",
        sponsoredFeeAtoms: 0,
        claimedForge: 0,
        newForgeBalance: bal,
      };
    }
    if (params.amount <= 0) {
      return {
        ok: false,
        error: "Claim amount must be greater than zero.",
        sponsoredFeeAtoms: 0,
        claimedForge: 0,
        newForgeBalance: bal,
      };
    }
    const dedupKey = `${params.walletAddress}:${params.matchHash}`;
    if (this.claimedKeys.has(dedupKey)) {
      return {
        ok: false,
        error: "Epoch reward for this matchHash was already claimed.",
        sponsoredFeeAtoms: 0,
        claimedForge: 0,
        newForgeBalance: bal,
      };
    }

    this.claimedKeys.add(dedupKey);
    const newBal = this.creditForgeBalance(params.walletAddress, params.amount);
    const txHash = createHash("sha256")
      .update(`WAVE_A_CLAIM:${dedupKey}:${params.amount}`)
      .digest("hex");

    return {
      ok: true,
      txHash,
      sponsoredFeeAtoms: SPONSORED_CLAIM_FEE_ATOMS,
      claimedForge: params.amount,
      newForgeBalance: newBal,
    };
  }

  /**
   * Executes an atomic Wave A batch: burn FORGE + mint KVP-106 cosmetic skin NFT.
   */
  craftSkinAtomicBatch(params: {
    walletAddress: string;
    skinId: SkinId;
    sessionKeyActive: boolean;
  }): RelayerBatchReceipt {
    const bal = this.getForgeBalance(params.walletAddress);
    const skin = SKIN_CATALOG[params.skinId];
    if (!skin) {
      return {
        ok: false,
        error: `Unknown KVP-106 skinId: ${params.skinId}`,
        sponsoredFeeAtoms: 0,
        burnedForge: 0,
        remainingForgeBalance: bal,
      };
    }
    if (!params.sessionKeyActive) {
      return {
        ok: false,
        error: "Active Wave C Session Key required for gasless atomic skin crafting.",
        sponsoredFeeAtoms: 0,
        burnedForge: 0,
        remainingForgeBalance: bal,
      };
    }

    const owned = this.ownedSkins.get(params.walletAddress) ?? new Set<SkinId>(["standard_foundry"]);
    if (owned.has(params.skinId)) {
      return {
        ok: false,
        error: `Wallet already owns KVP-106 skin "${skin.name}".`,
        sponsoredFeeAtoms: 0,
        burnedForge: 0,
        remainingForgeBalance: bal,
      };
    }

    if (bal < skin.forgeCost) {
      return {
        ok: false,
        error: `Insufficient FORGE balance (${bal} < ${skin.forgeCost}).`,
        sponsoredFeeAtoms: 0,
        burnedForge: 0,
        remainingForgeBalance: bal,
      };
    }

    // Atomic state transition: deduct FORGE + mint KVP-106 skin
    const nextBal = bal - skin.forgeCost;
    this.forgeBalances.set(params.walletAddress, nextBal);
    owned.add(params.skinId);
    this.ownedSkins.set(params.walletAddress, owned);

    const mintedAssetId = this.deriveKvp106AssetId(params.walletAddress, params.skinId);
    const txHash = createHash("sha256")
      .update(`WAVE_A_BATCH_CRAFT:${params.walletAddress}:${params.skinId}:${mintedAssetId}`)
      .digest("hex");

    return {
      ok: true,
      txHash,
      sponsoredFeeAtoms: SPONSORED_BATCH_FEE_ATOMS,
      burnedForge: skin.forgeCost,
      mintedAssetId,
      skinId: params.skinId,
      remainingForgeBalance: nextBal,
    };
  }
}
