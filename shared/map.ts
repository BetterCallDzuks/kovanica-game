import type { AABB, ConduitSegment, JumpPad, NodeDefinition, Vec3 } from "./types";

export const ARENA_HALF_X = 36;
export const ARENA_HALF_Z = 26;
export const ARENA_WALL_HEIGHT = 12;

export const GOLD_RELAY_POS: Vec3 = { x: 0, y: 0, z: 20.5 };
export const TEAL_RELAY_POS: Vec3 = { x: 0, y: 0, z: -20.5 };
export const RELAY_RADIUS = 3.2;

export const CONTROL_NODES: NodeDefinition[] = [
  { id: "A", label: "ALPHA SMELTER", x: -20, y: 0, z: 0, radius: 4.3 },
  { id: "B", label: "BETA CRUCIBLE", x: 0, y: 0, z: 0, radius: 4.8 },
  { id: "C", label: "GAMMA VAULT", x: 20, y: 0, z: 0, radius: 4.3 },
];

export const JUMP_PADS: JumpPad[] = [
  { id: "jp_nw", x: -12, y: 0.05, z: -9, radius: 1.5, boostY: 14.2, boostX: 3.5, boostZ: 2.5 },
  { id: "jp_ne", x: 12, y: 0.05, z: -9, radius: 1.5, boostY: 14.2, boostX: -3.5, boostZ: 2.5 },
  { id: "jp_sw", x: -12, y: 0.05, z: 9, radius: 1.5, boostY: 14.2, boostX: 3.5, boostZ: -2.5 },
  { id: "jp_se", x: 12, y: 0.05, z: 9, radius: 1.5, boostY: 14.2, boostX: -3.5, boostZ: -2.5 },
];

export const GOLD_SPAWNS: Vec3[] = [
  { x: -10, y: 0.1, z: 21 },
  { x: 0, y: 0.1, z: 22.5 },
  { x: 10, y: 0.1, z: 21 },
  { x: -18, y: 0.1, z: 18 },
  { x: 18, y: 0.1, z: 18 },
];

export const TEAL_SPAWNS: Vec3[] = [
  { x: -10, y: 0.1, z: -21 },
  { x: 0, y: 0.1, z: -22.5 },
  { x: 10, y: 0.1, z: -21 },
  { x: -18, y: 0.1, z: -18 },
  { x: 18, y: 0.1, z: -18 },
];

export const FFA_SPAWNS: Vec3[] = [
  { x: -28, y: 0.1, z: -18 },
  { x: 28, y: 0.1, z: -18 },
  { x: -28, y: 0.1, z: 18 },
  { x: 28, y: 0.1, z: 18 },
  { x: 0, y: 0.1, z: 21 },
  { x: 0, y: 0.1, z: -21 },
  { x: -30, y: 0.1, z: 0 },
  { x: 30, y: 0.1, z: 0 },
];

export const FLOOR_CONDUITS: ConduitSegment[] = [
  { nodeId: "A", from: { x: -20, y: 0.04, z: 0 }, to: { x: -20, y: 0.04, z: 15 } },
  { nodeId: "A", from: { x: -20, y: 0.04, z: 0 }, to: { x: -20, y: 0.04, z: -15 } },
  { nodeId: "B", from: { x: 0, y: 0.04, z: 0 }, to: { x: 0, y: 0.04, z: 17 } },
  { nodeId: "B", from: { x: 0, y: 0.04, z: 0 }, to: { x: 0, y: 0.04, z: -17 } },
  { nodeId: "C", from: { x: 20, y: 0.04, z: 0 }, to: { x: 20, y: 0.04, z: 15 } },
  { nodeId: "C", from: { x: 20, y: 0.04, z: 0 }, to: { x: 20, y: 0.04, z: -15 } },
];

function box(
  id: string,
  cx: number,
  minY: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  kind: AABB["kind"],
  accent: AABB["accent"] = "neutral"
): AABB {
  return {
    id,
    minX: cx - sx / 2,
    minY,
    minZ: cz - sz / 2,
    maxX: cx + sx / 2,
    maxY: minY + sy,
    maxZ: cz + sz / 2,
    kind,
    accent,
  };
}

/**
 * THE MINT — SECTOR 01
 * Symmetrical 72m x 52m Dark-Tech Industrial Foundry arena.
 */
export const ARENA_BOXES: AABB[] = [
  // Main floor slab
  box("floor_main", 0, -1, 0, ARENA_HALF_X * 2 + 4, 1, ARENA_HALF_Z * 2 + 4, "floor"),

  // Outer perimeter foundry walls
  box("wall_north", 0, 0, -ARENA_HALF_Z - 1, ARENA_HALF_X * 2 + 4, ARENA_WALL_HEIGHT, 2, "wall", "teal"),
  box("wall_south", 0, 0, ARENA_HALF_Z + 1, ARENA_HALF_X * 2 + 4, ARENA_WALL_HEIGHT, 2, "wall", "gold"),
  box("wall_west", -ARENA_HALF_X - 1, 0, 0, 2, ARENA_WALL_HEIGHT, ARENA_HALF_Z * 2 + 4, "wall"),
  box("wall_east", ARENA_HALF_X + 1, 0, 0, 2, ARENA_WALL_HEIGHT, ARENA_HALF_Z * 2 + 4, "wall"),

  // Team Relay pedestals (Gold = South +Z, Teal = North -Z)
  box("relay_gold_base", GOLD_RELAY_POS.x, 0, GOLD_RELAY_POS.z, 4.6, 0.35, 4.6, "relay_gold", "gold"),
  box("relay_teal_base", TEAL_RELAY_POS.x, 0, TEAL_RELAY_POS.z, 4.6, 0.35, 4.6, "relay_teal", "teal"),

  // Spawn lane bunker shields (prevent direct spawn-to-spawn sniping)
  box("spawn_cover_gold_c", 0, 0, 14.5, 9, 2.7, 1.4, "cover", "gold"),
  box("spawn_cover_teal_c", 0, 0, -14.5, 9, 2.7, 1.4, "cover", "teal"),
  box("spawn_cover_gold_w", -15, 0, 15, 5.5, 2.5, 1.4, "cover", "gold"),
  box("spawn_cover_gold_e", 15, 0, 15, 5.5, 2.5, 1.4, "cover", "gold"),
  box("spawn_cover_teal_w", -15, 0, -15, 5.5, 2.5, 1.4, "cover", "teal"),
  box("spawn_cover_teal_e", 15, 0, -15, 5.5, 2.5, 1.4, "cover", "teal"),

  // Central overhead catwalk bridge spanning West-East above Node B (y = 3.8..4.3)
  box("catwalk_center", 0, 3.8, 0, 22, 0.5, 4.4, "catwalk"),
  // Supporting industrial pillars for the catwalk (also serve as Node B cover)
  box("pillar_mid_nw", -8.5, 0, -3.6, 1.8, 4.3, 1.8, "pillar"),
  box("pillar_mid_ne", 8.5, 0, -3.6, 1.8, 4.3, 1.8, "pillar"),
  box("pillar_mid_sw", -8.5, 0, 3.6, 1.8, 4.3, 1.8, "pillar"),
  box("pillar_mid_se", 8.5, 0, 3.6, 1.8, 4.3, 1.8, "pillar"),

  // Stepped stair-ramps up to West & East catwalk decks (climbable via MAX_STEP_HEIGHT)
  box("step_w_1", -15.2, 0, 0, 2.2, 0.55, 4.0, "ramp"),
  box("step_w_2", -14.0, 0, 0, 2.2, 1.1, 4.0, "ramp"),
  box("step_w_3", -12.8, 0, 0, 2.2, 1.65, 4.0, "ramp"),
  box("step_w_4", -11.6, 0, 0, 2.2, 2.2, 4.0, "ramp"),
  box("step_w_5", -10.4, 0, 0, 2.2, 2.75, 4.0, "ramp"),
  box("step_w_6", -9.4, 0, 0, 2.0, 3.3, 4.0, "ramp"),

  box("step_e_1", 15.2, 0, 0, 2.2, 0.55, 4.0, "ramp"),
  box("step_e_2", 14.0, 0, 0, 2.2, 1.1, 4.0, "ramp"),
  box("step_e_3", 12.8, 0, 0, 2.2, 1.65, 4.0, "ramp"),
  box("step_e_4", 11.6, 0, 0, 2.2, 2.2, 4.0, "ramp"),
  box("step_e_5", 10.4, 0, 0, 2.2, 2.75, 4.0, "ramp"),
  box("step_e_6", 9.4, 0, 0, 2.0, 3.3, 4.0, "ramp"),

  // Mid-lane tactical waist-high & head-high cover monoliths around Node B
  box("cover_b_n", 0, 0, -7.2, 5.2, 1.45, 1.2, "cover"),
  box("cover_b_s", 0, 0, 7.2, 5.2, 1.45, 1.2, "cover"),

  // Node A (Alpha Smelter — West) tactical cover & outer foundry bulkhead
  box("cover_a_n", -20, 0, -6.5, 4.8, 1.6, 1.2, "cover"),
  box("cover_a_s", -20, 0, 6.5, 4.8, 1.6, 1.2, "cover"),
  box("cover_a_outer", -28.5, 0, 0, 2.4, 3.4, 9.0, "pillar"),

  // Node C (Gamma Vault — East) tactical cover & outer foundry bulkhead
  box("cover_c_n", 20, 0, -6.5, 4.8, 1.6, 1.2, "cover"),
  box("cover_c_s", 20, 0, 6.5, 4.8, 1.6, 1.2, "cover"),
  box("cover_c_outer", 28.5, 0, 0, 2.4, 3.4, 9.0, "pillar"),

  // Corner foundry crates / mid-flank sightline breakers
  box("crate_nw", -26, 0, -13, 3.5, 2.2, 3.5, "cover"),
  box("crate_ne", 26, 0, -13, 3.5, 2.2, 3.5, "cover"),
  box("crate_sw", -26, 0, 13, 3.5, 2.2, 3.5, "cover"),
  box("crate_se", 26, 0, 13, 3.5, 2.2, 3.5, "cover"),
];
