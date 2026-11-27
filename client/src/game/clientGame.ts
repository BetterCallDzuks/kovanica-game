import { CLASS_ORDER, TICK_MS } from "../../../shared/constants";
import { clamp, stepPlayerPhysics } from "../../../shared/physics";
import type {
  CameraMode,
  ClassId,
  ClientMessage,
  GameModeId,
  HitConfirmEvent,
  InputFrame,
  KillEvent,
  PlayerState,
  ServerMessage,
  ServerSnapshot,
} from "../../../shared/types";
import { FoundryAudio } from "./audio";
import { FoundryRenderer } from "./renderer";

export interface HudCallbacks {
  onSnapshot: (state: {
    snapshot: ServerSnapshot;
    localPlayer: PlayerState;
    cameraMode: CameraMode;
    pointerLocked: boolean;
    scoreboardOpen: boolean;
    killfeed: KillEvent[];
    hitMarker: { active: boolean; headshot: boolean; killed: boolean };
  }) => void;
  onStatus: (text: string) => void;
  onDisconnect: () => void;
}

export class ClientGame {
  private ws: WebSocket | null = null;
  private renderer: FoundryRenderer;
  private audio = new FoundryAudio();
  private callbacks: HudCallbacks;

  private playerId = "";
  private snapshot: ServerSnapshot | null = null;
  private predictedPlayer: PlayerState | null = null;

  private keys = new Set<string>();
  private mouseFire = false;
  private mouseAds = false;
  private touchMoveX = 0;
  private touchMoveZ = 0;
  private touchFire = false;
  private touchJump = false;
  private gamepadCameraWasPressed = false;
  private pendingAbility = false;
  private pendingReload = false;
  private queuedClass: ClassId | undefined;
  private yaw = 0;
  private pitch = 0;
  private seq = 0;
  private cameraMode: CameraMode = "fps";
  private pointerLocked = false;
  private scoreboardOpen = false;
  private sensitivity = 0.0022;

  private killfeed: KillEvent[] = [];
  private hitMarkerUntil = 0;
  private hitMarkerHeadshot = false;
  private hitMarkerKilled = false;

  private rafId = 0;
  private sendInterval = 0;
  private lastFrameMs = 0;
  private disposed = false;

  constructor(container: HTMLElement, callbacks: HudCallbacks) {
    this.renderer = new FoundryRenderer(container);
    this.callbacks = callbacks;
    this.bindEvents();
  }

  setSensitivity(val: number): void {
    this.sensitivity = clamp(val, 0.0006, 0.006);
  }

  setMuted(muted: boolean): void {
    this.audio.muted = muted;
  }

  setTouchInput(partial: {
    moveX?: number;
    moveZ?: number;
    fire?: boolean;
    jump?: boolean;
    ability?: boolean;
    reload?: boolean;
    toggleCamera?: boolean;
    lookDx?: number;
    lookDy?: number;
  }): void {
    if (partial.moveX !== undefined) this.touchMoveX = clamp(partial.moveX, -1, 1);
    if (partial.moveZ !== undefined) this.touchMoveZ = clamp(partial.moveZ, -1, 1);
    if (partial.fire !== undefined) this.touchFire = partial.fire;
    if (partial.jump !== undefined) this.touchJump = partial.jump;
    if (partial.ability) this.pendingAbility = true;
    if (partial.reload) this.pendingReload = true;
    if (partial.toggleCamera) this.cameraMode = this.cameraMode === "fps" ? "tps" : "fps";
    if (partial.lookDx) this.yaw -= partial.lookDx * this.sensitivity * 1.4;
    if (partial.lookDy) this.pitch = clamp(this.pitch - partial.lookDy * this.sensitivity * 1.4, -1.46, 1.46);
  }

  connect(params: {
    wsUrl: string;
    name: string;
    mode: GameModeId;
    classId: ClassId;
    fillBots: boolean;
    walletAddress?: string;
    sessionKeyActive?: boolean;
    stealthMetaAddress?: string;
    skinId?: string;
  }): void {
    this.callbacks.onStatus("Connecting to Foundry Server...");
    const ws = new WebSocket(params.wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      const joinMsg: ClientMessage = {
        type: "join",
        name: params.name,
        mode: params.mode,
        classId: params.classId,
        fillBots: params.fillBots,
        walletAddress: params.walletAddress,
        sessionKeyActive: params.sessionKeyActive,
        stealthMetaAddress: params.stealthMetaAddress,
        skinId: params.skinId,
      };
      ws.send(JSON.stringify(joinMsg));
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === "welcome") {
        this.playerId = msg.playerId;
        this.callbacks.onStatus(`Connected · Room ${msg.roomId}`);
        this.startLoops();
      } else if (msg.type === "snapshot") {
        this.handleSnapshot(msg.snapshot, msg.hitConfirm);
      } else if (msg.type === "error") {
        this.callbacks.onStatus(`Server error: ${msg.message}`);
      }
    };

    ws.onclose = () => {
      this.callbacks.onStatus("Disconnected from Foundry server.");
      if (!this.disposed) this.callbacks.onDisconnect();
    };

    ws.onerror = () => {
      this.callbacks.onStatus("Unable to reach ws://localhost:8787 — is the game server running?");
    };
  }

  requestPointerLock(): void {
    if (!this.pointerLocked && document.pointerLockElement !== this.renderer.renderer.domElement) {
      this.renderer.renderer.domElement.requestPointerLock?.();
    }
  }

  rematch(mode?: GameModeId): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = { type: "rematch", mode };
      this.ws.send(JSON.stringify(msg));
      this.killfeed = [];
    }
  }

  private handleSnapshot(snap: ServerSnapshot, hitConfirm?: HitConfirmEvent): void {
    this.snapshot = snap;
    if (snap.tracers.length > 0) {
      this.renderer.addTracers(snap.tracers);
      for (const tr of snap.tracers) {
        if (tr.shooterId === this.playerId) {
          this.renderer.triggerRecoil();
          const me = snap.players.find((p) => p.id === this.playerId);
          if (me) this.audio.playShot(me.classId);
        }
      }
    }

    if (snap.kills.length > 0) {
      this.killfeed = [...snap.kills, ...this.killfeed].slice(0, 5);
    }

    if (hitConfirm) {
      this.hitMarkerUntil = performance.now() + 180;
      this.hitMarkerHeadshot = hitConfirm.headshot;
      this.hitMarkerKilled = hitConfirm.killed;
      this.audio.playHit(hitConfirm.headshot, hitConfirm.killed);
    }

    const serverMe = snap.players.find((p) => p.id === this.playerId);
    if (serverMe) {
      if (!this.predictedPlayer || !serverMe.alive || !this.predictedPlayer.alive) {
        this.predictedPlayer = { ...serverMe };
        this.yaw = serverMe.yaw;
        this.pitch = serverMe.pitch;
      } else {
        // Soft reconciliation to keep local controls snappy without jitter
        const dist = Math.hypot(
          serverMe.x - this.predictedPlayer.x,
          serverMe.y - this.predictedPlayer.y,
          serverMe.z - this.predictedPlayer.z
        );
        if (dist > 2.2) {
          this.predictedPlayer.x = serverMe.x;
          this.predictedPlayer.y = serverMe.y;
          this.predictedPlayer.z = serverMe.z;
          this.predictedPlayer.vx = serverMe.vx;
          this.predictedPlayer.vy = serverMe.vy;
          this.predictedPlayer.vz = serverMe.vz;
        } else {
          this.predictedPlayer.x += (serverMe.x - this.predictedPlayer.x) * 0.25;
          this.predictedPlayer.y += (serverMe.y - this.predictedPlayer.y) * 0.35;
          this.predictedPlayer.z += (serverMe.z - this.predictedPlayer.z) * 0.25;
        }
        // Always trust server for authoritative combat/objective stats
        this.predictedPlayer.hp = serverMe.hp;
        this.predictedPlayer.maxHp = serverMe.maxHp;
        this.predictedPlayer.alive = serverMe.alive;
        this.predictedPlayer.respawnMs = serverMe.respawnMs;
        this.predictedPlayer.ammo = serverMe.ammo;
        this.predictedPlayer.maxAmmo = serverMe.maxAmmo;
        this.predictedPlayer.reloadingMs = serverMe.reloadingMs;
        this.predictedPlayer.abilityCooldownMs = serverMe.abilityCooldownMs;
        this.predictedPlayer.reconActiveMs = serverMe.reconActiveMs;
        this.predictedPlayer.classId = serverMe.classId;
        this.predictedPlayer.queuedClassId = serverMe.queuedClassId;
        this.predictedPlayer.team = serverMe.team;
        this.predictedPlayer.kills = serverMe.kills;
        this.predictedPlayer.deaths = serverMe.deaths;
        this.predictedPlayer.captures = serverMe.captures;
        this.predictedPlayer.score = serverMe.score;
        this.predictedPlayer.carriedCores = serverMe.carriedCores;
      }
    }
  }

  private readGamepad(): {
    moveX: number;
    moveZ: number;
    lookX: number;
    lookY: number;
    fire: boolean;
    ads: boolean;
    jump: boolean;
    sprint: boolean;
    reload: boolean;
    ability: boolean;
    toggleCamera: boolean;
  } {
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads.find((g): g is Gamepad => Boolean(g && g.connected));
    if (!pad) {
      return {
        moveX: 0,
        moveZ: 0,
        lookX: 0,
        lookY: 0,
        fire: false,
        ads: false,
        jump: false,
        sprint: false,
        reload: false,
        ability: false,
        toggleCamera: false,
      };
    }
    const dz = (v: number) => (Math.abs(v) < 0.16 ? 0 : v);
    const camBtn = Boolean(pad.buttons[3]?.pressed);
    const toggleCamera = camBtn && !this.gamepadCameraWasPressed;
    this.gamepadCameraWasPressed = camBtn;
    return {
      moveX: dz(pad.axes[0] ?? 0),
      moveZ: dz(-(pad.axes[1] ?? 0)),
      lookX: dz(pad.axes[2] ?? 0),
      lookY: dz(pad.axes[3] ?? 0),
      fire: Boolean(pad.buttons[7]?.pressed || (pad.buttons[7]?.value ?? 0) > 0.3),
      ads: Boolean(pad.buttons[6]?.pressed || (pad.buttons[6]?.value ?? 0) > 0.3),
      jump: Boolean(pad.buttons[0]?.pressed),
      sprint: Boolean(pad.buttons[10]?.pressed),
      reload: Boolean(pad.buttons[2]?.pressed),
      ability: Boolean(pad.buttons[5]?.pressed),
      toggleCamera,
    };
  }

  private buildInputFrame(): InputFrame {
    const gp = this.readGamepad();
    const kbMoveZ = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const kbMoveX = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const moveZ = clamp(kbMoveZ + this.touchMoveZ + gp.moveZ, -1, 1);
    const moveX = clamp(kbMoveX + this.touchMoveX + gp.moveX, -1, 1);
    const kbFire = this.keys.has("KeyF");
    const kbAds = this.keys.has("KeyQ");
    const frame: InputFrame = {
      seq: ++this.seq,
      moveX,
      moveZ,
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.keys.has("Space") || this.touchJump || gp.jump,
      sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || gp.sprint,
      fire: (this.pointerLocked && this.mouseFire) || kbFire || this.touchFire || gp.fire,
      ads: (this.pointerLocked && this.mouseAds) || kbAds || gp.ads,
      reload: this.pendingReload || gp.reload,
      ability: this.pendingAbility || gp.ability,
      desiredClass: this.queuedClass,
    };
    this.pendingReload = false;
    this.pendingAbility = false;
    return frame;
  }

  private startLoops(): void {
    if (this.sendInterval) clearInterval(this.sendInterval);
    this.sendInterval = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const frame = this.buildInputFrame();
      const msg: ClientMessage = { type: "input", frame };
      this.ws.send(JSON.stringify(msg));
    }, TICK_MS);

    this.lastFrameMs = performance.now();
    const tickRender = (now: number) => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(tickRender);
      const dt = Math.min(0.05, (now - this.lastFrameMs) / 1000);
      this.lastFrameMs = now;

      if (!this.snapshot || !this.predictedPlayer) return;

      // Laptop-friendly Arrow Key + Gamepad right-stick look
      const gp = this.readGamepad();
      if (gp.toggleCamera) this.cameraMode = this.cameraMode === "fps" ? "tps" : "fps";
      const turnYaw = (this.keys.has("ArrowLeft") ? 1 : 0) - (this.keys.has("ArrowRight") ? 1 : 0) - gp.lookX;
      const turnPitch = (this.keys.has("ArrowUp") ? 1 : 0) - (this.keys.has("ArrowDown") ? 1 : 0) - gp.lookY;
      if (turnYaw !== 0) this.yaw += turnYaw * 2.4 * dt;
      if (turnPitch !== 0) this.pitch = clamp(this.pitch + turnPitch * 1.8 * dt, -1.46, 1.46);

      // Local movement prediction
      if (this.predictedPlayer.alive && this.snapshot.phase === "playing") {
        const localInput: InputFrame = {
          seq: this.seq,
          moveX: clamp(
            (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0) + this.touchMoveX + gp.moveX,
            -1,
            1
          ),
          moveZ: clamp(
            (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0) + this.touchMoveZ + gp.moveZ,
            -1,
            1
          ),
          yaw: this.yaw,
          pitch: this.pitch,
          jump: this.keys.has("Space") || this.touchJump || gp.jump,
          sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || gp.sprint,
          fire: false,
          ads: this.mouseAds || this.keys.has("KeyQ") || gp.ads,
          reload: false,
          ability: false,
        };
        stepPlayerPhysics(this.predictedPlayer, localInput, dt, this.snapshot.barriers);
      }

      this.renderer.renderFrame({
        dt,
        snapshot: this.snapshot,
        localPlayer: this.predictedPlayer,
        cameraMode: this.cameraMode,
        ads: (this.pointerLocked && this.mouseAds) || this.keys.has("KeyQ"),
      });

      this.callbacks.onSnapshot({
        snapshot: this.snapshot,
        localPlayer: this.predictedPlayer,
        cameraMode: this.cameraMode,
        pointerLocked: this.pointerLocked,
        scoreboardOpen: this.scoreboardOpen,
        killfeed: this.killfeed,
        hitMarker: {
          active: now < this.hitMarkerUntil,
          headshot: this.hitMarkerHeadshot,
          killed: this.hitMarkerKilled,
        },
      });
    };
    this.rafId = requestAnimationFrame(tickRender);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Tab" || e.code.startsWith("Arrow")) {
      e.preventDefault();
      if (e.code === "Tab") {
        this.scoreboardOpen = true;
        return;
      }
    }
    this.keys.add(e.code);

    if (e.code === "KeyV") {
      this.cameraMode = this.cameraMode === "fps" ? "tps" : "fps";
    } else if (e.code === "KeyE") {
      this.pendingAbility = true;
      if (this.predictedPlayer && this.predictedPlayer.abilityCooldownMs <= 0) {
        this.audio.playAbility(this.predictedPlayer.classId);
      }
    } else if (e.code === "KeyR") {
      this.pendingReload = true;
      this.audio.playReload();
    } else if (e.code === "Digit1") {
      this.queuedClass = CLASS_ORDER[0];
    } else if (e.code === "Digit2") {
      this.queuedClass = CLASS_ORDER[1];
    } else if (e.code === "Digit3") {
      this.queuedClass = CLASS_ORDER[2];
    } else if (e.code === "Digit4") {
      this.queuedClass = CLASS_ORDER[3];
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Tab") {
      e.preventDefault();
      this.scoreboardOpen = false;
      return;
    }
    this.keys.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.yaw -= e.movementX * this.sensitivity;
    this.pitch = clamp(this.pitch - e.movementY * this.sensitivity, -1.46, 1.46);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    if (e.button === 0) this.mouseFire = true;
    if (e.button === 2) this.mouseAds = true;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseFire = false;
    if (e.button === 2) this.mouseAds = false;
  };

  private onContextMenu = (e: MouseEvent): void => {
    if (this.pointerLocked) e.preventDefault();
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.renderer.renderer.domElement;
    if (!this.pointerLocked) {
      this.mouseFire = false;
      this.mouseAds = false;
    }
  };

  private onResize = (): void => {
    this.renderer.resize(window.innerWidth, window.innerHeight);
  };

  private bindEvents(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("resize", this.onResize);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.sendInterval) clearInterval(this.sendInterval);
    this.ws?.close();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.renderer.dispose();
  }
}
