import type { ClassConfig, ClassId, GameModeId } from "./types";

export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

export const PLAYER_RADIUS = 0.42;
export const PLAYER_HEIGHT = 1.85;
export const EYE_HEIGHT = 1.54;
export const HEAD_MIN_Y = 1.32;

export const GRAVITY = 25;
export const JUMP_SPEED = 9.4;
export const BASE_MOVE_SPEED = 7.6;
export const SPRINT_MULTIPLIER = 1.3;
export const ADS_SPEED_MULTIPLIER = 0.72;
export const MAX_STEP_HEIGHT = 0.65;

export const RESPAWN_TIME_MS = 3200;
export const BARRIER_MAX_HP = 250;
export const BARRIER_DURATION_MS = 8000;
export const BARRIER_WIDTH = 3.4;
export const BARRIER_HEIGHT = 2.3;
export const BARRIER_DEPTH = 0.4;

export const RECON_DURATION_MS = 4000;
export const RECON_RADIUS = 24;

export const BOT_MATCH_REWARD_MULTIPLIER = 0;
export const DAILY_GAME_TOKEN_CAP = 250;

export const MODE_CONFIGS: Record<
  GameModeId,
  {
    id: GameModeId;
    name: string;
    subtitle: string;
    durationMs: number;
    targetScore: number;
    isTeamMode: boolean;
    maxPlayers: number;
  }
> = {
  domination: {
    id: "domination",
    name: "Foundry Domination",
    subtitle: "3v3 · Hold Nodes A / B / C · 3-Cap Overclock 2×",
    durationMs: 300_000,
    targetScore: 400,
    isTeamMode: true,
    maxPlayers: 6,
  },
  vault_rush: {
    id: "vault_rush",
    name: "Vault Rush (KOTH)",
    subtitle: "FFA · Rotating High-Value Mint Vault every 45s",
    durationMs: 240_000,
    targetScore: 220,
    isTeamMode: false,
    maxPlayers: 6,
  },
  core_extraction: {
    id: "core_extraction",
    name: "Core Extraction",
    subtitle: "3v3 · Harvest Cores at Nodes & Bank at Team Relay",
    durationMs: 300_000,
    targetScore: 25,
    isTeamMode: true,
    maxPlayers: 6,
  },
};

export const CLASS_CONFIGS: Record<ClassId, ClassConfig> = {
  striker: {
    id: "striker",
    name: "Striker",
    role: "Frontline Capper",
    maxHp: 100,
    speedMult: 1.0,
    weapon: {
      name: "Foundry AR",
      damage: 20,
      headshotMult: 1.65,
      fireRateMs: 115,
      magSize: 28,
      reloadMs: 1450,
      spreadRad: 0.016,
      adsSpreadRad: 0.005,
      range: 90,
      pellets: 1,
      automatic: true,
      tracerColor: "#F2A900",
    },
    abilityName: "Vector Dash",
    abilityDescription: "Burst forward along your movement direction to cross lanes or dive onto a node.",
    abilityCooldownMs: 7000,
    accentHex: "#F2A900",
  },
  breacher: {
    id: "breacher",
    name: "Breacher",
    role: "CQB Node Breaker",
    maxHp: 115,
    speedMult: 1.08,
    weapon: {
      name: "Vortex Scatter",
      damage: 13,
      headshotMult: 1.4,
      fireRateMs: 420,
      magSize: 8,
      reloadMs: 1650,
      spreadRad: 0.068,
      adsSpreadRad: 0.044,
      range: 34,
      pellets: 6,
      automatic: false,
      tracerColor: "#fb923c",
    },
    abilityName: "Kinetic Impulse",
    abilityDescription: "Surge forward and emit a shockwave that knocks nearby enemies off capture rings.",
    abilityCooldownMs: 8000,
    accentHex: "#fb923c",
  },
  marksman: {
    id: "marksman",
    name: "Marksman",
    role: "High-Ground Overwatcher",
    maxHp: 85,
    speedMult: 0.96,
    weapon: {
      name: "GHOSTDAG Rail",
      damage: 54,
      headshotMult: 2.0,
      fireRateMs: 680,
      magSize: 6,
      reloadMs: 1800,
      spreadRad: 0.012,
      adsSpreadRad: 0.001,
      range: 120,
      pellets: 1,
      automatic: false,
      tracerColor: "#2fbaa4",
    },
    abilityName: "Recon Pulse",
    abilityDescription: "Scan 24m around you for 4s, highlighting enemies through walls for your team.",
    abilityCooldownMs: 12000,
    accentHex: "#2fbaa4",
  },
  warden: {
    id: "warden",
    name: "Warden",
    role: "Point Anchor",
    maxHp: 130,
    speedMult: 0.91,
    weapon: {
      name: "Aegis Carbine",
      damage: 24,
      headshotMult: 1.55,
      fireRateMs: 165,
      magSize: 24,
      reloadMs: 1600,
      spreadRad: 0.013,
      adsSpreadRad: 0.004,
      range: 85,
      pellets: 1,
      automatic: true,
      tracerColor: "#38bdf8",
    },
    abilityName: "Hardlight Barrier",
    abilityDescription: "Deploy a 250 HP translucent energy shield in front of you for 8s.",
    abilityCooldownMs: 11000,
    accentHex: "#38bdf8",
  },
};

export const CLASS_ORDER: ClassId[] = ["striker", "breacher", "marksman", "warden"];
