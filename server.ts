import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { ArenaEngine } from './src/shared/arenaEngine';
import {
  ClientToServerMessage,
  ServerGridSize,
  ServerToClientMessage,
  TICK_MS,
} from './src/shared/gameTypes';
import { packSnapshot } from './src/shared/wireProtocol';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.use(express.json());

  const httpServer = createServer(app);
  // Disable TCP Nagle buffering so directional turns and tick updates flush immediately
  httpServer.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  // Disable perMessageDeflate so multi-player tick broadcasts don't stall on zlib CPU compression
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    perMessageDeflate: false,
  });

  // Maintain both the 32x32 Server (2 AI snakes) and the 64x64 Server (4 AI snakes) simultaneously
  const arenas = new Map<ServerGridSize, ArenaEngine>([
    [32, new ArenaEngine(2, 32)],
    [64, new ArenaEngine(4, 64)],
  ]);

  const clientPlayers = new Map<
    WebSocket,
    { id: string; gridSize: ServerGridSize; isAlive: boolean }
  >();

  const isPlayerIdOwnedElsewhere = (playerId: string, gridSize: ServerGridSize, skipWs: WebSocket) => {
    for (const [sock, info] of clientPlayers.entries()) {
      if (sock !== skipWs && info.id === playerId && info.gridSize === gridSize) {
        return true;
      }
    }
    return false;
  };

  app.get('/api/arena', (req, res) => {
    const requestedSize = Number(req.query.size) === 64 ? 64 : 32;
    const arena = arenas.get(requestedSize)!;
    res.json({
      status: 'ok',
      mode: 'authoritative-ws',
      snapshot: arena.getSnapshot(),
    });
  });

  app.post('/api/arena', (req, res) => {
    const requestedSize = Number(req.body?.gridSize) === 64 ? 64 : 32;
    const arena = arenas.get(requestedSize)!;
    res.json({ ok: true, snapshot: arena.getSnapshot() });
  });

  wss.on('connection', (ws: WebSocket, req) => {
    req.socket?.setNoDelay(true);

    let assignedPlayerId = `plr_${Math.random().toString(36).slice(2, 9)}`;
    let activeGridSize: ServerGridSize = 32;
    clientPlayers.set(ws, { id: assignedPlayerId, gridSize: activeGridSize, isAlive: true });

    const sendMsg = (msg: ServerToClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    ws.on('pong', () => {
      const entry = clientPlayers.get(ws);
      if (entry) entry.isAlive = true;
    });

    // Send initial welcome + packed 32x32 arena state immediately
    sendMsg({
      type: 'welcome',
      playerId: assignedPlayerId,
      state: packSnapshot(arenas.get(activeGridSize)!.getSnapshot()),
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientToServerMessage;
        if (msg.type === 'select_server') {
          const newSize: ServerGridSize = msg.gridSize === 64 ? 64 : 32;
          if (newSize !== activeGridSize) {
            if (!isPlayerIdOwnedElsewhere(assignedPlayerId, activeGridSize, ws)) {
              arenas.get(activeGridSize)?.removePlayer(assignedPlayerId);
            }
            activeGridSize = newSize;
            clientPlayers.set(ws, { id: assignedPlayerId, gridSize: activeGridSize, isAlive: true });
          }
          sendMsg({
            type: 'state',
            state: packSnapshot(arenas.get(activeGridSize)!.getSnapshot()),
          });
        } else if (msg.type === 'join') {
          const prevId = assignedPlayerId;
          if (msg.clientId && msg.clientId.trim().length > 0) {
            assignedPlayerId = msg.clientId.trim().slice(0, 32);
          }
          const nextSize: ServerGridSize =
            msg.gridSize === 64 || msg.gridSize === 32 ? msg.gridSize : activeGridSize;

          if (prevId !== assignedPlayerId || nextSize !== activeGridSize) {
            if (!isPlayerIdOwnedElsewhere(prevId, activeGridSize, ws)) {
              arenas.get(activeGridSize)?.removePlayer(prevId);
            }
          }
          activeGridSize = nextSize;
          clientPlayers.set(ws, { id: assignedPlayerId, gridSize: activeGridSize, isAlive: true });

          const arena = arenas.get(activeGridSize)!;
          arena.spawnPlayer(
            assignedPlayerId,
            msg.name,
            msg.colorId,
            Boolean(msg.autoPilot),
            msg.autoPilotTier
          );
          sendMsg({
            type: 'welcome',
            playerId: assignedPlayerId,
            state: packSnapshot(arena.getSnapshot()),
          });
        } else if (msg.type === 'turn') {
          arenas.get(activeGridSize)!.queueTurn(assignedPlayerId, msg.dir, msg.seq);
        } else if (msg.type === 'autopilot') {
          arenas
            .get(activeGridSize)!
            .setAutopilot(assignedPlayerId, Boolean(msg.enabled), msg.tier);
        } else if (msg.type === 'respawn') {
          if (msg.gridSize === 64 || msg.gridSize === 32) {
            if (msg.gridSize !== activeGridSize) {
              if (!isPlayerIdOwnedElsewhere(assignedPlayerId, activeGridSize, ws)) {
                arenas.get(activeGridSize)?.removePlayer(assignedPlayerId);
              }
              activeGridSize = msg.gridSize;
              clientPlayers.set(ws, { id: assignedPlayerId, gridSize: activeGridSize, isAlive: true });
            }
          }
          const arena = arenas.get(activeGridSize)!;
          arena.spawnPlayer(
            assignedPlayerId,
            msg.name,
            msg.colorId,
            Boolean(msg.autoPilot),
            msg.autoPilotTier
          );
          sendMsg({
            type: 'state',
            state: packSnapshot(arena.getSnapshot()),
          });
        } else if (msg.type === 'admin_track') {
          const payload = JSON.stringify({
            type: 'admin_track',
            trackId: msg.trackId,
          } satisfies ServerToClientMessage);
          for (const [client, info] of clientPlayers.entries()) {
            if (
              client.readyState === WebSocket.OPEN &&
              client.bufferedAmount < 65536 &&
              info.gridSize === activeGridSize
            ) {
              client.send(payload);
            }
          }
        } else if (msg.type === 'kick_admin') {
          const targetId = typeof msg.targetPlayerId === 'string' ? msg.targetPlayerId : '*';
          const issuedBy =
            typeof msg.issuedByClientId === 'string' ? msg.issuedByClientId : assignedPlayerId;
          const arena = arenas.get(activeGridSize)!;
          if (targetId === '*') {
            for (const s of arena.snakes.values()) {
              if (!s.isBot && s.id !== issuedBy) {
                arena.setAutopilot(s.id, false);
              }
            }
          } else if (targetId && targetId !== issuedBy) {
            arena.setAutopilot(targetId, false);
          }
          const payload = JSON.stringify({
            type: 'kick_admin',
            targetPlayerId: targetId,
            issuedByClientId: issuedBy,
          } satisfies ServerToClientMessage);
          for (const [client, info] of clientPlayers.entries()) {
            if (
              client.readyState === WebSocket.OPEN &&
              client.bufferedAmount < 65536 &&
              info.gridSize === activeGridSize
            ) {
              client.send(payload);
            }
          }
        } else if (msg.type === 'give_life') {
          const arena = arenas.get(activeGridSize)!;
          const res = arena.giveExtraLife(assignedPlayerId, msg.targetPlayerId);
          const fromSnake = arena.snakes.get(assignedPlayerId);
          const toSnake = arena.snakes.get(msg.targetPlayerId);
          const resultPayload = JSON.stringify({
            type: 'trade_result',
            offerId: `give_${Date.now()}`,
            fromId: assignedPlayerId,
            fromName: fromSnake?.name || 'PLAYER',
            toId: msg.targetPlayerId,
            toName: toSnake?.name || 'PLAYER',
            ok: res.ok,
            accepted: true,
            summary: res.ok
              ? `${fromSnake?.name || 'Player'} gave 1 Extra Life to ${toSnake?.name || 'Player'}!`
              : res.reason || 'Transfer failed.',
          } satisfies ServerToClientMessage);
          const statePayload = res.ok
            ? JSON.stringify({
                type: 'state',
                state: packSnapshot(arena.getSnapshot()),
              } satisfies ServerToClientMessage)
            : null;
          for (const [client, info] of clientPlayers.entries()) {
            if (
              client.readyState === WebSocket.OPEN &&
              info.gridSize === activeGridSize &&
              (info.id === assignedPlayerId || info.id === msg.targetPlayerId)
            ) {
              if (statePayload) client.send(statePayload);
              client.send(resultPayload);
            }
          }
        } else if (msg.type === 'trade_offer') {
          const arena = arenas.get(activeGridSize)!;
          const fromSnake = arena.snakes.get(assignedPlayerId);
          const sanitizedOffer = {
            ...msg.offer,
            fromId: assignedPlayerId,
            fromName: fromSnake?.name || msg.offer.fromName,
          };
          const payload = JSON.stringify({
            type: 'trade_offer',
            offer: sanitizedOffer,
          } satisfies ServerToClientMessage);
          for (const [client, info] of clientPlayers.entries()) {
            if (
              client.readyState === WebSocket.OPEN &&
              info.gridSize === activeGridSize &&
              info.id === sanitizedOffer.toId
            ) {
              client.send(payload);
            }
          }
        } else if (msg.type === 'trade_response') {
          const offer = msg.offer;
          if (offer && offer.toId === assignedPlayerId) {
            const arena = arenas.get(activeGridSize)!;
            let ok = true;
            let summary = `${offer.toName} declined the life trade.`;
            if (msg.accepted) {
              const res = arena.executeLifeTrade(offer);
              ok = res.ok;
              const giveLabel =
                offer.giveType === 'LIFE' ? `${offer.giveAmount} Life` : `${offer.giveAmount} PTS`;
              const wantLabel =
                offer.wantType === 'LIFE' ? `${offer.wantAmount} Life` : `${offer.wantAmount} PTS`;
              summary = res.ok
                ? `Trade complete: ${offer.fromName} (${giveLabel}) ⇄ ${offer.toName} (${wantLabel})`
                : res.reason || 'Trade failed.';
            }
            const resultPayload = JSON.stringify({
              type: 'trade_result',
              offerId: msg.offerId,
              fromId: offer.fromId,
              fromName: offer.fromName,
              toId: offer.toId,
              toName: offer.toName,
              ok,
              accepted: msg.accepted,
              summary,
            } satisfies ServerToClientMessage);
            const statePayload =
              msg.accepted && ok
                ? JSON.stringify({
                    type: 'state',
                    state: packSnapshot(arena.getSnapshot()),
                  } satisfies ServerToClientMessage)
                : null;
            for (const [client, info] of clientPlayers.entries()) {
              if (
                client.readyState === WebSocket.OPEN &&
                info.gridSize === activeGridSize &&
                (info.id === offer.fromId || info.id === offer.toId)
              ) {
                if (statePayload) client.send(statePayload);
                client.send(resultPayload);
              }
            }
          }
        } else if (msg.type === 'leave') {
          if (!isPlayerIdOwnedElsewhere(assignedPlayerId, activeGridSize, ws)) {
            arenas.get(activeGridSize)!.removePlayer(assignedPlayerId);
          }
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      const info = clientPlayers.get(ws);
      clientPlayers.delete(ws);
      if (info && !isPlayerIdOwnedElsewhere(info.id, info.gridSize, ws)) {
        arenas.get(info.gridSize)?.removePlayer(info.id);
      }
    });
  });

  // Periodic keepalive ping to evict half-open dead sockets immediately
  setInterval(() => {
    for (const [client, info] of clientPlayers.entries()) {
      if (!info.isAlive) {
        clientPlayers.delete(client);
        if (!isPlayerIdOwnedElsewhere(info.id, info.gridSize, client)) {
          arenas.get(info.gridSize)?.removePlayer(info.id);
        }
        client.terminate();
        continue;
      }
      info.isAlive = false;
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, 8000);

  // Drift-compensated authoritative game loop (steps and packs ONLY arenas with active clients)
  let nextTickAt = performance.now() + TICK_MS;
  const runTickLoop = () => {
    const now = performance.now();
    let count32 = 0;
    let count64 = 0;

    for (const [client, info] of clientPlayers.entries()) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (info.gridSize === 64) count64++;
      else count32++;
    }

    let payload32: string | null = null;
    if (count32 > 0) {
      const snap32 = arenas.get(32)!.step();
      snap32.onlinePlayers = Math.max(snap32.onlinePlayers, count32);
      payload32 = JSON.stringify({
        type: 'state',
        state: packSnapshot(snap32),
      } satisfies ServerToClientMessage);
    }

    let payload64: string | null = null;
    if (count64 > 0) {
      const snap64 = arenas.get(64)!.step();
      snap64.onlinePlayers = Math.max(snap64.onlinePlayers, count64);
      payload64 = JSON.stringify({
        type: 'state',
        state: packSnapshot(snap64),
      } satisfies ServerToClientMessage);
    }

    for (const [client, info] of clientPlayers.entries()) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // Backpressure guard: avoid queueing seconds of stale frames on stalled sockets
      if (client.bufferedAmount > 65536) continue;
      const payload = info.gridSize === 64 ? payload64 : payload32;
      if (payload) {
        client.send(payload);
      }
    }

    nextTickAt += TICK_MS;
    if (nextTickAt < now - TICK_MS) {
      nextTickAt = now + TICK_MS;
    }
    setTimeout(runTickLoop, Math.max(1, nextTickAt - performance.now()));
  };
  setTimeout(runTickLoop, TICK_MS);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`GRIDSLURP Arena Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
