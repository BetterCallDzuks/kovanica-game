import * as THREE from "three";
import {
  BARRIER_DEPTH,
  BARRIER_HEIGHT,
  BARRIER_WIDTH,
  CLASS_CONFIGS,
  EYE_HEIGHT,
  RECON_RADIUS,
} from "../../../shared/constants";
import {
  ARENA_BOXES,
  CONTROL_NODES,
  FLOOR_CONDUITS,
  GOLD_RELAY_POS,
  JUMP_PADS,
  RELAY_RADIUS,
  TEAL_RELAY_POS,
} from "../../../shared/map";
import { getAimDirection, intersectRayAABB } from "../../../shared/physics";
import type {
  BarrierState,
  CameraMode,
  ClassId,
  ControlNodeState,
  CoreDropState,
  PlayerState,
  ServerSnapshot,
  TracerEvent,
} from "../../../shared/types";

const COLOR_GOLD = 0xf2a900;
const COLOR_TEAL = 0x2fbaa4;
const COLOR_NEUTRAL = 0xe4e4e7;
const COLOR_CONTESTED = 0xef4444;

interface AvatarRig {
  root: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  accentMat: THREE.MeshStandardMaterial;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  reconRing: THREE.Mesh;
  team: string;
  classId: ClassId;
}

interface NodeVisual {
  ringMat: THREE.MeshBasicMaterial;
  beacon: THREE.Mesh;
  beaconMat: THREE.MeshStandardMaterial;
  conduitMats: THREE.MeshBasicMaterial[];
}

interface ActiveTracer {
  line: THREE.Line;
  mat: THREE.LineBasicMaterial;
  life: number;
}

export class FoundryRenderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private readonly avatars = new Map<string, AvatarRig>();
  private readonly nodeVisuals = new Map<string, NodeVisual>();
  private readonly barrierMeshes = new Map<string, THREE.Mesh>();
  private readonly coreMeshes = new Map<string, THREE.Mesh>();
  private readonly activeTracers: ActiveTracer[] = [];

  // First-person weapon viewmodel attached to camera
  private readonly viewmodelGroup = new THREE.Group();
  private viewmodelAccentMat = new THREE.MeshStandardMaterial({
    color: COLOR_GOLD,
    emissive: COLOR_GOLD,
    emissiveIntensity: 0.7,
    roughness: 0.25,
    metalness: 0.6,
  });
  private recoilKick = 0;
  private walkPhase = 0;

  constructor(container: HTMLElement) {
    this.scene.background = new THREE.Color(0x09090b);
    this.scene.fog = new THREE.FogExp2(0x09090b, 0.0135);

    this.camera = new THREE.PerspectiveCamera(
      78,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.1,
      200
    );
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.setupLighting();
    this.buildArena();
    this.buildViewmodel();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  triggerRecoil(): void {
    this.recoilKick = Math.min(1, this.recoilKick + 0.55);
  }

  private setupLighting(): void {
    const hemi = new THREE.HemisphereLight(0xd4d4d8, 0x18181b, 0.75);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff7ed, 1.05);
    dir.position.set(22, 38, 18);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 4;
    dir.shadow.camera.far = 110;
    dir.shadow.camera.left = -45;
    dir.shadow.camera.right = 45;
    dir.shadow.camera.top = 45;
    dir.shadow.camera.bottom = -45;
    this.scene.add(dir);

    // Subtle Gold & Teal industrial bounce lights at each team's foundry end
    const goldLight = new THREE.PointLight(COLOR_GOLD, 30, 42, 1.5);
    goldLight.position.set(0, 8, 20);
    this.scene.add(goldLight);

    const tealLight = new THREE.PointLight(COLOR_TEAL, 30, 42, 1.5);
    tealLight.position.set(0, 8, -20);
    this.scene.add(tealLight);
  }

  private buildArena(): void {
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x111115,
      roughness: 0.85,
      metalness: 0.25,
    });
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x18181d,
      roughness: 0.75,
      metalness: 0.35,
    });
    const coverMat = new THREE.MeshStandardMaterial({
      color: 0x222229,
      roughness: 0.65,
      metalness: 0.45,
    });
    const catwalkMat = new THREE.MeshStandardMaterial({
      color: 0x27272f,
      roughness: 0.5,
      metalness: 0.65,
    });
    const rampMat = new THREE.MeshStandardMaterial({
      color: 0x1e1e26,
      roughness: 0.6,
      metalness: 0.5,
    });

    for (const b of ARENA_BOXES) {
      const sx = b.maxX - b.minX;
      const sy = b.maxY - b.minY;
      const sz = b.maxZ - b.minZ;
      const cx = (b.minX + b.maxX) * 0.5;
      const cy = (b.minY + b.maxY) * 0.5;
      const cz = (b.minZ + b.maxZ) * 0.5;

      let mat = coverMat;
      if (b.kind === "floor") mat = floorMat;
      else if (b.kind === "wall") mat = wallMat;
      else if (b.kind === "catwalk") mat = catwalkMat;
      else if (b.kind === "ramp") mat = rampMat;

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      mesh.position.set(cx, cy, cz);
      mesh.receiveShadow = true;
      if (b.kind !== "floor") mesh.castShadow = true;
      this.scene.add(mesh);

      // Subtle glowing trim strip on accented foundry blocks
      if (b.accent && b.accent !== "neutral" && b.kind !== "wall") {
        const trimColor = b.accent === "gold" ? COLOR_GOLD : COLOR_TEAL;
        const trim = new THREE.Mesh(
          new THREE.BoxGeometry(sx + 0.06, 0.12, sz + 0.06),
          new THREE.MeshBasicMaterial({ color: trimColor })
        );
        trim.position.set(cx, b.maxY - 0.12, cz);
        this.scene.add(trim);
      }
    }

    // Crisp tactical floor grid
    const grid = new THREE.GridHelper(76, 38, 0x27272a, 0x18181b);
    grid.position.y = 0.02;
    this.scene.add(grid);

    // Team Relays (Gold & Teal glowing rings)
    this.addRelayRing(GOLD_RELAY_POS.x, GOLD_RELAY_POS.z, COLOR_GOLD);
    this.addRelayRing(TEAL_RELAY_POS.x, TEAL_RELAY_POS.z, COLOR_TEAL);

    // Jump Pads
    for (const pad of JUMP_PADS) {
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(pad.radius, pad.radius * 1.1, 0.14, 16),
        new THREE.MeshStandardMaterial({
          color: 0x0f172a,
          emissive: 0x38bdf8,
          emissiveIntensity: 0.75,
          roughness: 0.3,
        })
      );
      base.position.set(pad.x, pad.y, pad.z);
      this.scene.add(base);
    }

    // Control Nodes A / B / C + Dynamic Floor Conduits
    for (const node of CONTROL_NODES) {
      const ringGeo = new THREE.RingGeometry(node.radius - 0.25, node.radius, 40);
      const ringMat = new THREE.MeshBasicMaterial({
        color: COLOR_NEUTRAL,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(node.x, 0.06, node.z);
      this.scene.add(ring);

      const beaconMat = new THREE.MeshStandardMaterial({
        color: COLOR_NEUTRAL,
        emissive: COLOR_NEUTRAL,
        emissiveIntensity: 0.9,
        roughness: 0.2,
        metalness: 0.4,
      });
      const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.65, 0), beaconMat);
      beacon.position.set(node.x, 2.5, node.z);
      this.scene.add(beacon);

      const conduitMats: THREE.MeshBasicMaterial[] = [];
      for (const seg of FLOOR_CONDUITS.filter((c) => c.nodeId === node.id)) {
        const len = Math.hypot(seg.to.x - seg.from.x, seg.to.z - seg.from.z);
        const cMat = new THREE.MeshBasicMaterial({ color: 0x3f3f46 });
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.04, len), cMat);
        strip.position.set((seg.from.x + seg.to.x) * 0.5, 0.03, (seg.from.z + seg.to.z) * 0.5);
        this.scene.add(strip);
        conduitMats.push(cMat);
      }

      this.nodeVisuals.set(node.id, { ringMat, beacon, beaconMat, conduitMats });
    }
  }

  private addRelayRing(x: number, z: number, color: number): void {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(RELAY_RADIUS - 0.25, RELAY_RADIUS, 32),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.7 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.37, z);
    this.scene.add(ring);
  }

  private buildViewmodel(): void {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1f1f26,
      roughness: 0.35,
      metalness: 0.75,
    });
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.14, 0.56), bodyMat);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.32), bodyMat);
    barrel.position.set(0, 0.02, -0.38);

    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.025, 0.44), this.viewmodelAccentMat);
    rail.position.set(0, 0.08, -0.05);

    this.viewmodelGroup.add(receiver, barrel, rail);
    this.viewmodelGroup.position.set(0.27, -0.24, -0.46);
    this.camera.add(this.viewmodelGroup);
  }

  private createAvatarRig(p: PlayerState): AvatarRig {
    const root = new THREE.Group();
    const teamColor = p.team === "gold" ? COLOR_GOLD : p.team === "teal" ? COLOR_TEAL : 0xf43f5e;
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x27272f,
      roughness: 0.55,
      metalness: 0.35,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: teamColor,
      emissive: teamColor,
      emissiveIntensity: 0.65,
      roughness: 0.25,
      metalness: 0.4,
    });

    // Blocky Roblox-style articulated proportions (total height ~1.82m)
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.68, 0.34), bodyMat);
    torso.position.y = 1.04;
    torso.castShadow = true;

    const chestTrim = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.14, 0.36), accentMat);
    chestTrim.position.y = 1.2;

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.44), bodyMat);
    head.position.y = 1.62;
    head.castShadow = true;

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.14, 0.06), accentMat);
    visor.position.set(0, 1.64, -0.21);

    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.68, 0.26), bodyMat);
    leftLeg.position.set(-0.17, 0.34, 0);
    leftLeg.castShadow = true;

    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.68, 0.26), bodyMat);
    rightLeg.position.set(0.17, 0.34, 0);
    rightLeg.castShadow = true;

    const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.62, 0.22), bodyMat);
    leftArm.position.set(-0.44, 1.04, 0);
    leftArm.castShadow = true;

    const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.62, 0.22), bodyMat);
    rightArm.position.set(0.44, 1.04, -0.08);
    rightArm.rotation.x = Math.PI * 0.35;
    rightArm.castShadow = true;

    // Held 3D blocky weapon
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.62), accentMat);
    gun.position.set(0, -0.26, -0.22);
    rightArm.add(gun);

    // Recon Pulse highlight ring (visible through walls when scanned)
    const reconRing = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.72, 16),
      new THREE.MeshBasicMaterial({
        color: 0x2fbaa4,
        side: THREE.DoubleSide,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      })
    );
    reconRing.position.y = 1.1;
    reconRing.visible = false;

    root.add(torso, chestTrim, head, visor, leftLeg, rightLeg, leftArm, rightArm, reconRing);
    this.scene.add(root);

    return {
      root,
      bodyMat,
      accentMat,
      leftLeg,
      rightLeg,
      leftArm,
      rightArm,
      reconRing,
      team: p.team,
      classId: p.classId,
    };
  }

  addTracers(tracers: TracerEvent[]): void {
    for (const t of tracers) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(t.from.x, t.from.y - 0.08, t.from.z),
        new THREE.Vector3(t.to.x, t.to.y, t.to.z),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(t.color),
        transparent: true,
        opacity: 0.95,
      });
      const line = new THREE.Line(geo, mat);
      this.scene.add(line);
      this.activeTracers.push({ line, mat, life: 0.09 });
    }
  }

  renderFrame(params: {
    dt: number;
    snapshot: ServerSnapshot;
    localPlayer: PlayerState;
    cameraMode: CameraMode;
    ads: boolean;
  }): void {
    const { dt, snapshot, localPlayer, cameraMode, ads } = params;
    const nowSec = performance.now() * 0.001;

    // 1. Update camera (FPS primary vs TPS over-the-shoulder with wall pullback)
    const targetFov = ads ? (localPlayer.classId === "marksman" ? 42 : 60) : 78;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14);
    this.camera.updateProjectionMatrix();

    const eye = { x: localPlayer.x, y: localPlayer.y + EYE_HEIGHT, z: localPlayer.z };
    const aimDir = getAimDirection(localPlayer.yaw, localPlayer.pitch);

    if (cameraMode === "fps") {
      this.camera.position.set(eye.x, eye.y, eye.z);
      this.camera.lookAt(eye.x + aimDir.x * 20, eye.y + aimDir.y * 20, eye.z + aimDir.z * 20);
      this.viewmodelGroup.visible = localPlayer.alive;
    } else {
      // TPS over-the-shoulder offset + raycast pullback so camera never clips inside walls
      const rightX = Math.cos(localPlayer.yaw);
      const rightZ = -Math.sin(localPlayer.yaw);
      const desiredDist = ads ? 2.4 : 4.2;
      const backDir = { x: -aimDir.x, y: -aimDir.y * 0.55 + 0.22, z: -aimDir.z };
      const len = Math.hypot(backDir.x, backDir.y, backDir.z) || 1;
      backDir.x /= len;
      backDir.y /= len;
      backDir.z /= len;

      const shoulderOrigin = {
        x: eye.x + rightX * 0.62,
        y: eye.y + 0.25,
        z: eye.z + rightZ * 0.62,
      };
      let dist = desiredDist;
      for (const box of ARENA_BOXES) {
        const hit = intersectRayAABB(shoulderOrigin, backDir, box, dist);
        if (hit !== null && hit < dist) {
          dist = Math.max(0.75, hit - 0.3);
        }
      }

      this.camera.position.set(
        shoulderOrigin.x + backDir.x * dist,
        shoulderOrigin.y + backDir.y * dist,
        shoulderOrigin.z + backDir.z * dist
      );
      this.camera.lookAt(eye.x + aimDir.x * 40, eye.y + aimDir.y * 40, eye.z + aimDir.z * 40);
      this.viewmodelGroup.visible = false;
    }

    // Animate FPS weapon viewmodel (bob + recoil + class color)
    const speed = Math.hypot(localPlayer.vx, localPlayer.vz);
    this.walkPhase += dt * (speed > 0.8 ? 9.5 : 1.5);
    this.recoilKick = Math.max(0, this.recoilKick - dt * 6.5);
    const clsColor = new THREE.Color(CLASS_CONFIGS[localPlayer.classId].accentHex);
    this.viewmodelAccentMat.color.copy(clsColor);
    this.viewmodelAccentMat.emissive.copy(clsColor);
    const bobX = Math.cos(this.walkPhase) * (speed > 0.8 ? 0.012 : 0.002);
    const bobY = Math.abs(Math.sin(this.walkPhase)) * (speed > 0.8 ? 0.012 : 0.002);
    this.viewmodelGroup.position.set(
      (ads ? 0.04 : 0.26) + bobX,
      (ads ? -0.17 : -0.24) - bobY,
      -0.46 + this.recoilKick * 0.12
    );
    this.viewmodelGroup.rotation.x = this.recoilKick * 0.16;

    // 2. Sync Players
    const reconActive = snapshot.players.some(
      (p) =>
        p.alive &&
        p.reconActiveMs > 0 &&
        (p.id === localPlayer.id || (snapshot.mode !== "vault_rush" && p.team === localPlayer.team))
    );

    const activeIds = new Set<string>();
    for (const p of snapshot.players) {
      activeIds.add(p.id);
      let rig = this.avatars.get(p.id);
      if (!rig || rig.team !== p.team) {
        if (rig) this.scene.remove(rig.root);
        rig = this.createAvatarRig(p);
        this.avatars.set(p.id, rig);
      }

      const isSelf = p.id === localPlayer.id;
      rig.root.visible = p.alive && (!isSelf || cameraMode === "tps");
      const posX = isSelf ? localPlayer.x : p.x;
      const posY = isSelf ? localPlayer.y : p.y;
      const posZ = isSelf ? localPlayer.z : p.z;
      const yaw = isSelf ? localPlayer.yaw : p.yaw;

      rig.root.position.set(posX, posY, posZ);
      rig.root.rotation.y = yaw;

      // Stride animation
      const pSpeed = Math.hypot(p.vx, p.vz);
      const stride = pSpeed > 0.5 ? Math.sin(nowSec * 11 + p.x) * 0.55 : 0;
      rig.leftLeg.rotation.x = stride;
      rig.rightLeg.rotation.x = -stride;
      rig.leftArm.rotation.x = -stride * 0.6;

      // Recon Pulse wall-marker on nearby enemies
      const isEnemy = !isSelf && (snapshot.mode === "vault_rush" || p.team !== localPlayer.team);
      const dist = Math.hypot(posX - localPlayer.x, posZ - localPlayer.z);
      rig.reconRing.visible = reconActive && isEnemy && dist <= RECON_RADIUS;
      if (rig.reconRing.visible) {
        rig.reconRing.lookAt(this.camera.position);
      }
    }

    for (const [id, rig] of this.avatars.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(rig.root);
        this.avatars.delete(id);
      }
    }

    // 3. Sync Control Nodes & Conduits
    for (const n of snapshot.nodes) {
      const vis = this.nodeVisuals.get(n.id);
      if (!vis) continue;
      vis.beacon.visible = n.active;
      vis.ringMat.opacity = n.active ? 0.88 : 0.14;
      const col = this.nodeColor(n);
      vis.ringMat.color.setHex(col);
      vis.beaconMat.color.setHex(col);
      vis.beaconMat.emissive.setHex(col);
      vis.beacon.rotation.y = nowSec * 1.4;
      vis.beacon.position.y = 2.4 + Math.sin(nowSec * 2.5 + n.x) * 0.28;
      for (const cMat of vis.conduitMats) {
        cMat.color.setHex(n.owner === "neutral" ? 0x3f3f46 : col);
      }
    }

    // 4. Sync Hardlight Barriers
    this.syncBarriers(snapshot.barriers);

    // 5. Sync Energy Cores
    this.syncCores(snapshot.cores, nowSec);

    // 6. Decay Tracers
    for (let i = this.activeTracers.length - 1; i >= 0; i--) {
      const tr = this.activeTracers[i];
      tr.life -= dt;
      tr.mat.opacity = Math.max(0, tr.life / 0.09);
      if (tr.life <= 0) {
        this.scene.remove(tr.line);
        tr.line.geometry.dispose();
        tr.mat.dispose();
        this.activeTracers.splice(i, 1);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  private nodeColor(n: ControlNodeState): number {
    if (n.contested) return COLOR_CONTESTED;
    if (n.owner === "gold") return COLOR_GOLD;
    if (n.owner === "teal") return COLOR_TEAL;
    if (n.owner !== "neutral") return COLOR_GOLD;
    return COLOR_NEUTRAL;
  }

  private syncBarriers(barriers: BarrierState[]): void {
    const aliveIds = new Set<string>();
    for (const b of barriers) {
      aliveIds.add(b.id);
      let mesh = this.barrierMeshes.get(b.id);
      if (!mesh) {
        const col = b.team === "gold" ? COLOR_GOLD : COLOR_TEAL;
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(BARRIER_WIDTH, BARRIER_HEIGHT, BARRIER_DEPTH),
          new THREE.MeshStandardMaterial({
            color: col,
            emissive: col,
            emissiveIntensity: 0.7,
            transparent: true,
            opacity: 0.42,
            roughness: 0.2,
          })
        );
        this.scene.add(mesh);
        this.barrierMeshes.set(b.id, mesh);
      }
      mesh.position.set(b.x, b.y + BARRIER_HEIGHT * 0.5, b.z);
      mesh.rotation.y = b.yaw;
    }

    for (const [id, mesh] of this.barrierMeshes.entries()) {
      if (!aliveIds.has(id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.barrierMeshes.delete(id);
      }
    }
  }

  private syncCores(cores: CoreDropState[], nowSec: number): void {
    const aliveIds = new Set<string>();
    for (const c of cores) {
      aliveIds.add(c.id);
      let mesh = this.coreMeshes.get(c.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.42, 0),
          new THREE.MeshStandardMaterial({
            color: COLOR_GOLD,
            emissive: COLOR_GOLD,
            emissiveIntensity: 1.1,
            roughness: 0.15,
          })
        );
        this.scene.add(mesh);
        this.coreMeshes.set(c.id, mesh);
      }
      mesh.position.set(c.x, c.y + Math.sin(nowSec * 4 + c.x) * 0.18, c.z);
      mesh.rotation.y = nowSec * 2.4;
    }

    for (const [id, mesh] of this.coreMeshes.entries()) {
      if (!aliveIds.has(id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.coreMeshes.delete(id);
      }
    }
  }

  dispose(): void {
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
