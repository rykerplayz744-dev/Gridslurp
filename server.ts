import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { ArenaEngine } from './src/shared/arenaEngine';
import {
  ArenaSnapshot,
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

  // Lazy-loaded arenas: a server (32x32 or 64x64) is only loaded while at least one player is in it
  const arenas = new Map<ServerGridSize, ArenaEngine>();

  const clientPlayers = new Map<
    WebSocket,
    { id: string; gridSize: ServerGridSize; isAlive: boolean }
  >();

  let tickTimer: ReturnType<typeof setTimeout> | null = null;

  const createEmptySnapshot = (gridSize: ServerGridSize): ArenaSnapshot => ({
    tick: 0,
    gridSize,
    snakes: [],
    pellets: [],
    lootBoxes: [],
    telegraphs: [],
    recentKills: [],
    recentSlurps: [],
    recentLootPickups: [],
    recentExtraLifeSaves: [],
    onlinePlayers: 0,
  });

  const getOrCreateArena = (gridSize: ServerGridSize): ArenaEngine => {
    let arena = arenas.get(gridSize);
    if (!arena) {
      arena = new ArenaEngine(gridSize === 64 ? 4 : 2, gridSize);
      arenas.set(gridSize, arena);
    }
    return arena;
  };

  const countClientsOnServer = (gridSize: ServerGridSize): number => {
    let count = 0;
    for (const [client, info] of clientPlayers.entries()) {
      if (
        (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) &&
        info.gridSize === gridSize
      ) {
        count++;
      }
    }
    return count;
  };

  const pruneEmptyArenas = () => {
    for (const gridSize of Array.from(arenas.keys())) {
      if (countClientsOnServer(gridSize) === 0) {
        arenas.delete(gridSize);
      }
    }
    if (arenas.size === 0 && clientPlayers.size === 0 && tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
  };

  const isPlayerIdOwnedElsewhere = (playerId: string, gridSize: ServerGridSize, skipWs: WebSocket) => {
    for (const [sock, info] of clientPlayers.entries()) {
      if (sock !== skipWs && info.id === playerId && info.gridSize === gridSize) {
        return true;
      }
    }
    return false;
  };

  let scheduleTickLoop = () => {};

  app.get('/api/arena', (req, res) => {
    const requestedSize: ServerGridSize = Number(req.query.size) === 64 ? 64 : 32;
    const arena = arenas.get(requestedSize);
    res.json({
      status: 'ok',
      mode: 'authoritative-ws',
      loaded: Boolean(arena),
      snapshot: arena ? arena.getSnapshot() : createEmptySnapshot(requestedSize),
    });
  });

  app.post('/api/arena', (req, res) => {
    const requestedSize: ServerGridSize = Number(req.body?.gridSize) === 64 ? 64 : 32;
    const arena = arenas.get(requestedSize);
    res.json({
      ok: true,
      loaded: Boolean(arena),
      snapshot: arena ? arena.getSnapshot() : createEmptySnapshot(requestedSize),
    });
  });

  wss.on('connection', (ws: WebSocket, req) => {
    req.socket?.setNoDelay(true);

    const parsedUrl = new URL(req.url || '/ws', 'http://localhost');
    let assignedPlayerId = `plr_${Math.random().toString(36).slice(2, 9)}`;
    let activeGridSize: ServerGridSize = parsedUrl.searchParams.get('size') === '64' ? 64 : 32;
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

    // Lazy-load only the requested server and start the tick loop if idle
    const initialArena = getOrCreateArena(activeGridSize);
    scheduleTickLoop();

    // Send initial welcome + packed arena state immediately
    sendMsg({
      type: 'welcome',
      playerId: assignedPlayerId,
      state: packSnapshot(initialArena.getSnapshot()),
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
            pruneEmptyArenas();
          }
          const arena = getOrCreateArena(activeGridSize);
          scheduleTickLoop();
          sendMsg({
            type: 'state',
            state: packSnapshot(arena.getSnapshot()),
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
          pruneEmptyArenas();

          const arena = getOrCreateArena(activeGridSize);
          scheduleTickLoop();
          arena.spawnPlayer(
            assignedPlayerId,
            msg.name,
            msg.colorId,
            Boolean(msg.autoPilot),
            msg.autoPilotTier,
            msg.faceId,
            msg.deathEffectId
          );
          sendMsg({
            type: 'welcome',
            playerId: assignedPlayerId,
            state: packSnapshot(arena.getSnapshot()),
          });
        } else if (msg.type === 'turn') {
          arenas.get(activeGridSize)?.queueTurn(assignedPlayerId, msg.dir, msg.seq);
        } else if (msg.type === 'autopilot') {
          arenas
            .get(activeGridSize)
            ?.setAutopilot(assignedPlayerId, Boolean(msg.enabled), msg.tier);
        } else if (msg.type === 'set_face') {
          arenas.get(activeGridSize)?.setPlayerFace(assignedPlayerId, msg.faceId);
        } else if (msg.type === 'set_death_effect') {
          arenas.get(activeGridSize)?.setPlayerDeathEffect(assignedPlayerId, msg.deathEffectId);
        } else if (msg.type === 'respawn') {
          if (msg.gridSize === 64 || msg.gridSize === 32) {
            if (msg.gridSize !== activeGridSize) {
              if (!isPlayerIdOwnedElsewhere(assignedPlayerId, activeGridSize, ws)) {
                arenas.get(activeGridSize)?.removePlayer(assignedPlayerId);
              }
              activeGridSize = msg.gridSize;
              clientPlayers.set(ws, { id: assignedPlayerId, gridSize: activeGridSize, isAlive: true });
              pruneEmptyArenas();
            }
          }
          const arena = getOrCreateArena(activeGridSize);
          scheduleTickLoop();
          arena.spawnPlayer(
            assignedPlayerId,
            msg.name,
            msg.colorId,
            Boolean(msg.autoPilot),
            msg.autoPilotTier,
            msg.faceId,
            msg.deathEffectId
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
          const arena = getOrCreateArena(activeGridSize);
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
        } else if (msg.type === 'adminry_pellet_flood') {
          const arena = getOrCreateArena(activeGridSize);
          const senderSnake = arena.snakes.get(assignedPlayerId);
          const candidateName = (senderSnake?.name || msg.issuedByName || '').trim().toUpperCase();
          if (candidateName.startsWith('ADMINRY')) {
            const action = msg.action === 'CLEAR' ? 'CLEAR' : 'FLOOD_SCREEN';
            const count =
              action === 'CLEAR' ? arena.clearAllPellets() : arena.floodScreenWithPellets();
            const statePayload = JSON.stringify({
              type: 'state',
              state: packSnapshot(arena.getSnapshot()),
            } satisfies ServerToClientMessage);
            const noticePayload = JSON.stringify({
              type: 'pellet_flood_notice',
              action,
              count,
              byName: candidateName,
            } satisfies ServerToClientMessage);
            for (const [client, info] of clientPlayers.entries()) {
              if (
                client.readyState === WebSocket.OPEN &&
                client.bufferedAmount < 524288 &&
                info.gridSize === activeGridSize
              ) {
                client.send(statePayload);
                client.send(noticePayload);
              }
            }
          }
        } else if (msg.type === 'adminry_give_lives') {
          const arena = getOrCreateArena(activeGridSize);
          const senderSnake = arena.snakes.get(assignedPlayerId);
          const candidateName = (senderSnake?.name || msg.issuedByName || '').trim().toUpperCase();
          if (candidateName.startsWith('ADMINRY')) {
            const rawTarget = typeof msg.targetPlayerId === 'string' ? msg.targetPlayerId : 'ME';
            const resolvedTarget = rawTarget === 'ME' ? assignedPlayerId : rawTarget;
            const amount = Math.max(-999, Math.min(99, Math.trunc(Number(msg.amount) || 0)));
            const res = arena.adminGiveExtraLives(resolvedTarget, amount);
            if (res.ok) {
              const statePayload = JSON.stringify({
                type: 'state',
                state: packSnapshot(arena.getSnapshot()),
              } satisfies ServerToClientMessage);
              const summary =
                amount < 0
                  ? `${candidateName} cleared Extra Lives for ${res.targetName || 'player'}.`
                  : resolvedTarget === '*'
                    ? `${candidateName} gave +${amount} Extra ${amount === 1 ? 'Life' : 'Lives'} to all alive players!`
                    : `${candidateName} gave +${amount} Extra ${amount === 1 ? 'Life' : 'Lives'} to ${res.targetName || 'player'} (now ×${res.newLives ?? 0}).`;
              const resultPayload = JSON.stringify({
                type: 'trade_result',
                offerId: `dbg_${Date.now()}`,
                fromId: assignedPlayerId,
                fromName: candidateName,
                toId: resolvedTarget,
                toName: res.targetName || 'PLAYER',
                ok: true,
                accepted: amount > 0,
                summary,
              } satisfies ServerToClientMessage);
              for (const [client, info] of clientPlayers.entries()) {
                if (
                  client.readyState === WebSocket.OPEN &&
                  client.bufferedAmount < 524288 &&
                  info.gridSize === activeGridSize
                ) {
                  client.send(statePayload);
                  if (
                    info.id === assignedPlayerId ||
                    resolvedTarget === '*' ||
                    info.id === resolvedTarget
                  ) {
                    client.send(resultPayload);
                  }
                }
              }
            }
          }
        } else if (msg.type === 'give_life') {
          const arena = getOrCreateArena(activeGridSize);
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
          const arena = getOrCreateArena(activeGridSize);
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
            const arena = getOrCreateArena(activeGridSize);
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
            arenas.get(activeGridSize)?.removePlayer(assignedPlayerId);
          }
          pruneEmptyArenas();
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
      pruneEmptyArenas();
    });
  });

  // Periodic keepalive ping to evict half-open dead sockets immediately
  setInterval(() => {
    let evicted = false;
    for (const [client, info] of clientPlayers.entries()) {
      if (!info.isAlive) {
        clientPlayers.delete(client);
        if (!isPlayerIdOwnedElsewhere(info.id, info.gridSize, client)) {
          arenas.get(info.gridSize)?.removePlayer(info.id);
        }
        client.terminate();
        evicted = true;
        continue;
      }
      info.isAlive = false;
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
    if (evicted) {
      pruneEmptyArenas();
    }
  }, 8000);

  // Drift-compensated authoritative game loop (steps and loads ONLY servers with active players)
  let nextTickAt = performance.now() + TICK_MS;
  const runTickLoop = () => {
    tickTimer = null;
    const now = performance.now();
    let count32 = 0;
    let count64 = 0;
    let total32 = 0;
    let total64 = 0;

    for (const [client, info] of clientPlayers.entries()) {
      const state = client.readyState;
      if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) continue;
      if (info.gridSize === 64) {
        total64++;
        if (state === WebSocket.OPEN) count64++;
      } else {
        total32++;
        if (state === WebSocket.OPEN) count32++;
      }
    }

    if (total32 === 0 && arenas.has(32)) arenas.delete(32);
    if (total64 === 0 && arenas.has(64)) arenas.delete(64);

    let buf32: Buffer | null = null;
    const arena32 = arenas.get(32);
    if (count32 > 0 && arena32) {
      const snap32 = arena32.step();
      snap32.onlinePlayers = Math.max(snap32.onlinePlayers, count32);
      buf32 = Buffer.from(
        JSON.stringify({
          type: 'state',
          state: packSnapshot(snap32),
        } satisfies ServerToClientMessage),
        'utf8'
      );
    }

    let buf64: Buffer | null = null;
    const arena64 = arenas.get(64);
    if (count64 > 0 && arena64) {
      const snap64 = arena64.step();
      snap64.onlinePlayers = Math.max(snap64.onlinePlayers, count64);
      buf64 = Buffer.from(
        JSON.stringify({
          type: 'state',
          state: packSnapshot(snap64),
        } satisfies ServerToClientMessage),
        'utf8'
      );
    }

    if (buf32 || buf64) {
      for (const [client, info] of clientPlayers.entries()) {
        if (client.readyState !== WebSocket.OPEN) continue;
        // Backpressure guard: allow full-grid 64x64 pellet flood frames while protecting stalled sockets
        if (client.bufferedAmount > 524288) continue;
        const payload = info.gridSize === 64 ? buf64 : buf32;
        if (payload) {
          client.send(payload, { binary: false });
        }
      }
    }

    if (arenas.size > 0 || clientPlayers.size > 0) {
      nextTickAt += TICK_MS;
      if (nextTickAt < now - TICK_MS) {
        nextTickAt = now + TICK_MS;
      }
      tickTimer = setTimeout(runTickLoop, Math.max(1, nextTickAt - performance.now()));
    }
  };

  scheduleTickLoop = () => {
    if (!tickTimer) {
      nextTickAt = performance.now() + TICK_MS;
      tickTimer = setTimeout(runTickLoop, TICK_MS);
    }
  };

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
