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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.use(express.json());

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Maintain both the 32x32 Server (2 AI snakes) and the 64x64 Server (4 AI snakes) simultaneously
  const arenas = new Map<ServerGridSize, ArenaEngine>([
    [32, new ArenaEngine(2, 32)],
    [64, new ArenaEngine(4, 64)],
  ]);

  const clientPlayers = new Map<WebSocket, { id: string; gridSize: ServerGridSize }>();

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

  wss.on('connection', (ws: WebSocket) => {
    let assignedPlayerId = `plr_${Math.random().toString(36).slice(2, 9)}`;
    let activeGridSize: ServerGridSize = 32;
    clientPlayers.set(ws, { id: assignedPlayerId, gridSize: activeGridSize });

    const sendMsg = (msg: ServerToClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    // Send initial welcome + current 32x32 arena state immediately
    sendMsg({
      type: 'welcome',
      playerId: assignedPlayerId,
      state: arenas.get(activeGridSize)!.getSnapshot(),
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientToServerMessage;
        if (msg.type === 'select_server') {
          const newSize: ServerGridSize = msg.gridSize === 64 ? 64 : 32;
          if (newSize !== activeGridSize) {
            arenas.get(activeGridSize)?.removePlayer(assignedPlayerId);
            activeGridSize = newSize;
            clientPlayers.set(ws, { id: assignedPlayerId, gridSize: activeGridSize });
          }
          sendMsg({
            type: 'state',
            state: arenas.get(activeGridSize)!.getSnapshot(),
          });
        } else if (msg.type === 'join') {
          if (msg.clientId && msg.clientId.trim().length > 0) {
            assignedPlayerId = msg.clientId;
          }
          if (msg.gridSize === 64 || msg.gridSize === 32) {
            if (msg.gridSize !== activeGridSize) {
              arenas.get(activeGridSize)?.removePlayer(assignedPlayerId);
              activeGridSize = msg.gridSize;
            }
          }
          clientPlayers.set(ws, { id: assignedPlayerId, gridSize: activeGridSize });
          const arena = arenas.get(activeGridSize)!;
          arena.spawnPlayer(assignedPlayerId, msg.name, msg.colorId);
          sendMsg({
            type: 'welcome',
            playerId: assignedPlayerId,
            state: arena.getSnapshot(),
          });
        } else if (msg.type === 'turn') {
          arenas.get(activeGridSize)!.queueTurn(assignedPlayerId, msg.dir);
        } else if (msg.type === 'respawn') {
          if (msg.gridSize === 64 || msg.gridSize === 32) {
            if (msg.gridSize !== activeGridSize) {
              arenas.get(activeGridSize)?.removePlayer(assignedPlayerId);
              activeGridSize = msg.gridSize;
              clientPlayers.set(ws, { id: assignedPlayerId, gridSize: activeGridSize });
            }
          }
          const arena = arenas.get(activeGridSize)!;
          arena.spawnPlayer(assignedPlayerId, msg.name, msg.colorId);
          sendMsg({
            type: 'state',
            state: arena.getSnapshot(),
          });
        } else if (msg.type === 'leave') {
          arenas.get(activeGridSize)!.removePlayer(assignedPlayerId);
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      const info = clientPlayers.get(ws);
      if (info) {
        arenas.get(info.gridSize)?.removePlayer(info.id);
        clientPlayers.delete(ws);
      }
    });
  });

  // Authoritative game loop stepping both the 32x32 Server and the 64x64 Server every TICK_MS
  setInterval(() => {
    const snap32 = arenas.get(32)!.step();
    const snap64 = arenas.get(64)!.step();

    const payload32 = JSON.stringify({
      type: 'state',
      state: snap32,
    } satisfies ServerToClientMessage);

    const payload64 = JSON.stringify({
      type: 'state',
      state: snap64,
    } satisfies ServerToClientMessage);

    for (const [client, info] of clientPlayers.entries()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(info.gridSize === 64 ? payload64 : payload32);
      }
    }
  }, TICK_MS);

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
