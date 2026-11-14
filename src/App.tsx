import mqtt, { MqttClient } from 'mqtt';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArenaEngine } from './shared/arenaEngine';
import {
  ArenaSnapshot,
  ClientToServerMessage,
  Direction,
  GRID_SIZE,
  ServerGridSize,
  ServerToClientMessage,
  SNAKE_PALETTES,
  TICK_MS,
} from './shared/gameTypes';
import { soundEngine } from './utils/soundEngine';

const getMeshTopic = (size: ServerGridSize) => `gridslurp/v2/arena/global_main_${size}x${size}`;
const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker-cn.emqx.io:8084/mqtt',
];

type GameState = 'TITLE_MENU' | 'PLAYING' | 'PAUSED' | 'GAME_OVER';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
  decay: number;
}

interface FloatingPopup {
  x: number;
  y: number;
  text: string;
  color: string;
  alpha: number;
  vy: number;
}

interface Shockwave {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  alpha: number;
}

export default function App() {
  const [gameState, setGameState] = useState<GameState>('TITLE_MENU');
  const [serverGridSize, setServerGridSize] = useState<ServerGridSize>(32);
  const [playerName, setPlayerName] = useState<string>('VIPER_01');
  const [selectedColorId, setSelectedColorId] = useState<string>('emerald');
  const [muted, setMuted] = useState<boolean>(soundEngine.muted);
  const [, setConnectionMode] = useState<'ws' | 'local-sync'>('ws');

  // HUD state synced at tick rate (not 60fps) to keep React lightweight
  const [hudStats, setHudStats] = useState<{
    score: number;
    length: number;
    kills: number;
    slurped: number;
    headX: number;
    headY: number;
    alive: boolean;
    shieldTicks: number;
    deathReason?: string;
    killedByName?: string;
    bigPelletsOnGrid: number;
    onlineCount: number;
    leaderboard: Array<{
      id: string;
      name: string;
      score: number;
      length: number;
      kills: number;
      color: string;
      isMe: boolean;
      isBot: boolean;
    }>;
    killFeed: Array<{
      id: string;
      text: string;
      color: string;
    }>;
  }>({
    score: 0,
    length: 4,
    kills: 0,
    slurped: 0,
    headX: 16,
    headY: 16,
    alive: true,
    shieldTicks: 0,
    bigPelletsOnGrid: 0,
    onlineCount: 1,
    leaderboard: [],
    killFeed: [],
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mqttRef = useRef<MqttClient | null>(null);
  const localEngineRef = useRef<ArenaEngine | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  const playerIdRef = useRef<string>(`plr_${Math.random().toString(36).slice(2, 9)}`);
  const peerOrderRef = useRef<number>(Date.now() + Math.random());
  const activePeersRef = useRef<
    Map<
      string,
      {
        order: number;
        lastSeen: number;
        playing: boolean;
        name: string;
        colorId: string;
      }
    >
  >(new Map());
  const lastRemoteCoordStateAtRef = useRef<number>(0);
  const lastAutoJoinSentAtRef = useRef<number>(0);
  const myJoinInfoRef = useRef<{ name: string; colorId: string; playing: boolean }>({
    name: 'VIPER_01',
    colorId: 'emerald',
    playing: false,
  });

  const snapshotRef = useRef<ArenaSnapshot | null>(null);
  const lastSnapshotTimeRef = useRef<number>(performance.now());
  const processedKillsRef = useRef<Set<string>>(new Set());
  const processedSlurpsRef = useRef<Set<string>>(new Set());
  const processedTelegraphsRef = useRef<Set<string>>(new Set());

  // Visual juice pools
  const particlesRef = useRef<Particle[]>([]);
  const popupsRef = useRef<FloatingPopup[]>([]);
  const shockwavesRef = useRef<Shockwave[]>([]);
  const shakeRef = useRef<number>(0);
  const hitstopUntilRef = useRef<number>(0);
  const gameStateRef = useRef<GameState>(gameState);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  const spawnBurst = useCallback((gridX: number, gridY: number, color: string, count = 18) => {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
      const speed = 1.2 + Math.random() * 4.2;
      particlesRef.current.push({
        x: gridX + 0.5,
        y: gridY + 0.5,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color,
        size: 0.22 + Math.random() * 0.25,
        alpha: 1,
        decay: 0.024 + Math.random() * 0.02,
      });
    }
  }, []);

  const processSnapshotEvents = useCallback(
    (snap: ArenaSnapshot) => {
      const myId = playerIdRef.current;
      const me = snap.snakes.find((s) => s.id === myId);

      // New spawn telegraphs
      for (const tele of snap.telegraphs) {
        if (!processedTelegraphsRef.current.has(tele.id)) {
          processedTelegraphsRef.current.add(tele.id);
          if (gameStateRef.current === 'PLAYING') {
            soundEngine.playSpawnBeacon();
          }
        }
      }

      // New pellet slurps
      for (const slurp of snap.recentSlurps) {
        if (!processedSlurpsRef.current.has(slurp.id)) {
          processedSlurpsRef.current.add(slurp.id);
          spawnBurst(slurp.toX, slurp.toY, '#F59E0B', 8);

          if (slurp.snakeId === myId && gameStateRef.current === 'PLAYING') {
            soundEngine.playPelletSlurp();
            popupsRef.current.push({
              x: slurp.toX + 0.5,
              y: slurp.toY,
              text: `+${slurp.value}`,
              color: '#FDE047',
              alpha: 1,
              vy: -0.055,
            });
          }
        }
      }

      // New kills / crashes
      for (const kill of snap.recentKills) {
        if (!processedKillsRef.current.has(kill.id)) {
          processedKillsRef.current.add(kill.id);
          spawnBurst(kill.x, kill.y, kill.victimColor, 26);
          shockwavesRef.current.push({
            x: kill.x + 0.5,
            y: kill.y + 0.5,
            radius: 0.4,
            maxRadius: 4.5,
            color: '#F59E0B',
            alpha: 0.95,
          });

          if (kill.victimId === myId && gameStateRef.current === 'PLAYING') {
            soundEngine.playPlayerDeath();
            shakeRef.current = 14;
            hitstopUntilRef.current = performance.now() + 65;
            setGameState('GAME_OVER');
          } else if (kill.killerId === myId && gameStateRef.current === 'PLAYING') {
            soundEngine.playRivalKill(true);
            shakeRef.current = 9;
            hitstopUntilRef.current = performance.now() + 45;
            popupsRef.current.push({
              x: kill.x + 0.5,
              y: kill.y - 0.3,
              text: `TAKEDOWN +500`,
              color: '#34D399',
              alpha: 1,
              vy: -0.06,
            });
          } else if (gameStateRef.current === 'PLAYING') {
            soundEngine.playRivalKill(false);
            shakeRef.current = 4;
          }
        }
      }

      // Update HUD state
      const aliveSnakes = snap.snakes.filter((s) => s.alive);
      const sorted = [...aliveSnakes].sort((a, b) => b.score - a.score);

      const feed = snap.recentKills
        .slice(-4)
        .reverse()
        .map((k) => {
          let desc = `${k.victimName} hit the 32x32 wall (${k.pelletsDropped} big pellets!)`;
          if (k.reason === 'SELF_CRASH') {
            desc = `${k.victimName} ran over itself (${k.pelletsDropped} big pellets!)`;
          } else if (k.reason === 'KILLED_BY_SNAKE' && k.killerName) {
            desc = `${k.killerName} cut off ${k.victimName} (${k.pelletsDropped} big pellets!)`;
          } else if (k.reason === 'HEAD_COLLISION' && k.killerName) {
            desc = `${k.killerName} shattered ${k.victimName} head-on!`;
          }
          return {
            id: k.id,
            text: desc,
            color: k.victimColor,
          };
        });

      const activeSize = snap.gridSize || GRID_SIZE;
      setHudStats((prev) => ({
        score: me ? me.score : prev.score,
        length: me ? me.segments.length : prev.length,
        kills: me ? me.kills : prev.kills,
        slurped: me ? me.pelletsSlurped : prev.slurped,
        headX: me && me.segments[0] ? Math.max(0, Math.min(activeSize - 1, me.segments[0].x)) : prev.headX,
        headY: me && me.segments[0] ? Math.max(0, Math.min(activeSize - 1, me.segments[0].y)) : prev.headY,
        alive: me ? me.alive : false,
        shieldTicks: me ? me.shieldTicks : 0,
        deathReason: me?.deathReason || prev.deathReason,
        killedByName: me?.killedByName || prev.killedByName,
        bigPelletsOnGrid: snap.pellets.length,
        onlineCount: Math.max(
          snap.onlinePlayers,
          1 +
            Array.from(activePeersRef.current.values()).filter(
              (p) => performance.now() - p.lastSeen < 6500
            ).length
        ),
        leaderboard: sorted.slice(0, 6).map((s) => ({
          id: s.id,
          name: s.name,
          score: s.score,
          length: s.segments.length,
          kills: s.kills,
          color: s.color.head,
          isMe: s.id === myId,
          isBot: s.isBot,
        })),
        killFeed: feed,
      }));
    },
    [spawnBurst]
  );

  // Setup Live Multiplayer: Direct /ws Server + Global Cross-Device WSS Mesh (for Vercel) + BroadcastChannel
  useEffect(() => {
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let localInterval: ReturnType<typeof setInterval> | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let isUnmounted = false;
    const meshTopic = getMeshTopic(serverGridSize);
    activePeersRef.current.clear();
    localEngineRef.current = null;

    const publishMeshPacket = (packet: Record<string, unknown>) => {
      const serialized = JSON.stringify(packet);
      if (mqttRef.current && mqttRef.current.connected) {
        try {
          mqttRef.current.publish(meshTopic, serialized, { qos: 0 });
        } catch {
          // ignore publish error
        }
      }
      try {
        broadcastChannelRef.current?.postMessage(packet);
      } catch {
        // ignore broadcast channel error
      }
    };

    const isSelfCoordinator = (now: number): boolean => {
      const myId = playerIdRef.current;
      const myOrder = peerOrderRef.current;
      for (const [pid, info] of activePeersRef.current.entries()) {
        if (pid === myId) continue;
        if (now - info.lastSeen > 3000) continue;
        if (info.order < myOrder || (info.order === myOrder && pid < myId)) {
          // Another active peer has higher priority; only yield if they are actively broadcasting state
          if (now - lastRemoteCoordStateAtRef.current < 2200) {
            return false;
          }
        }
      }
      return true;
    };

    const handleMeshPacket = (data: Record<string, unknown>) => {
      if (!data || typeof data.type !== 'string') return;
      const senderId = String(data.senderId || '');
      if (!senderId || senderId === playerIdRef.current) return;

      const now = performance.now();
      const senderOrder = Number(data.senderOrder) || now;

      const existingPeer = activePeersRef.current.get(senderId);
      activePeersRef.current.set(senderId, {
        order: senderOrder,
        lastSeen: now,
        playing: typeof data.playing === 'boolean' ? data.playing : existingPeer?.playing ?? false,
        name: typeof data.name === 'string' ? data.name : existingPeer?.name ?? 'PLAYER',
        colorId: typeof data.colorId === 'string' ? data.colorId : existingPeer?.colorId ?? 'cyan',
      });

      if (data.type === 'mesh_state' && data.state && localEngineRef.current) {
        const myId = playerIdRef.current;
        const myOrder = peerOrderRef.current;
        const senderIsPrior =
          senderOrder < myOrder || (senderOrder === myOrder && senderId < myId);

        if (senderIsPrior) {
          lastRemoteCoordStateAtRef.current = now;
          const remoteSnap = data.state as ArenaSnapshot;
          localEngineRef.current.hydrateFromSnapshot(remoteSnap);
          snapshotRef.current = remoteSnap;
          lastSnapshotTimeRef.current = now;
          processSnapshotEvents(remoteSnap);

          // If we are currently playing and not yet spawned on the remote coordinator's board, request spawn
          if (
            myJoinInfoRef.current.playing &&
            gameStateRef.current === 'PLAYING' &&
            !remoteSnap.snakes.some((s) => s.id === myId && s.alive) &&
            now - lastAutoJoinSentAtRef.current > 650
          ) {
            lastAutoJoinSentAtRef.current = now;
            publishMeshPacket({
              type: 'mesh_cmd',
              senderId: myId,
              senderOrder: myOrder,
              cmd: {
                type: 'join',
                clientId: myId,
                name: myJoinInfoRef.current.name,
                colorId: myJoinInfoRef.current.colorId,
                gridSize: serverGridSize,
              },
            });
          }
        }
      } else if (data.type === 'mesh_cmd' && data.cmd && localEngineRef.current) {
        const cmd = data.cmd as ClientToServerMessage & { clientId?: string };
        const targetId = cmd.clientId || senderId;
        const engine = localEngineRef.current;

        if (cmd.type === 'join') {
          const existing = engine.snakes.get(targetId);
          if (!existing || !existing.alive) {
            engine.spawnPlayer(targetId, cmd.name, cmd.colorId);
          }
        } else if (cmd.type === 'respawn') {
          engine.spawnPlayer(targetId, cmd.name, cmd.colorId);
        } else if (cmd.type === 'turn') {
          engine.queueTurn(targetId, cmd.dir);
        } else if (cmd.type === 'leave') {
          engine.removePlayer(targetId);
          myJoinInfoRef.current = { ...myJoinInfoRef.current };
        }
      }
    };

    const startGlobalMeshEngine = () => {
      if (isUnmounted || localEngineRef.current) return;
      setConnectionMode('ws');
      const engine = new ArenaEngine(2, serverGridSize);
      localEngineRef.current = engine;

      // 1. Local multi-tab BroadcastChannel
      try {
        const bc = new BroadcastChannel(`gridslurp_${serverGridSize}x${serverGridSize}_arena_v2`);
        broadcastChannelRef.current = bc;
        bc.onmessage = (ev) => {
          handleMeshPacket(ev.data);
        };
      } catch {
        // BroadcastChannel optional
      }

      // 2. Global Cross-Device WSS Relay (MQTT over WebSockets - works on Vercel & worldwide browsers)
      try {
        const client = mqtt.connect(MQTT_BROKERS[0], {
          clientId: `gridslurp_${playerIdRef.current}_${Math.random().toString(16).slice(2, 6)}`,
          clean: true,
          connectTimeout: 4000,
          reconnectPeriod: 2000,
        });
        mqttRef.current = client;

        client.on('connect', () => {
          if (isUnmounted) return;
          setConnectionMode('ws');
          client.subscribe(meshTopic, { qos: 0 });
          publishMeshPacket({
            type: 'mesh_heartbeat',
            senderId: playerIdRef.current,
            senderOrder: peerOrderRef.current,
            playing: myJoinInfoRef.current.playing,
            name: myJoinInfoRef.current.name,
            colorId: myJoinInfoRef.current.colorId,
          });
        });

        client.on('message', (_topic, payload) => {
          try {
            const parsed = JSON.parse(payload.toString());
            handleMeshPacket(parsed);
          } catch {
            // ignore malformed packet
          }
        });
      } catch {
        // Fallback if WSS blocked
      }

      const initialSnap = engine.getSnapshot();
      snapshotRef.current = initialSnap;
      lastSnapshotTimeRef.current = performance.now();
      processSnapshotEvents(initialSnap);

      // Periodic peer heartbeat & stale player cleanup
      heartbeatInterval = setInterval(() => {
        const now = performance.now();
        publishMeshPacket({
          type: 'mesh_heartbeat',
          senderId: playerIdRef.current,
          senderOrder: peerOrderRef.current,
          playing: myJoinInfoRef.current.playing,
          name: myJoinInfoRef.current.name,
          colorId: myJoinInfoRef.current.colorId,
        });

        // Clean up disconnected remote human players after 6.5s of silence
        for (const [pid, info] of activePeersRef.current.entries()) {
          if (now - info.lastSeen > 6500) {
            activePeersRef.current.delete(pid);
            localEngineRef.current?.removePlayer(pid);
          }
        }
      }, 950);

      // Authoritative Room Coordinator step loop
      localInterval = setInterval(() => {
        const now = performance.now();
        if (!isSelfCoordinator(now)) {
          return;
        }
        const snap = engine.step();
        const activeHumans =
          1 +
          Array.from(activePeersRef.current.values()).filter((p) => now - p.lastSeen < 6500)
            .length;
        snap.onlinePlayers = Math.max(snap.onlinePlayers, activeHumans);

        snapshotRef.current = snap;
        lastSnapshotTimeRef.current = now;
        processSnapshotEvents(snap);

        publishMeshPacket({
          type: 'mesh_state',
          senderId: playerIdRef.current,
          senderOrder: peerOrderRef.current,
          state: snap,
        });
      }, TICK_MS);
    };

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      fallbackTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          startGlobalMeshEngine();
        }
      }, 950);

      ws.onopen = () => {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        setConnectionMode('ws');
        ws.send(JSON.stringify({ type: 'select_server', gridSize: serverGridSize }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerToClientMessage;
          if (msg.type === 'welcome') {
            playerIdRef.current = msg.playerId;
            snapshotRef.current = msg.state;
            lastSnapshotTimeRef.current = performance.now();
            processSnapshotEvents(msg.state);
          } else if (msg.type === 'state') {
            snapshotRef.current = msg.state;
            lastSnapshotTimeRef.current = performance.now();
            processSnapshotEvents(msg.state);
          }
        } catch {
          // ignore parse error
        }
      };

      ws.onerror = () => {
        startGlobalMeshEngine();
      };

      ws.onclose = () => {
        startGlobalMeshEngine();
      };
    } catch {
      startGlobalMeshEngine();
    }

    return () => {
      isUnmounted = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (localInterval) clearInterval(localInterval);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }
      if (mqttRef.current) {
        try {
          mqttRef.current.end(true);
        } catch {
          // ignore
        }
      }
      if (broadcastChannelRef.current) {
        try {
          broadcastChannelRef.current.close();
        } catch {
          // ignore
        }
      }
    };
  }, [processSnapshotEvents, serverGridSize]);

  const sendCommand = useCallback(
    (msg: ClientToServerMessage) => {
      const pid = playerIdRef.current;

      if (msg.type === 'join' || msg.type === 'respawn') {
        myJoinInfoRef.current = {
          name: msg.name,
          colorId: msg.colorId,
          playing: true,
        };
      } else if (msg.type === 'leave') {
        myJoinInfoRef.current.playing = false;
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
        return;
      }

      // Global Mesh / Vercel Multiplayer command dispatch
      const engine = localEngineRef.current;
      if (engine) {
        if (msg.type === 'join' || msg.type === 'respawn') {
          engine.spawnPlayer(pid, msg.name, msg.colorId);
          snapshotRef.current = engine.getSnapshot();
        } else if (msg.type === 'turn') {
          engine.queueTurn(pid, msg.dir);
        } else if (msg.type === 'leave') {
          engine.removePlayer(pid);
        }
      }

      const packet = {
        type: 'mesh_cmd',
        senderId: pid,
        senderOrder: peerOrderRef.current,
        cmd: { ...msg, clientId: pid },
      };

      if (mqttRef.current && mqttRef.current.connected) {
        try {
          mqttRef.current.publish(getMeshTopic(serverGridSize), JSON.stringify(packet), { qos: 0 });
        } catch {
          // ignore
        }
      }
      try {
        broadcastChannelRef.current?.postMessage(packet);
      } catch {
        // ignore
      }
    },
    [serverGridSize]
  );

  const handleStartOrRespawn = useCallback(() => {
    const cleanName = playerName.trim().toUpperCase().slice(0, 14) || 'VIPER_01';
    lastAutoJoinSentAtRef.current = performance.now();
    sendCommand({
      type: 'join',
      name: cleanName,
      colorId: selectedColorId,
      clientId: playerIdRef.current,
      gridSize: serverGridSize,
    });
    setGameState('PLAYING');
  }, [playerName, selectedColorId, serverGridSize, sendCommand]);

  const handleToggleMute = useCallback(() => {
    const nextMuted = soundEngine.toggleMute();
    setMuted(nextMuted);
  }, []);

  // Strict WASD & Arrow Keys directional input listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore shortcuts if typing in callsign input on Title Screen
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') {
        if (e.key === 'Enter') {
          e.preventDefault();
          (document.activeElement as HTMLElement)?.blur();
          handleStartOrRespawn();
        }
        return;
      }

      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        handleToggleMute();
        return;
      }

      if (gameState === 'TITLE_MENU' || gameState === 'GAME_OVER') {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleStartOrRespawn();
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        setGameState((prev) => (prev === 'PLAYING' ? 'PAUSED' : 'PLAYING'));
        return;
      }

      if (gameState !== 'PLAYING') return;

      // Strictly WASD and Arrow Keys for directional movement on the 32x32 grid
      let requestedDir: Direction | null = null;
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          requestedDir = 'UP';
          break;
        case 'KeyS':
        case 'ArrowDown':
          requestedDir = 'DOWN';
          break;
        case 'KeyA':
        case 'ArrowLeft':
          requestedDir = 'LEFT';
          break;
        case 'KeyD':
        case 'ArrowRight':
          requestedDir = 'RIGHT';
          break;
        default:
          break;
      }

      if (requestedDir) {
        e.preventDefault();
        soundEngine.playTurnBlip();
        sendCommand({ type: 'turn', dir: requestedDir });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gameState, handleStartOrRespawn, handleToggleMute, sendCommand]);

  // 60FPS Hardware-Accelerated 32x32 Pixel Matrix Canvas Loop
  useEffect(() => {
    let rafId = 0;

    const renderFrame = (now: number) => {
      rafId = requestAnimationFrame(renderFrame);

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Hitstop freeze for heavy collision impact feel
      if (now < hitstopUntilRef.current) {
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const displaySize = canvas.clientWidth;
      if (displaySize === 0) return;

      const targetPx = Math.round(displaySize * dpr);
      if (canvas.width !== targetPx || canvas.height !== targetPx) {
        canvas.width = targetPx;
        canvas.height = targetPx;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // Apply decaying screen shake
      if (shakeRef.current > 0.2) {
        const dx = (Math.random() - 0.5) * shakeRef.current;
        const dy = (Math.random() - 0.5) * shakeRef.current;
        ctx.translate(dx, dy);
        shakeRef.current *= 0.84;
      } else {
        shakeRef.current = 0;
      }

      const snap = snapshotRef.current;
      const activeGridSize = snap?.gridSize || serverGridSize;
      const boardPx = displaySize;
      const cellPx = boardPx / activeGridSize;
      const gap = Math.max(0.9, cellPx * 0.09);

      // 1. Deep Obsidian Matrix Backplane
      ctx.fillStyle = '#070A0F';
      ctx.fillRect(0, 0, boardPx, boardPx);

      // 2. Render all unlit physical LED pixel sockets
      for (let y = 0; y < activeGridSize; y++) {
        for (let x = 0; x < activeGridSize; x++) {
          const isEdgeTile =
            x === 0 || y === 0 || x === activeGridSize - 1 || y === activeGridSize - 1;
          ctx.fillStyle = isEdgeTile ? '#131826' : '#0E1522';
          ctx.fillRect(
            x * cellPx + gap * 0.5,
            y * cellPx + gap * 0.5,
            cellPx - gap,
            cellPx - gap
          );
        }
      }

      // Subtle 8x8 sector hairlines for spatial navigation on the matrix
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      for (let i = 8; i < activeGridSize; i += 8) {
        const pos = i * cellPx;
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, boardPx);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(boardPx, pos);
        ctx.stroke();
      }

      if (snap) {
        const myId = playerIdRef.current;
        const me = snap.snakes.find((s) => s.id === myId && s.alive);

        // 3. Render Nearby Rival Spawn Telegraphs (Flashing Radar Crosshairs on the 32x32 grid)
        const pulseFast = Math.sin(now * 0.022) > 0;
        for (const tele of snap.telegraphs) {
          const cx = (tele.x + 0.5) * cellPx;
          const cy = (tele.y + 0.5) * cellPx;

          ctx.save();
          ctx.strokeStyle = pulseFast ? '#F59E0B' : tele.color.head;
          ctx.lineWidth = 2;
          ctx.strokeRect(
            tele.x * cellPx - 2,
            tele.y * cellPx - 2,
            cellPx + 4,
            cellPx + 4
          );

          // Expanding target diamond
          const rad = cellPx * (0.9 + 0.35 * Math.sin(now * 0.015));
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = '#FDE047';
          ctx.font = `700 ${Math.max(9, Math.floor(cellPx * 0.42))}px "IBM Plex Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(`SPAWN ${tele.ticksLeft}`, cx, tele.y * cellPx - 5);
          ctx.restore();
        }

        // 4. Render BIG FLASHING PELLETS dropped by killed snakes!
        for (const pellet of snap.pellets) {
          // High-visibility multi-frequency strobe so big pellets unmistakably flash
          const flashPhase = Math.floor(now / 85 + pellet.x * 3 + pellet.y * 5) % 3;
          const primaryColor =
            flashPhase === 0 ? '#FEF08A' : flashPhase === 1 ? '#F59E0B' : pellet.color;

          const px = pellet.x * cellPx;
          const py = pellet.y * cellPx;
          const cx = px + cellPx * 0.5;
          const cy = py + cellPx * 0.5;

          // Outer flashing halo on adjacent pixel border
          const scalePulse = 0.14 * Math.sin(now * 0.018 + pellet.x);
          ctx.save();
          ctx.shadowColor = '#F59E0B';
          ctx.shadowBlur = 14;

          // Glowing outer pixel frame
          ctx.fillStyle = primaryColor;
          const expand = cellPx * (0.1 + scalePulse);
          ctx.fillRect(
            px - expand * 0.5,
            py - expand * 0.5,
            cellPx + expand,
            cellPx + expand
          );

          // White-hot inner diamond core
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(
            px + cellPx * 0.24,
            py + cellPx * 0.24,
            cellPx * 0.52,
            cellPx * 0.52
          );

          // Subtle pulsing ring around big trophy pellets
          if (pellet.value >= 200 || flashPhase === 0) {
            ctx.strokeStyle = 'rgba(254, 240, 138, 0.75)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(cx, cy, cellPx * 0.72, 0, Math.PI * 2);
            ctx.stroke();
          }

          ctx.restore();
        }

        // 5. Render All Snakes as Lit Colored Pixels on the 32x32 Grid
        for (const snake of snap.snakes) {
          if (!snake.alive) continue;
          const isMe = snake.id === myId;
          const len = snake.segments.length;
          const isShielded = (snake.shieldTicks || 0) > 0;
          const shieldBlink = isShielded ? 0.62 + 0.38 * Math.sin(now * 0.028) : 1;

          // Draw body segments from tail to head so the head pixel sits cleanly on top
          for (let i = len - 1; i >= 0; i--) {
            const seg = snake.segments[i];
            if (seg.x < 0 || seg.x >= activeGridSize || seg.y < 0 || seg.y >= activeGridSize) continue;

            const sx = seg.x * cellPx + gap * 0.5;
            const sy = seg.y * cellPx + gap * 0.5;
            const sw = cellPx - gap;
            const sh = cellPx - gap;

            ctx.save();
            ctx.globalAlpha = shieldBlink;

            if (isShielded) {
              ctx.strokeStyle = '#38BDF8';
              ctx.lineWidth = 1.5;
              ctx.strokeRect(sx - 1, sy - 1, sw + 2, sh + 2);
            }

            if (i === 0) {
              // Head Pixel: High-luminance phosphor + directional eyes
              ctx.shadowColor = isShielded ? '#38BDF8' : snake.color.head;
              ctx.shadowBlur = isMe ? 14 : 9;
              ctx.fillStyle = snake.color.head;
              ctx.fillRect(sx, sy, sw, sh);

              // Crisp inner highlight for player snake head
              if (isMe || isShielded) {
                ctx.strokeStyle = isShielded ? '#E0F2FE' : '#FFFFFF';
                ctx.lineWidth = 1.5;
                ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
              }

              // Directional pixel eyes on the head cell
              ctx.fillStyle = '#080B10';
              const eyeSize = Math.max(2, sw * 0.2);
              let e1x = sx + sw * 0.22;
              let e1y = sy + sh * 0.22;
              let e2x = sx + sw * 0.62;
              let e2y = sy + sh * 0.22;

              if (snake.dir === 'DOWN') {
                e1y = sy + sh * 0.62;
                e2y = sy + sh * 0.62;
              } else if (snake.dir === 'LEFT') {
                e1x = sx + sw * 0.2;
                e1y = sy + sh * 0.22;
                e2x = sx + sw * 0.2;
                e2y = sy + sh * 0.62;
              } else if (snake.dir === 'RIGHT') {
                e1x = sx + sw * 0.64;
                e1y = sy + sh * 0.22;
                e2x = sx + sw * 0.64;
                e2y = sy + sh * 0.62;
              }
              ctx.fillRect(e1x, e1y, eyeSize, eyeSize);
              ctx.fillRect(e2x, e2y, eyeSize, eyeSize);
            } else {
              // Lit Body Pixel on the Grid
              const ratio = i / Math.max(1, len - 1);
              ctx.fillStyle = ratio > 0.72 ? snake.color.tail : snake.color.body;
              ctx.fillRect(sx, sy, sw, sh);

              // Subtle lit LED diode center inside each body pixel
              ctx.fillStyle = snake.color.head;
              ctx.globalAlpha = Math.max(0.18, 0.55 * (1 - ratio)) * shieldBlink;
              ctx.fillRect(
                sx + sw * 0.25,
                sy + sh * 0.25,
                sw * 0.5,
                sh * 0.5
              );
            }
            ctx.restore();
          }

          // Floating Callsign & Fail-Safe Shield Timer readout above snake head
          const head = snake.segments[0];
          if (head && head.x >= 0 && head.x < activeGridSize && head.y >= 0 && head.y < activeGridSize) {
            const hx = (head.x + 0.5) * cellPx;
            const hy = head.y * cellPx - 4;
            ctx.save();
            ctx.font = `${isMe ? '700' : '600'} ${Math.max(9, Math.floor(cellPx * 0.42))}px "IBM Plex Mono", monospace`;
            ctx.textAlign = 'center';
            ctx.fillStyle = isShielded ? '#7DD3FC' : isMe ? '#FFFFFF' : 'rgba(241, 245, 249, 0.82)';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
            ctx.shadowBlur = 4;
            const shieldSec = ((snake.shieldTicks * TICK_MS) / 1000).toFixed(1);
            const label = isShielded
              ? `${isMe ? '★ ' : ''}${snake.name} [SAFE ${shieldSec}s]`
              : isMe
                ? `★ ${snake.name}`
                : snake.name;
            ctx.fillText(label, hx, Math.max(11, hy));
            ctx.restore();
          }
        }

        // 6. Unforgiving Danger Perimeter Alert when player is within 2 pixels of the edge!
        const head = me?.segments[0];
        const nearEdge =
          head &&
          (head.x <= 1 ||
            head.x >= activeGridSize - 2 ||
            head.y <= 1 ||
            head.y >= activeGridSize - 2);

        ctx.save();
        ctx.strokeStyle = nearEdge
          ? `rgba(244, 63, 94, ${0.7 + 0.3 * Math.sin(now * 0.025)})`
          : 'rgba(244, 63, 94, 0.42)';
        ctx.lineWidth = nearEdge ? 4 : 2;
        ctx.strokeRect(1, 1, boardPx - 2, boardPx - 2);
        ctx.restore();
      }

      // 7. Render Shockwaves
      const nextWaves: Shockwave[] = [];
      for (const w of shockwavesRef.current) {
        w.radius += 0.22;
        w.alpha *= 0.88;
        if (w.alpha > 0.04 && w.radius <= w.maxRadius) {
          ctx.save();
          ctx.strokeStyle = w.color;
          ctx.globalAlpha = w.alpha;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(w.x * cellPx, w.y * cellPx, w.radius * cellPx, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          nextWaves.push(w);
        }
      }
      shockwavesRef.current = nextWaves;

      // 8. Render Pixel-Shatter Particles
      const nextParticles: Particle[] = [];
      for (const p of particlesRef.current) {
        p.x += p.vx * 0.06;
        p.y += p.vy * 0.06;
        p.vx *= 0.92;
        p.vy *= 0.92;
        p.alpha -= p.decay;
        if (p.alpha > 0.02) {
          ctx.save();
          ctx.fillStyle = p.color;
          ctx.globalAlpha = p.alpha;
          const s = p.size * cellPx;
          ctx.fillRect(p.x * cellPx - s * 0.5, p.y * cellPx - s * 0.5, s, s);
          ctx.restore();
          nextParticles.push(p);
        }
      }
      particlesRef.current = nextParticles;

      // 9. Render Floating Score / Takedown Popups
      const nextPopups: FloatingPopup[] = [];
      for (const pop of popupsRef.current) {
        pop.y += pop.vy;
        pop.alpha -= 0.022;
        if (pop.alpha > 0.04) {
          ctx.save();
          ctx.font = `700 ${Math.max(11, Math.floor(cellPx * 0.52))}px "IBM Plex Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.fillStyle = pop.color;
          ctx.globalAlpha = pop.alpha;
          ctx.shadowColor = '#000000';
          ctx.shadowBlur = 4;
          ctx.fillText(pop.text, pop.x * cellPx, pop.y * cellPx);
          ctx.restore();
          nextPopups.push(pop);
        }
      }
      popupsRef.current = nextPopups;

      ctx.restore();
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [serverGridSize]);

  const deathExplanation = (() => {
    switch (hudStats.deathReason) {
      case 'WALL_CRASH':
        return 'You ran off the unforgiving 32x32 pixel grid perimeter.';
      case 'SELF_CRASH':
        return 'You went over top of your own lit pixel trail.';
      case 'KILLED_BY_SNAKE':
        return `You ran into ${hudStats.killedByName || 'a rival snake'} and burst into flashing big pellets.`;
      case 'HEAD_COLLISION':
        return `Eliminated in a head-to-head collision with ${hudStats.killedByName || 'a rival snake'}.`;
      default:
        return 'Your snake shattered into big flashing pellets on the 32x32 matrix.';
    }
  })();

  return (
    <div className="relative w-screen h-screen bg-[#080B10] text-[#F1F5F9] flex flex-col justify-between overflow-hidden select-none">
      {/* Top Perimeter HUD Bar (World-Matched, Low-Occlusion) */}
      <header className="w-full h-12 px-5 bg-[#0B0F17]/95 border-b border-slate-800/80 flex items-center justify-between gap-6 z-20 shrink-0">
        <div className="flex items-center gap-4 shrink-0">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="currentColor">
              <rect x="2" y="2" width="5" height="5" />
              <rect x="9" y="2" width="5" height="5" />
              <rect x="9" y="9" width="5" height="5" />
              <rect x="16" y="9" width="5" height="5" />
              <rect x="16" y="16" width="5" height="5" className="text-amber-400" />
            </svg>
            <span className="font-display font-bold tracking-wider text-sm text-white whitespace-nowrap">
              GRIDSLURP
            </span>
          </div>

          <span className="text-slate-700" aria-hidden="true">
            ·
          </span>

          <div className="hidden sm:flex items-center gap-3 text-xs text-slate-400 font-mono-tabular">
            <span>
              POS{' '}
              <strong className="text-slate-200">
                ({String(hudStats.headX).padStart(2, '0')},{String(hudStats.headY).padStart(2, '0')})
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              FLASHING PELLETS{' '}
              <strong className="text-amber-400">{hudStats.bigPelletsOnGrid}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              ONLINE{' '}
              <strong className="text-emerald-400">
                {hudStats.onlineCount} {hudStats.onlineCount === 1 ? 'PLAYER' : 'PLAYERS'}
              </strong>
            </span>
            {hudStats.shieldTicks > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-sky-300 font-semibold">
                  SPAWN SAFE {((hudStats.shieldTicks * TICK_MS) / 1000).toFixed(1)}s
                </span>
              </>
            )}
          </div>
        </div>

        {/* Center Telemetry Strip */}
        <div className="flex items-center gap-5 font-mono-tabular text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">SCORE</span>
            <span className="text-amber-400 font-bold text-sm">{hudStats.score}</span>
          </div>
          <span className="text-slate-700" aria-hidden="true">
            /
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">PIXELS</span>
            <span className="text-emerald-400 font-bold text-sm">{hudStats.length}</span>
          </div>
          <span className="text-slate-700" aria-hidden="true">
            /
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">KILLS</span>
            <span className="text-rose-400 font-bold text-sm">{hudStats.kills}</span>
          </div>
          <span className="hidden md:inline text-slate-700" aria-hidden="true">
            /
          </span>
          <div className="hidden md:flex items-center gap-1.5">
            <span className="text-slate-400">SLURPED</span>
            <span className="text-cyan-300 font-bold text-sm">{hudStats.slurped}</span>
          </div>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleToggleMute}
            className="px-2.5 py-1 text-xs font-medium bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border border-slate-700 rounded transition-colors whitespace-nowrap cursor-pointer"
          >
            {muted ? 'Audio: Off [M]' : 'Audio: On [M]'}
          </button>
          {gameState === 'PLAYING' && (
            <button
              type="button"
              onClick={() => setGameState('PAUSED')}
              className="px-2.5 py-1 text-xs font-medium bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border border-slate-700 rounded transition-colors whitespace-nowrap cursor-pointer"
            >
              Pause [Esc]
            </button>
          )}
        </div>
      </header>

      {/* Main Arena Stage */}
      <main className="relative flex-1 w-full flex items-center justify-center px-4 py-2 overflow-hidden">
        <div className="w-full max-w-[1360px] h-full flex items-center justify-center gap-6">
          {/* Center 1:1 32x32 Pixel Matrix Board */}
          <div className="relative flex items-center justify-center h-full aspect-square max-h-[calc(100vh-6.2rem)] max-w-[calc(100vw-2rem)]">
            {/* Coordinate Frame Bezel */}
            <div className="relative w-full h-full p-2.5 rounded-lg bg-[#0C121D] border border-rose-500/40 shadow-[0_0_50px_rgba(0,0,0,0.85)] flex items-center justify-center">
              {/* Corner Matrix Coordinate Labels */}
              <span className="absolute top-0.5 left-2 text-[10px] font-mono-tabular text-rose-400/80 pointer-events-none">
                00,00
              </span>
              <span className="absolute top-0.5 right-2 text-[10px] font-mono-tabular text-rose-400/80 pointer-events-none">
                {serverGridSize - 1},00 · UNFORGIVING BORDER
              </span>
              <span className="absolute bottom-0.5 left-2 text-[10px] font-mono-tabular text-rose-400/80 pointer-events-none">
                00,{serverGridSize - 1}
              </span>
              <span className="absolute bottom-0.5 right-2 text-[10px] font-mono-tabular text-rose-400/80 pointer-events-none">
                {serverGridSize - 1},{serverGridSize - 1}
              </span>

              <canvas
                ref={canvasRef}
                className="w-full h-full block rounded-sm bg-[#070A0F]"
              />
            </div>
          </div>

          {/* Right Perimeter Sidebar: Live Leaderboard, Kill Feed & Tactical Rules (Desktop) */}
          <aside className="hidden xl:flex flex-col justify-between w-72 h-full max-h-[calc(100vh-6.2rem)] py-1 shrink-0 pointer-events-none">
            <div className="space-y-4">
              {/* Arena Leaderboard */}
              <div className="p-4 rounded-lg bg-[#0D131F]/90 border border-slate-800/80">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xs font-semibold tracking-wider text-slate-300 font-display">
                    32×32 MATRIX LEADERS
                  </h2>
                  <span className="text-[11px] font-mono-tabular text-slate-400">
                    {hudStats.leaderboard.length} ACTIVE
                  </span>
                </div>
                <div className="space-y-2">
                  {hudStats.leaderboard.map((entry, idx) => (
                    <div
                      key={entry.id}
                      className={`flex items-center justify-between text-xs font-mono-tabular py-1 px-2 rounded ${
                        entry.isMe
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-white'
                          : 'text-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="text-slate-500 w-4">{idx + 1}.</span>
                        <span
                          className="w-2.5 h-2.5 rounded-xs shrink-0"
                          style={{ backgroundColor: entry.color }}
                        />
                        <span className="truncate font-medium">{entry.name}</span>
                        <span
                          className={`text-[9px] font-semibold shrink-0 ${
                            entry.isBot ? 'text-slate-500' : 'text-emerald-400'
                          }`}
                        >
                          {entry.isBot ? 'AI' : 'PLR'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-slate-400">{entry.length}px</span>
                        <span className="text-amber-400 font-semibold w-12 text-right">
                          {entry.score}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Live Takedown & Pellet Drop Feed */}
              <div className="p-4 rounded-lg bg-[#0D131F]/90 border border-slate-800/80">
                <h2 className="text-xs font-semibold tracking-wider text-slate-300 font-display mb-2.5">
                  TAKEDOWN & PELLET LOG
                </h2>
                {hudStats.killFeed.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Cut off nearby snakes to shatter them into flashing big pellets.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {hudStats.killFeed.map((item) => (
                      <div
                        key={item.id}
                        className="text-[11px] leading-snug text-slate-300 border-b border-slate-800/60 pb-1.5 last:border-none last:pb-0"
                      >
                        <span
                          className="inline-block w-2 h-2 mr-1.5 align-middle"
                          style={{ backgroundColor: item.color }}
                        />
                        {item.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Arena Combat Rules Card */}
            <div className="p-4 rounded-lg bg-[#0D131F]/90 border border-slate-800/80 space-y-2 text-xs text-slate-400">
              <div className="font-display font-semibold text-slate-200 tracking-wide">
                ARENA COMBAT RULES
              </div>
              <p>
                <strong className="text-amber-300">No Passive Pellets:</strong> Points only come
                from hunting nearby snakes and slurping the{' '}
                <span className="text-amber-300">flashing big pellets</span> they drop on death.
              </p>
              <p>
                <strong className="text-rose-400">Zero Wall Forgiveness:</strong> You can freely
                cross over your own tail, but hitting a rival trail or stepping off the 32×32 grid
                is instant death.
              </p>
              <p className="pt-1 text-[11px] font-mono-tabular text-slate-300">
                Controls: WASD or Arrow Keys only
              </p>
            </div>
          </aside>
        </div>

        {/* TITLE SCREEN OVERLAY */}
        {gameState === 'TITLE_MENU' && (
          <div className="absolute inset-0 z-30 bg-[#080B10]/80 flex items-center justify-center p-4">
            <div className="w-full max-w-xl rounded-xl bg-[#0D131F] border border-slate-700/80 shadow-2xl p-6 sm:p-8 space-y-6">
              {/* Bespoke Inline SVG Title Lockup */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <svg className="w-11 h-11 shrink-0" viewBox="0 0 48 48" fill="none">
                    <rect width="48" height="48" rx="8" fill="#090D16" stroke="#1E293B" strokeWidth="2" />
                    <rect x="8" y="10" width="7" height="7" fill="#047857" />
                    <rect x="16" y="10" width="7" height="7" fill="#10B981" />
                    <rect x="24" y="10" width="7" height="7" fill="#10B981" />
                    <rect x="24" y="18" width="7" height="7" fill="#34D399" />
                    <rect x="24" y="26" width="7" height="7" fill="#6EE7B7" />
                    <rect x="33" y="25" width="9" height="9" fill="#F59E0B" />
                    <rect x="35" y="27" width="5" height="5" fill="#FEF08A" />
                  </svg>
                  <div>
                    <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-white">
                      GRIDSLURP
                    </h1>
                    <p className="text-xs text-slate-400 font-mono-tabular">
                      MULTIPLAYER PIXEL SNAKE COMBAT · ZERO PASSIVE PELLETS
                    </p>
                  </div>
                </div>
              </div>

              {/* Core Mechanics Breakdown */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-[#080B10] border border-slate-800">
                  <div className="font-semibold text-emerald-400 mb-1">1. Cut Off Rivals</div>
                  <p className="text-slate-400 leading-relaxed">
                    Rivals spawn nearby on the 32×32 grid. Bait them into running into your lit pixel trail.
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-[#080B10] border border-slate-800">
                  <div className="font-semibold text-amber-400 mb-1">2. Slurp Big Pellets</div>
                  <p className="text-slate-400 leading-relaxed">
                    No passive little dots. Killed snakes drop <strong className="text-amber-200">flashing big pellets</strong>—slurp them before rivals do!
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-[#080B10] border border-slate-800">
                  <div className="font-semibold text-rose-400 mb-1">3. Unforgiving 32×32</div>
                  <p className="text-slate-400 leading-relaxed">
                    You can cross your own tail safely, but hitting rivals or stepping 1 pixel off the 32×32 border is fatal.
                  </p>
                </div>
              </div>

              {/* Player Callsign & Pixel Color Customizer */}
              <div className="space-y-4 pt-1">
                <div>
                  <label
                    htmlFor="callsign-input"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    PILOT CALLSIGN
                  </label>
                  <input
                    id="callsign-input"
                    type="text"
                    maxLength={14}
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    placeholder="VIPER_01"
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[#080B10] border border-slate-700 text-white font-mono-tabular text-sm focus:outline-none focus:border-emerald-400"
                  />
                </div>

                <div>
                  <span className="block text-xs font-medium text-slate-300 mb-2">
                    PIXEL PHOSPHOR CHANNEL
                  </span>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                    {SNAKE_PALETTES.map((pal) => {
                      const active = selectedColorId === pal.id;
                      return (
                        <button
                          key={pal.id}
                          type="button"
                          onClick={() => setSelectedColorId(pal.id)}
                          className={`flex flex-col items-center gap-1.5 p-2 rounded-lg border text-xs transition-all cursor-pointer ${
                            active
                              ? 'bg-slate-800/90 border-white text-white shadow-sm'
                              : 'bg-[#080B10] border-slate-800 text-slate-400 hover:border-slate-600'
                          }`}
                        >
                          <div className="flex items-center gap-0.5">
                            <span
                              className="w-3 h-3 rounded-xs"
                              style={{ backgroundColor: pal.tail }}
                            />
                            <span
                              className="w-3 h-3 rounded-xs"
                              style={{ backgroundColor: pal.body }}
                            />
                            <span
                              className="w-3 h-3 rounded-xs"
                              style={{ backgroundColor: pal.head }}
                            />
                          </div>
                          <span className="text-[11px] truncate w-full text-center">
                            {pal.name.split(' ')[1]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <span className="block text-xs font-medium text-slate-300 mb-2">
                    ARENA SERVER
                  </span>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setServerGridSize(32)}
                      className={`py-2.5 px-3 rounded-lg border text-xs font-mono-tabular font-semibold transition-all cursor-pointer ${
                        serverGridSize === 32
                          ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                          : 'bg-[#080B10] border-slate-800 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      32×32 SERVER (CLASSIC)
                    </button>
                    <button
                      type="button"
                      onClick={() => setServerGridSize(64)}
                      className={`py-2.5 px-3 rounded-lg border text-xs font-mono-tabular font-semibold transition-all cursor-pointer ${
                        serverGridSize === 64
                          ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                          : 'bg-[#080B10] border-slate-800 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      64×64 SERVER (EXPANDED)
                    </button>
                  </div>
                </div>
              </div>

              {/* Primary Start CTA & Single-Line Genre Control Hint */}
              <div className="space-y-3 pt-2">
                <button
                  type="button"
                  onClick={handleStartOrRespawn}
                  className="w-full py-3.5 px-6 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-base tracking-wide transition-colors cursor-pointer shadow-lg shadow-emerald-500/20"
                >
                  Drop Into {serverGridSize}×{serverGridSize} Grid [Enter]
                </button>
                <p className="text-center text-xs text-slate-400 font-mono-tabular">
                  WASD / Arrow Keys Move · M Mute · Esc Pause
                </p>
              </div>
            </div>
          </div>
        )}

        {/* PAUSE MODAL */}
        {gameState === 'PAUSED' && (
          <div className="absolute inset-0 z-30 bg-[#080B10]/80 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl bg-[#0D131F] border border-slate-700 p-6 text-center space-y-5">
              <h2 className="font-display text-2xl font-bold text-white">ARENA PAUSED</h2>
              <p className="text-xs text-slate-400">
                Use only <strong className="text-slate-200">WASD</strong> or{' '}
                <strong className="text-slate-200">Arrow Keys</strong> to steer your pixel snake on
                the 32×32 grid.
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setGameState('PLAYING')}
                  className="px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
                >
                  Resume Arena [Esc]
                </button>
                <button
                  type="button"
                  onClick={() => {
                    sendCommand({ type: 'leave' });
                    setGameState('TITLE_MENU');
                  }}
                  className="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-sm transition-colors cursor-pointer"
                >
                  Title Menu
                </button>
              </div>
            </div>
          </div>
        )}

        {/* GAME OVER / SHATTERED MODAL */}
        {gameState === 'GAME_OVER' && (
          <div className="absolute inset-0 z-30 bg-[#080B10]/80 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl bg-[#0D131F] border border-rose-500/50 shadow-2xl p-6 sm:p-7 space-y-5">
              <div className="space-y-1 text-center">
                <div className="text-xs font-mono-tabular text-rose-400 font-semibold">
                  SIGNAL TERMINATED ON 32×32 MATRIX
                </div>
                <h2 className="font-display text-3xl font-bold text-white">PIXEL TRAIL SHATTERED</h2>
                <p className="text-xs text-slate-300 pt-1">{deathExplanation}</p>
              </div>

              <div className="grid grid-cols-2 gap-3 font-mono-tabular">
                <div className="p-3 rounded-lg bg-[#080B10] border border-slate-800 text-center">
                  <div className="text-[11px] text-slate-400">FINAL SCORE</div>
                  <div className="text-xl font-bold text-amber-400">{hudStats.score}</div>
                </div>
                <div className="p-3 rounded-lg bg-[#080B10] border border-slate-800 text-center">
                  <div className="text-[11px] text-slate-400">PEAK PIXEL LENGTH</div>
                  <div className="text-xl font-bold text-emerald-400">{hudStats.length}</div>
                </div>
                <div className="p-3 rounded-lg bg-[#080B10] border border-slate-800 text-center">
                  <div className="text-[11px] text-slate-400">RIVALS ELIMINATED</div>
                  <div className="text-xl font-bold text-rose-400">{hudStats.kills}</div>
                </div>
                <div className="p-3 rounded-lg bg-[#080B10] border border-slate-800 text-center">
                  <div className="text-[11px] text-slate-400">BIG PELLETS SLURPED</div>
                  <div className="text-xl font-bold text-cyan-300">{hudStats.slurped}</div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleStartOrRespawn}
                  className="flex-1 py-3 px-5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-sm tracking-wide transition-colors cursor-pointer"
                >
                  Play Again [Enter]
                </button>
                <button
                  type="button"
                  onClick={() => setGameState('TITLE_MENU')}
                  className="py-3 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-sm transition-colors cursor-pointer"
                >
                  Change Color
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Bottom Slim Control Bar */}
      <footer className="w-full h-8 px-5 bg-[#0B0F17]/95 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 font-mono-tabular z-20 shrink-0">
        <span>CONTROLS: WASD OR ARROW KEYS ONLY (90° GRID TURNS)</span>
        <span className="hidden sm:inline text-amber-300/90">
          KILL NEARBY RIVALS → SLURP FLASHING BIG PELLETS → AVOID WALLS & TRAILS
        </span>
      </footer>
    </div>
  );
}
