/**
 * KVP-106 Cosmetic Skin Catalog for KOVANICA: FOUNDRY.
 *
 * STRICT INVARIANT (GDD §6.2):
 * Skins are 100% cosmetic (visor/accent glow & tracer tint).
 * Zero weapon damage, fire-rate, HP, hitbox, or movement stat modifiers.
 */

export type SkinId =
  | "standard_foundry"
  | "forged_amber"
  | "teal_circuit"
  | "obsidian_gold"
  | "void_chrome";

export type SkinRarity = "Standard" | "Forged" | "Obsidian Gold";

export interface CosmeticSkin {
  id: SkinId;
  name: string;
  rarity: SkinRarity;
  forgeCost: number;
  accentHex: string;
  tracerHex: string;
  kvp106Collection: "kovanica-foundry-s1";
  description: string;
}

export const SKIN_CATALOG: Record<SkinId, CosmeticSkin> = {
  standard_foundry: {
    id: "standard_foundry",
    name: "Standard Foundry",
    rarity: "Standard",
    forgeCost: 0,
    accentHex: "#e4e4e7",
    tracerHex: "#F2A900",
    kvp106Collection: "kovanica-foundry-s1",
    description: "Default brushed zinc chassis issued to all Operators.",
  },
  forged_amber: {
    id: "forged_amber",
    name: "Forged Amber",
    rarity: "Forged",
    forgeCost: 120,
    accentHex: "#f59e0b",
    tracerHex: "#fbbf24",
    kvp106Collection: "kovanica-foundry-s1",
    description: "Superheated amber kiln trim with golden-amber tracer trails.",
  },
  teal_circuit: {
    id: "teal_circuit",
    name: "Teal Circuit",
    rarity: "Forged",
    forgeCost: 120,
    accentHex: "#2fbaa4",
    tracerHex: "#5eead4",
    kvp106Collection: "kovanica-foundry-s1",
    description: "GHOSTDAG telemetry trace lines etched in luminous teal.",
  },
  obsidian_gold: {
    id: "obsidian_gold",
    name: "Obsidian Gold",
    rarity: "Obsidian Gold",
    forgeCost: 240,
    accentHex: "#F2A900",
    tracerHex: "#fde047",
    kvp106Collection: "kovanica-foundry-s1",
    description: "Matte obsidian plating inlaid with 24k Kovanica gold conduits.",
  },
  void_chrome: {
    id: "void_chrome",
    name: "Void Chrome",
    rarity: "Obsidian Gold",
    forgeCost: 240,
    accentHex: "#38bdf8",
    tracerHex: "#7dd3fc",
    kvp106Collection: "kovanica-foundry-s1",
    description: "High-contrast cold-forged chrome with cryo-blue pulse optics.",
  },
};

export const SKIN_ORDER: readonly SkinId[] = [
  "standard_foundry",
  "forged_amber",
  "teal_circuit",
  "obsidian_gold",
  "void_chrome",
] as const;

export function getSkinById(skinId?: string): CosmeticSkin {
  if (skinId && skinId in SKIN_CATALOG) {
    return SKIN_CATALOG[skinId as SkinId];
  }
  return SKIN_CATALOG.standard_foundry;
}
