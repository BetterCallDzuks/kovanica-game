import {
  ADS_SPEED_MULTIPLIER,
  BARRIER_DEPTH,
  BARRIER_HEIGHT,
  BARRIER_WIDTH,
  BASE_MOVE_SPEED,
  CLASS_CONFIGS,
  EYE_HEIGHT,
  GRAVITY,
  HEAD_MIN_Y,
  JUMP_SPEED,
  MAX_STEP_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPRINT_MULTIPLIER,
} from "./constants";
import { ARENA_BOXES, ARENA_HALF_X, ARENA_HALF_Z, JUMP_PADS } from "./map";
import type { AABB, BarrierState, InputFrame, PlayerState, Vec3 } from "./types";

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function barrierToAABB(b: BarrierState): AABB {
  // Axis-aligned approximation rotated by cardinal/diagonal yaw
  const c = Math.abs(Math.cos(b.yaw));
  const s = Math.abs(Math.sin(b.yaw));
  const halfX = (BARRIER_WIDTH * c + BARRIER_DEPTH * s) * 0.5;
  const halfZ = (BARRIER_WIDTH * s + BARRIER_DEPTH * c) * 0.5;
  return {
    id: b.id,
    minX: b.x - halfX,
    minY: b.y,
    minZ: b.z - halfZ,
    maxX: b.x + halfX,
    maxY: b.y + BARRIER_HEIGHT,
    maxZ: b.z + halfZ,
    kind: "cover",
    accent: b.team === "gold" ? "gold" : "teal",
  };
}

export function stepPlayerPhysics(
  p: PlayerState,
  input: InputFrame,
  dt: number,
  barriers: BarrierState[]
): void {
  if (!p.alive) return;

  const cls = CLASS_CONFIGS[p.classId];
  const moveX = clamp(input.moveX, -1, 1);
  const moveZ = clamp(input.moveZ, -1, 1);
  const mag = Math.hypot(moveX, moveZ);
  const normX = mag > 1 ? moveX / mag : moveX;
  const normZ = mag > 1 ? moveZ / mag : moveZ;

  // Forward direction from yaw (yaw = 0 looks toward -Z, standard Three.js FPS)
  const sinY = Math.sin(input.yaw);
  const cosY = Math.cos(input.yaw);
  const forwardX = -sinY;
  const forwardZ = -cosY;
  const rightX = cosY;
  const rightZ = -sinY;

  let speed = BASE_MOVE_SPEED * cls.speedMult;
  if (input.sprint && !input.ads && normZ > 0.1) {
    speed *= SPRINT_MULTIPLIER;
  } else if (input.ads) {
    speed *= ADS_SPEED_MULTIPLIER;
  }

  const desiredVx = (forwardX * normZ + rightX * normX) * speed;
  const desiredVz = (forwardZ * normZ + rightZ * normX) * speed;

  // Smooth acceleration so dashes / impulse knockbacks carry momentum naturally
  const accel = p.grounded ? 18 : 6.5;
  const blend = clamp(accel * dt, 0, 1);
  p.vx += (desiredVx - p.vx) * blend;
  p.vz += (desiredVz - p.vz) * blend;

  if (input.jump && p.grounded) {
    p.vy = JUMP_SPEED;
    p.grounded = false;
  }

  p.vy -= GRAVITY * dt;
  p.yaw = input.yaw;
  p.pitch = clamp(input.pitch, -1.48, 1.48);

  const colliders: AABB[] = [...ARENA_BOXES];
  for (const b of barriers) {
    if (b.hp > 0 && b.remainingMs > 0) {
      colliders.push(barrierToAABB(b));
    }
  }

  // Horizontal X
  p.x += p.vx * dt;
  resolveHorizontal(p, colliders, "x");

  // Horizontal Z
  p.z += p.vz * dt;
  resolveHorizontal(p, colliders, "z");

  // Vertical Y
  p.y += p.vy * dt;
  p.grounded = false;
  resolveVertical(p, colliders);

  // Arena bounds safety clamp
  p.x = clamp(p.x, -ARENA_HALF_X + PLAYER_RADIUS, ARENA_HALF_X - PLAYER_RADIUS);
  p.z = clamp(p.z, -ARENA_HALF_Z + PLAYER_RADIUS, ARENA_HALF_Z - PLAYER_RADIUS);
  if (p.y < 0) {
    p.y = 0;
    p.vy = 0;
    p.grounded = true;
  }

  // Jump pads
  for (const pad of JUMP_PADS) {
    const dx = p.x - pad.x;
    const dz = p.z - pad.z;
    if (dx * dx + dz * dz <= pad.radius * pad.radius && Math.abs(p.y - pad.y) < 0.7 && p.vy <= 4) {
      p.vy = pad.boostY;
      p.vx += pad.boostX;
      p.vz += pad.boostZ;
      p.grounded = false;
    }
  }
}

function resolveHorizontal(p: PlayerState, colliders: AABB[], axis: "x" | "z"): void {
  const minY = p.y;
  const maxY = p.y + PLAYER_HEIGHT;

  for (const box of colliders) {
    if (box.kind === "floor") continue;
    if (maxY <= box.minY + 0.01 || minY >= box.maxY - 0.01) continue;

    if (
      p.x + PLAYER_RADIUS > box.minX &&
      p.x - PLAYER_RADIUS < box.maxX &&
      p.z + PLAYER_RADIUS > box.minZ &&
      p.z - PLAYER_RADIUS < box.maxZ
    ) {
      // Allow smooth step-up onto ramps / low ledges
      const stepHeight = box.maxY - p.y;
      if (stepHeight > 0 && stepHeight <= MAX_STEP_HEIGHT) {
        p.y = box.maxY;
        p.grounded = true;
        continue;
      }

      if (axis === "x") {
        if (p.vx > 0) p.x = box.minX - PLAYER_RADIUS;
        else if (p.vx < 0) p.x = box.maxX + PLAYER_RADIUS;
        else {
          const dLeft = Math.abs(p.x - (box.minX - PLAYER_RADIUS));
          const dRight = Math.abs(p.x - (box.maxX + PLAYER_RADIUS));
          p.x = dLeft < dRight ? box.minX - PLAYER_RADIUS : box.maxX + PLAYER_RADIUS;
        }
        p.vx = 0;
      } else {
        if (p.vz > 0) p.z = box.minZ - PLAYER_RADIUS;
        else if (p.vz < 0) p.z = box.maxZ + PLAYER_RADIUS;
        else {
          const dBack = Math.abs(p.z - (box.minZ - PLAYER_RADIUS));
          const dFront = Math.abs(p.z - (box.maxZ + PLAYER_RADIUS));
          p.z = dBack < dFront ? box.minZ - PLAYER_RADIUS : box.maxZ + PLAYER_RADIUS;
        }
        p.vz = 0;
      }
    }
  }
}

function resolveVertical(p: PlayerState, colliders: AABB[]): void {
  for (const box of colliders) {
    if (
      p.x + PLAYER_RADIUS <= box.minX ||
      p.x - PLAYER_RADIUS >= box.maxX ||
      p.z + PLAYER_RADIUS <= box.minZ ||
      p.z - PLAYER_RADIUS >= box.maxZ
    ) {
      continue;
    }

    if (p.y < box.maxY && p.y + PLAYER_HEIGHT > box.minY) {
      if (p.vy <= 0 && p.y >= box.maxY - 0.9) {
        p.y = box.maxY;
        p.vy = 0;
        p.grounded = true;
      } else if (p.vy > 0 && p.y + PLAYER_HEIGHT <= box.minY + 0.9) {
        p.y = box.minY - PLAYER_HEIGHT;
        p.vy = 0;
      }
    }
  }
}

export function getAimDirection(yaw: number, pitch: number): Vec3 {
  const cosP = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosP,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosP,
  };
}

export function getEyePosition(p: PlayerState): Vec3 {
  return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
}

/**
 * Slab method ray vs AABB intersection. Returns distance >= 0 or null.
 */
export function intersectRayAABB(
  origin: Vec3,
  dir: Vec3,
  box: AABB,
  maxDist: number
): number | null {
  let tmin = 0;
  let tmax = maxDist;

  const invX = dir.x !== 0 ? 1 / dir.x : 1e9;
  const tx1 = (box.minX - origin.x) * invX;
  const tx2 = (box.maxX - origin.x) * invX;
  tmin = Math.max(tmin, Math.min(tx1, tx2));
  tmax = Math.min(tmax, Math.max(tx1, tx2));

  const invY = dir.y !== 0 ? 1 / dir.y : 1e9;
  const ty1 = (box.minY - origin.y) * invY;
  const ty2 = (box.maxY - origin.y) * invY;
  tmin = Math.max(tmin, Math.min(ty1, ty2));
  tmax = Math.min(tmax, Math.max(ty1, ty2));

  const invZ = dir.z !== 0 ? 1 / dir.z : 1e9;
  const tz1 = (box.minZ - origin.z) * invZ;
  const tz2 = (box.maxZ - origin.z) * invZ;
  tmin = Math.max(tmin, Math.min(tz1, tz2));
  tmax = Math.min(tmax, Math.max(tz1, tz2));

  if (tmax >= tmin && tmin >= 0 && tmin <= maxDist) {
    return tmin;
  }
  return null;
}

export interface RaycastResult {
  distance: number;
  point: Vec3;
  hitPlayerId?: string;
  hitBarrierId?: string;
  headshot: boolean;
}

export function raycastCombat(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  shooter: PlayerState,
  players: PlayerState[],
  barriers: BarrierState[],
  isTeamMode: boolean
): RaycastResult {
  let closestDist = maxDist;
  let hitPlayerId: string | undefined;
  let hitBarrierId: string | undefined;
  let headshot = false;

  // 1. Static arena geometry
  for (const box of ARENA_BOXES) {
    const t = intersectRayAABB(origin, dir, box, closestDist);
    if (t !== null && t < closestDist) {
      closestDist = t;
    }
  }

  // 2. Active Hardlight Barriers (enemy barriers block shots; friendly barriers let shots pass)
  for (const b of barriers) {
    if (b.hp <= 0 || b.remainingMs <= 0) continue;
    if (isTeamMode && b.team === shooter.team) continue;
    const t = intersectRayAABB(origin, dir, barrierToAABB(b), closestDist);
    if (t !== null && t < closestDist) {
      closestDist = t;
      hitBarrierId = b.id;
      hitPlayerId = undefined;
      headshot = false;
    }
  }

  // 3. Players (slightly generous hitbox radius for crisp web shooter feel)
  const hitRadius = PLAYER_RADIUS * 1.15;
  for (const target of players) {
    if (!target.alive || target.id === shooter.id) continue;
    if (isTeamMode && target.team === shooter.team) continue;

    const pBox: AABB = {
      id: target.id,
      minX: target.x - hitRadius,
      minY: target.y,
      minZ: target.z - hitRadius,
      maxX: target.x + hitRadius,
      maxY: target.y + PLAYER_HEIGHT,
      maxZ: target.z + hitRadius,
      kind: "cover",
    };

    const t = intersectRayAABB(origin, dir, pBox, closestDist);
    if (t !== null && t < closestDist) {
      closestDist = t;
      hitPlayerId = target.id;
      hitBarrierId = undefined;
      const hitY = origin.y + dir.y * t;
      headshot = hitY >= target.y + HEAD_MIN_Y;
    }
  }

  return {
    distance: closestDist,
    point: {
      x: origin.x + dir.x * closestDist,
      y: origin.y + dir.y * closestDist,
      z: origin.z + dir.z * closestDist,
    },
    hitPlayerId,
    hitBarrierId,
    headshot,
  };
}
