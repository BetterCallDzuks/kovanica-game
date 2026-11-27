import { WebSocket, WebSocketServer } from "ws";
import { MODE_CONFIGS, TICK_MS, TICK_RATE } from "../shared/constants";
import type { ClientMessage, GameModeId, ServerMessage } from "../shared/types";
import { GameRoom } from "./room";
import { EpochSettlementLedger } from "./settlement";

const PORT = Number(process.env.PORT ?? 8787);

interface ClientConn {
  ws: WebSocket;
  playerId: string;
  roomId: string | null;
}

const rooms = new Map<string, GameRoom>();
const clients = new Map<WebSocket, ClientConn>();
const settlementLedger = new EpochSettlementLedger();
let nextId = 1;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function findOrCreateRoom(mode: GameModeId, fillBots: boolean): GameRoom {
  for (const room of rooms.values()) {
    if (
      room.mode === mode &&
      room.phase === "playing" &&
      room.humanCount < MODE_CONFIGS[mode].maxPlayers
    ) {
      return room;
    }
  }
  const id = `foundry-${mode.slice(0, 3)}-${nextId++}`;
  const room = new GameRoom(id, mode, fillBots, settlementLedger);
  rooms.set(id, room);
  return room;
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  const playerId = `p_${nextId++}`;
  const conn: ClientConn = { ws, playerId, roomId: null };
  clients.set(ws, conn);

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      send(ws, { type: "error", message: "Invalid JSON payload" });
      return;
    }

    if (msg.type === "join") {
      if (conn.roomId) {
        const old = rooms.get(conn.roomId);
        old?.removePlayer(conn.playerId);
      }
      const mode: GameModeId = MODE_CONFIGS[msg.mode] ? msg.mode : "domination";
      const room = findOrCreateRoom(mode, msg.fillBots !== false);
      conn.roomId = room.id;
      room.addHumanPlayer({
        id: conn.playerId,
        name: msg.name || "OPERATOR",
        classId: msg.classId || "striker",
        walletAddress: msg.walletAddress,
        sessionKeyActive: msg.sessionKeyActive,
        stealthMetaAddress: msg.stealthMetaAddress,
      });
      send(ws, {
        type: "welcome",
        playerId: conn.playerId,
        roomId: room.id,
        mode: room.mode,
        tickRate: TICK_RATE,
      });
    } else if (msg.type === "input") {
      if (!conn.roomId) return;
      const room = rooms.get(conn.roomId);
      room?.submitInput(conn.playerId, msg.frame);
    } else if (msg.type === "rematch") {
      if (!conn.roomId) return;
      const room = rooms.get(conn.roomId);
      room?.rematch(msg.mode);
    }
  });

  ws.on("close", () => {
    if (conn.roomId) {
      const room = rooms.get(conn.roomId);
      if (room) {
        room.removePlayer(conn.playerId);
        if (room.humanCount === 0) {
          rooms.delete(room.id);
        }
      }
    }
    clients.delete(ws);
  });
});

// Authoritative 20 Hz simulation loop
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.humanCount === 0) continue;
    room.step(TICK_MS);
    const snapshot = room.getSnapshot();
    for (const conn of clients.values()) {
      if (conn.roomId === room.id) {
        send(conn.ws, {
          type: "snapshot",
          snapshot,
          hitConfirm: room.pendingHitConfirms.get(conn.playerId),
        });
      }
    }
  }
}, TICK_MS);

console.log(`[KOVANICA: FOUNDRY] Authoritative ${TICK_RATE}Hz game server listening on ws://localhost:${PORT}`);
