# KOVANICA: FOUNDRY

Fast 3D browser-based PvP Territory-Control Shooter (WASD + Mouse, FPS primary with `V` TPS toggle) built for **Kovanica Protocol** (Testnet Chain 2 → Mainnet Chain 1 on Jan 1, 2027).

## Quick Start

```bash
npm install
npm run dev
```

- **Game Client (Vite + Three.js):** `http://localhost:5173`
- **Authoritative Game Server (20 Hz WebSocket):** `ws://localhost:8787`

## Controls
- `W A S D` — Move / Strafe
- `Mouse` — Aim (Pointer Lock)
- `Left Click` — Fire · `Right Click` — ADS Zoom
- `Space` — Jump · `Shift` — Sprint
- `E` — Class Tactical Ability · `R` — Reload
- `V` — Toggle Camera (**FPS ↔ TPS Over-the-Shoulder**)
- `1–4` — Queue Class Swap (Striker / Breacher / Marksman / Warden)
- `Tab` — Scoreboard · `Esc` — Pause / Settings

## Modes
1. **Foundry Domination** (3v3, 3 Control Nodes, Overclock 2× on 3-cap)
2. **Vault Rush** (FFA Rotating King of the Hill)
3. **Core Extraction** (3v3 Harvest Cores & Bank at Team Relay)

## Verification
```bash
npm run typecheck
npm test
npm run build
```
