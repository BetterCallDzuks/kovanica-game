import { CLASS_CONFIGS, CLASS_ORDER, MODE_CONFIGS } from "../../shared/constants";
import type {
  CameraMode,
  ClassId,
  GameModeId,
  KillEvent,
  PlayerState,
  ServerSnapshot,
} from "../../shared/types";
import {
  activateWaveCSessionKey,
  connectKovanicaWallet,
  createInitialWalletState,
  shortAddress,
  type WalletSessionState,
} from "./chain/kovanicaAdapter";
import { ClientGame } from "./game/clientGame";
import "./styles.css";

const app = document.getElementById("app")!;

let wallet: WalletSessionState = createInitialWalletState();
let selectedMode: GameModeId = "domination";
let selectedClass: ClassId = "striker";
let playerName = "OPERATOR";
let fillBots = true;
let statusText = "";
let activeGame: ClientGame | null = null;

function formatTimer(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function renderLobby(): void {
  if (activeGame) {
    activeGame.dispose();
    activeGame = null;
  }

  const modes = Object.values(MODE_CONFIGS);
  app.innerHTML = `
    <div class="lobby-wrap">
      <div class="lobby-card">
        <div class="lobby-header">
          <div>
            <div class="brand-title">KOVANICA: <span>FOUNDRY</span></div>
            <div class="brand-sub">3D PvP Territory Shooter · WASD + Mouse · FPS Primary + [V] TPS Toggle · Zero Pay-to-Win</div>
          </div>
          <div class="wallet-box">
            <div class="pill-row">
              <span class="pill ${wallet.connected ? "gold" : ""}">${wallet.network.name}</span>
              <span class="pill ${wallet.sessionKeyActive ? "teal" : ""}">
                ${wallet.sessionKeyActive ? `Session Key: ${wallet.sessionKeyExpiry}` : "Wave C Session Key: Off"}
              </span>
            </div>
            <div class="pill-row">
              ${
                wallet.connected
                  ? `<span class="pill gold mono">${shortAddress(wallet.address)} · ${wallet.kvncBalance} KVNC · ${wallet.gameTokenBalance} ${wallet.network.gameTokenSymbol}</span>`
                  : `<button class="btn btn-teal" id="btn-connect">Connect Kovanica Wallet</button>`
              }
              ${
                wallet.connected && !wallet.sessionKeyActive
                  ? `<button class="btn btn-teal" id="btn-session">Sign Wave C Session Key</button>`
                  : ""
              }
            </div>
          </div>
        </div>

        <div class="section-label">1. Select Arena Mode (The Mint — Sector 01)</div>
        <div class="grid-3">
          ${modes
            .map(
              (m) => `
            <button class="select-card ${selectedMode === m.id ? "active" : ""}" data-mode="${m.id}">
              <div class="card-title">${m.name}</div>
              <div class="card-meta">${m.subtitle}</div>
            </button>
          `
            )
            .join("")}
        </div>

        <div class="section-label">2. Select Tactical Class (100% Free · Swap Anytime on Respawn with 1–4)</div>
        <div class="grid-4">
          ${CLASS_ORDER.map((cid, idx) => {
            const c = CLASS_CONFIGS[cid];
            return `
              <button class="select-card ${selectedClass === cid ? "active" : ""}" data-class="${cid}">
                <div class="card-title">[${idx + 1}] ${c.name} <span style="color:${c.accentHex};font-size:12px">(${c.maxHp} HP)</span></div>
                <div class="card-meta"><strong>${c.weapon.name}</strong> · ${c.role}</div>
                <div class="card-meta" style="margin-top:6px"><strong style="color:#f4f4f5">[E] ${c.abilityName}:</strong> ${c.abilityDescription}</div>
              </button>
            `;
          }).join("")}
        </div>

        <div class="lobby-footer">
          <div class="input-inline">
            <input type="text" id="input-name" maxlength="18" value="${playerName}" placeholder="CALLSIGN" />
            <label class="toggle-label">
              <input type="checkbox" id="chk-bots" ${fillBots ? "checked" : ""} />
              Instant AI Bot Warmup <span class="pill" style="margin-left:4px">${fillBots ? "0 KVNC (Practice)" : "Human PvP Only"}</span>
            </label>
            <label class="toggle-label">
              <input type="checkbox" id="chk-stealth" ${wallet.stealthPayoutEnabled ? "checked" : ""} />
              KVP-103 Stealth Payouts
            </label>
          </div>
          <div class="input-inline">
            <span class="card-meta mono" id="lobby-status">${statusText}</span>
            <button class="btn btn-primary" id="btn-play">
              ${wallet.connected ? "DEPLOY TO FOUNDRY" : "PLAY AS GUEST"}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
    btn.onclick = () => {
      selectedMode = btn.dataset.mode as GameModeId;
      renderLobby();
    };
  });

  document.querySelectorAll<HTMLButtonElement>("[data-class]").forEach((btn) => {
    btn.onclick = () => {
      selectedClass = btn.dataset.class as ClassId;
      renderLobby();
    };
  });

  const nameInput = document.getElementById("input-name") as HTMLInputElement;
  nameInput.oninput = () => {
    playerName = nameInput.value;
  };

  const botChk = document.getElementById("chk-bots") as HTMLInputElement;
  botChk.onchange = () => {
    fillBots = botChk.checked;
    renderLobby();
  };

  const stealthChk = document.getElementById("chk-stealth") as HTMLInputElement;
  stealthChk.onchange = () => {
    wallet = { ...wallet, stealthPayoutEnabled: stealthChk.checked };
  };

  const btnConnect = document.getElementById("btn-connect");
  if (btnConnect) {
    btnConnect.onclick = async () => {
      wallet = await connectKovanicaWallet(wallet);
      renderLobby();
    };
  }

  const btnSession = document.getElementById("btn-session");
  if (btnSession) {
    btnSession.onclick = async () => {
      wallet = await activateWaveCSessionKey(wallet);
      renderLobby();
    };
  }

  document.getElementById("btn-play")!.onclick = () => startMatch();
}

function startMatch(): void {
  app.innerHTML = `
    <div class="viewport" id="viewport"></div>
    <div class="hud-layer" id="hud"></div>
    <div class="overlay-center" id="pause-overlay">
      <div class="modal-box">
        <div class="brand-title" style="font-size:24px">KOVANICA: <span>FOUNDRY</span></div>
        <div class="card-meta" style="margin:10px 0 18px">
          WASD Move · Mouse <em>or</em> <strong>Arrow Keys</strong> Aim · LMB / <strong>F</strong> Fire · RMB / <strong>Q</strong> ADS · Space Jump · Shift Sprint · <strong>E</strong> Ability · <strong>R</strong> Reload · <strong>V</strong> FPS/TPS · <strong>1–4</strong> Swap Class · <strong>Tab</strong> Scoreboard
        </div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="btn-resume">CLICK TO LOCK AIM & PLAY</button>
          <button class="btn" id="btn-leave">RETURN TO LOBBY</button>
        </div>
        <div class="card-meta mono" id="hud-status" style="margin-top:14px"></div>
      </div>
    </div>
    <div class="overlay-center" id="end-overlay" style="display:none"></div>
  `;

  const viewport = document.getElementById("viewport")!;
  const hudEl = document.getElementById("hud")!;
  const pauseOverlay = document.getElementById("pause-overlay")!;
  const endOverlay = document.getElementById("end-overlay")!;
  const statusEl = document.getElementById("hud-status")!;

  const wsHost = window.location.hostname || "localhost";
  const defaultWsUrl =
    window.location.protocol === "https:"
      ? `wss://${window.location.host}/foundry-ws`
      : `ws://${wsHost}:8787`;
  const wsUrl = (import.meta.env.VITE_WS_URL as string | undefined) ?? defaultWsUrl;

  let matchEndRendered = false;

  activeGame = new ClientGame(viewport, {
    onStatus: (text) => {
      statusText = text;
      statusEl.textContent = text;
    },
    onDisconnect: () => {
      statusEl.textContent = "Connection closed. Return to lobby to reconnect.";
    },
    onSnapshot: ({
      snapshot,
      localPlayer,
      cameraMode,
      pointerLocked,
      scoreboardOpen,
      killfeed,
      hitMarker,
    }) => {
      if (snapshot.phase === "ended" && snapshot.matchEnd) {
        pauseOverlay.style.display = "none";
        if (!matchEndRendered) {
          matchEndRendered = true;
          document.exitPointerLock?.();
          renderMatchEnd(endOverlay, snapshot);
        }
        return;
      }

      matchEndRendered = false;
      endOverlay.style.display = "none";
      pauseOverlay.style.display = pointerLocked ? "none" : "flex";

      renderHud(hudEl, snapshot, localPlayer, cameraMode, scoreboardOpen, killfeed, hitMarker);
    },
  });

  document.getElementById("btn-resume")!.onclick = () => {
    activeGame?.requestPointerLock();
  };
  document.getElementById("btn-leave")!.onclick = () => {
    document.exitPointerLock?.();
    renderLobby();
  };

  activeGame.connect({
    wsUrl,
    name: playerName || "OPERATOR",
    mode: selectedMode,
    classId: selectedClass,
    fillBots,
    walletAddress: wallet.address,
    sessionKeyActive: wallet.sessionKeyActive,
  });
}

function renderHud(
  hudEl: HTMLElement,
  snap: ServerSnapshot,
  me: PlayerState,
  cameraMode: CameraMode,
  scoreboardOpen: boolean,
  killfeed: KillEvent[],
  hitMarker: { active: boolean; headshot: boolean; killed: boolean }
): void {
  const cls = CLASS_CONFIGS[me.classId];
  const hpPct = Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100));
  const abilityReady = me.abilityCooldownMs <= 0;
  const isTeam = snap.mode !== "vault_rush";

  const nodesHtml = snap.nodes
    .map((n) => {
      const stateClass = !n.active
        ? "inactive"
        : n.contested
        ? "contested"
        : n.owner === "gold"
        ? "gold"
        : n.owner === "teal"
        ? "teal"
        : n.owner !== "neutral"
        ? "gold"
        : "";
      return `<div class="node-pill ${stateClass}">${n.id}</div>`;
    })
    .join("");

  const killHtml = killfeed
    .map(
      (k) => `
    <div class="kill-item mono">
      <span style="color:${k.killerTeam === "gold" ? "#F2A900" : "#2fbaa4"}">${k.killerName}</span>
      <span style="color:#a1a1aa"> [${k.weapon}${k.headshot ? " HS" : ""}] </span>
      <span style="color:${k.victimTeam === "gold" ? "#F2A900" : "#2fbaa4"}">${k.victimName}</span>
    </div>
  `
    )
    .join("");

  const scoreboardHtml = scoreboardOpen
    ? `
    <div class="overlay-center" style="pointer-events:none;background:rgba(9,9,11,0.55)">
      <div class="modal-box" style="max-width:640px">
        <div class="section-label">${MODE_CONFIGS[snap.mode].name} · ${snap.isRewardEligible ? "RANKED PVP" : "WARMUP (0 KVNC)"}</div>
        <table class="score-table mono">
          <thead><tr><th>Operator</th><th>Team</th><th>Class</th><th>K/D</th><th>Obj</th><th>Score</th></tr></thead>
          <tbody>
            ${[...snap.players]
              .sort((a, b) => b.score - a.score)
              .map(
                (p) => `
              <tr>
                <td>${p.name}${p.isBot ? " [BOT]" : ""}</td>
                <td style="color:${p.team === "gold" ? "#F2A900" : p.team === "teal" ? "#2fbaa4" : "#f4f4f5"}">${p.team.toUpperCase()}</td>
                <td>${CLASS_CONFIGS[p.classId].name}</td>
                <td>${p.kills}/${p.deaths}</td>
                <td>${p.captures}</td>
                <td><strong>${p.score}</strong></td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `
    : "";

  hudEl.innerHTML = `
    <div class="top-bar">
      ${
        isTeam
          ? `<div class="team-score gold mono">${snap.goldScore}</div>`
          : `<div class="team-score gold mono">${me.score}</div>`
      }
      <div class="node-pills">${nodesHtml}</div>
      <div class="match-timer mono">${formatTimer(snap.remainingMs)}</div>
      ${
        isTeam
          ? `<div class="team-score teal mono">${snap.tealScore}</div>`
          : `<div class="pill gold mono">TARGET ${snap.targetScore}</div>`
      }
      ${snap.overclockTeam ? `<div class="pill gold mono">OVERCLOCK 2×</div>` : ""}
    </div>

    <div class="killfeed">${killHtml}</div>

    <div class="crosshair"></div>
    <div class="hitmarker ${hitMarker.active ? "active" : ""} ${hitMarker.headshot ? "headshot" : ""}"></div>

    ${
      !me.alive
        ? `<div style="position:absolute;top:40%;left:50%;transform:translate(-50%,-50%);background:rgba(9,9,11,0.85);padding:12px 20px;border-radius:10px;border:1px solid #ef4444" class="mono">ELIMINATED · RESPAWNING IN ${(me.respawnMs / 1000).toFixed(1)}s</div>`
        : ""
    }

    <div class="bottom-left">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="color:${me.team === "gold" ? "#F2A900" : "#2fbaa4"}">${cls.name.toUpperCase()}</strong>
        <span class="pill mono">${cameraMode.toUpperCase()} [V]</span>
      </div>
      <div class="hp-bar-bg"><div class="hp-bar-fill" style="width:${hpPct}%;background:${hpPct < 35 ? "#ef4444" : "#2fbaa4"}"></div></div>
      <div class="mono" style="font-size:12px;display:flex;justify-content:space-between;color:#a1a1aa">
        <span>HP ${Math.max(0, Math.ceil(me.hp))}/${me.maxHp}</span>
        <span>${me.carriedCores > 0 ? `CORES: ${me.carriedCores} (BANK AT RELAY)` : me.queuedClassId !== me.classId ? `NEXT: ${CLASS_CONFIGS[me.queuedClassId].name}` : `K:${me.kills} D:${me.deaths}`}</span>
      </div>
    </div>

    <div class="bottom-right">
      <div class="ammo-big mono">${me.reloadingMs > 0 ? "RELOAD" : `${me.ammo} / ${me.maxAmmo}`}</div>
      <div class="card-meta mono" style="margin-top:4px">
        ${cls.weapon.name} · <span style="color:${abilityReady ? "#2fbaa4" : "#a1a1aa"}">[E] ${cls.abilityName} ${abilityReady ? "READY" : `${(me.abilityCooldownMs / 1000).toFixed(1)}s`}</span>
      </div>
    </div>

    ${scoreboardHtml}
  `;
}

function renderMatchEnd(el: HTMLElement, snap: ServerSnapshot): void {
  const end = snap.matchEnd!;
  el.style.display = "flex";
  el.innerHTML = `
    <div class="modal-box" style="max-width:660px">
      <div class="section-label">${MODE_CONFIGS[end.mode].name} · MATCH COMPLETE</div>
      <div class="brand-title" style="font-size:28px;margin-bottom:6px"><span>${end.winnerLabel}</span></div>
      <div class="card-meta mono" style="margin-bottom:14px">
        MVP: ${end.mvpName} (${end.mvpScore} pts) · Anti-Cheat: ${end.antiCheatStatus.toUpperCase()}
      </div>

      <div style="background:rgba(242,169,0,0.08);border:1px solid rgba(242,169,0,0.3);border-radius:10px;padding:12px;margin-bottom:14px;text-align:left">
        <div class="mono" style="font-size:12px;color:#F2A900;font-weight:700">
          DUAL-TOKEN SETTLEMENT (${wallet.network.name})
        </div>
        <div class="card-meta" style="margin-top:4px">${end.rewardReason}</div>
        <div class="mono" style="font-size:13px;margin-top:8px;display:flex;gap:16px">
          <span>${wallet.network.gameTokenSymbol}: <strong>+${end.estimatedGameToken}</strong></span>
          <span>Ranked MMR: <strong>${end.rankedPointsDelta >= 0 ? "+" : ""}${end.rankedPointsDelta}</strong></span>
          <span>Stealth KVP-103: <strong>${wallet.stealthPayoutEnabled ? "ON" : "OFF"}</strong></span>
        </div>
      </div>

      <table class="score-table mono">
        <thead><tr><th>Operator</th><th>Team</th><th>K/D</th><th>Obj</th><th>Score</th></tr></thead>
        <tbody>
          ${end.leaderboard
            .map(
              (p) => `
            <tr>
              <td>${p.name}${p.isBot ? " [BOT]" : ""}</td>
              <td style="color:${p.team === "gold" ? "#F2A900" : p.team === "teal" ? "#2fbaa4" : "#f4f4f5"}">${p.team.toUpperCase()}</td>
              <td>${p.kills}/${p.deaths}</td>
              <td>${p.captures}</td>
              <td><strong>${p.score}</strong></td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>

      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px">
        <button class="btn btn-primary" id="btn-rematch">PLAY AGAIN</button>
        <button class="btn" id="btn-end-lobby">BACK TO LOBBY</button>
      </div>
    </div>
  `;

  document.getElementById("btn-rematch")!.onclick = () => {
    activeGame?.rematch();
    activeGame?.requestPointerLock();
  };
  document.getElementById("btn-end-lobby")!.onclick = () => {
    renderLobby();
  };
}

renderLobby();
