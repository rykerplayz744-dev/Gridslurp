import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { ArenaEngine } from './src/shared/arenaEngine';
import {
  ClientToServerMessage,
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

  const arena = new ArenaEngine(2);
  const clientPlayers = new Map<WebSocket, string>();

  // REST API endpoint for health & Vercel/HTTP fallback state inspection
  app.get('/api/arena', (_req, res) => {
    res.json({
      status: 'ok',
      mode: 'authoritative-ws',
      snapshot: arena.getSnapshot(),
    });
  });

  app.post('/api/arena', (_req, res) => {
    res.json({ ok: true, snapshot: arena.getSnapshot() });
  });

  wss.on('connection', (ws: WebSocket) => {
    let assignedPlayerId = `plr_${Math.random().toString(36).slice(2, 9)}`;
    clientPlayers.set(ws, assignedPlayerId);

    const sendMsg = (msg: ServerToClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    // Send initial welcome + current 32x32 arena state immediately
    sendMsg({
      type: 'welcome',
      playerId: assignedPlayerId,
      state: arena.getSnapshot(),
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientToServerMessage;
        if (msg.type === 'join') {
          if (msg.clientId && msg.clientId.trim().length > 0) {
            assignedPlayerId = msg.clientId;
            clientPlayers.set(ws, assignedPlayerId);
          }
          arena.spawnPlayer(assignedPlayerId, msg.name, msg.colorId);
          sendMsg({
            type: 'welcome',
            playerId: assignedPlayerId,
            state: arena.getSnapshot(),
          });
        } else if (msg.type === 'turn') {
          arena.queueTurn(assignedPlayerId, msg.dir);
        } else if (msg.type === 'respawn') {
          arena.spawnPlayer(assignedPlayerId, msg.name, msg.colorId);
          sendMsg({
            type: 'state',
            state: arena.getSnapshot(),
          });
        } else if (msg.type === 'leave') {
          arena.removePlayer(assignedPlayerId);
        }
      } catch {
        // Ignore malformed packets
      }
    });

    ws.on('close', () => {
      const pid = clientPlayers.get(ws);
      if (pid) {
        arena.removePlayer(pid);
        clientPlayers.delete(ws);
      }
    });
  });

  // Authoritative 32x32 game loop broadcasting state every TICK_MS
  setInterval(() => {
    const snapshot = arena.step();
    const payload = JSON.stringify({
      type: 'state',
      state: snapshot,
    } satisfies ServerToClientMessage);

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
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
    console.log(`GRIDSLURP 32x32 Arena Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
