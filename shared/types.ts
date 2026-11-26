export type TeamId = "gold" | "teal" | "ffa";
export type OwnerId = "neutral" | "gold" | "teal" | string;
export type ClassId = "striker" | "breacher" | "marksman" | "warden";
export type GameModeId = "domination" | "vault_rush" | "core_extraction";
export type CameraMode = "fps" | "tps";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AABB {
  id: string;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  kind: "floor" | "wall" | "cover" | "catwalk" | "ramp" | "pillar" | "relay_gold" | "relay_teal";
  accent?: "gold" | "teal" | "neutral";
}

export interface JumpPad {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  boostY: number;
  boostX: number;
  boostZ: number;
}

export interface NodeDefinition {
  id: "A" | "B" | "C";
  label: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface ConduitSegment {
  nodeId: "A" | "B" | "C";
  from: Vec3;
  to: Vec3;
}

export interface WeaponConfig {
  name: string;
  damage: number;
  headshotMult: number;
  fireRateMs: number;
  magSize: number;
  reloadMs: number;
  spreadRad: number;
  adsSpreadRad: number;
  range: number;
  pellets: number;
  automatic: boolean;
  tracerColor: string;
}

export interface ClassConfig {
  id: ClassId;
  name: string;
  role: string;
  maxHp: number;
  speedMult: number;
  weapon: WeaponConfig;
  abilityName: string;
  abilityDescription: string;
  abilityCooldownMs: number;
  accentHex: string;
}

export interface InputFrame {
  seq: number;
  moveX: number; // -1..1 right
  moveZ: number; // -1..1 forward
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
  fire: boolean;
  ads: boolean;
  reload: boolean;
  ability: boolean;
  desiredClass?: ClassId;
}

export interface PlayerState {
  id: string;
  name: string;
  isBot: boolean;
  walletAddress?: string;
  team: TeamId;
  classId: ClassId;
  queuedClassId: ClassId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  respawnMs: number;
  ammo: number;
  maxAmmo: number;
  reloadingMs: number;
  abilityCooldownMs: number;
  reconActiveMs: number;
  kills: number;
  deaths: number;
  captures: number;
  score: number;
  carriedCores: number;
  lastProcessedSeq: number;
  grounded: boolean;
}

export interface ControlNodeState {
  id: "A" | "B" | "C";
  label: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  active: boolean;
  owner: OwnerId;
  progress: number; // -100..100 for team modes, 0..100 for FFA
  capturingBy: OwnerId | null;
  contested: boolean;
  coreReadyMs: number;
}

export interface BarrierState {
  id: string;
  ownerId: string;
  team: TeamId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  remainingMs: number;
}

export interface CoreDropState {
  id: string;
  x: number;
  y: number;
  z: number;
  value: number;
  ttlMs: number;
}

export interface TracerEvent {
  id: number;
  shooterId: string;
  team: TeamId;
  from: Vec3;
  to: Vec3;
  color: string;
  headshot: boolean;
}

export interface KillEvent {
  id: number;
  killerId: string;
  killerName: string;
  killerTeam: TeamId;
  victimId: string;
  victimName: string;
  victimTeam: TeamId;
  weapon: string;
  headshot: boolean;
}

export interface HitConfirmEvent {
  targetId: string;
  damage: number;
  headshot: boolean;
  killed: boolean;
}

export interface MatchEndSummary {
  mode: GameModeId;
  winnerLabel: string;
  winnerTeam: OwnerId;
  goldScore: number;
  tealScore: number;
  isRewardEligible: boolean;
  rewardReason: string;
  estimatedGameToken: number;
  rankedPointsDelta: number;
  mvpName: string;
  mvpScore: number;
  leaderboard: Array<{
    id: string;
    name: string;
    team: TeamId;
    classId: ClassId;
    isBot: boolean;
    kills: number;
    deaths: number;
    captures: number;
    score: number;
  }>;
  antiCheatStatus: "clean" | "flagged";
}

export interface ServerSnapshot {
  tick: number;
  serverTime: number;
  roomId: string;
  mode: GameModeId;
  phase: "playing" | "ended";
  remainingMs: number;
  targetScore: number;
  goldScore: number;
  tealScore: number;
  overclockTeam: "gold" | "teal" | null;
  vaultRotateMs: number;
  isRewardEligible: boolean;
  players: PlayerState[];
  nodes: ControlNodeState[];
  barriers: BarrierState[];
  cores: CoreDropState[];
  tracers: TracerEvent[];
  kills: KillEvent[];
  matchEnd?: MatchEndSummary;
}

export type ClientMessage =
  | {
      type: "join";
      name: string;
      mode: GameModeId;
      classId: ClassId;
      fillBots: boolean;
      walletAddress?: string;
      sessionKeyActive?: boolean;
    }
  | {
      type: "input";
      frame: InputFrame;
    }
  | {
      type: "rematch";
      mode?: GameModeId;
    };

export type ServerMessage =
  | {
      type: "welcome";
      playerId: string;
      roomId: string;
      mode: GameModeId;
      tickRate: number;
    }
  | {
      type: "snapshot";
      snapshot: ServerSnapshot;
      hitConfirm?: HitConfirmEvent;
    }
  | {
      type: "error";
      message: string;
    };
