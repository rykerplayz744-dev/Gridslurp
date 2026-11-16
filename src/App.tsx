import mqtt, { MqttClient } from 'mqtt';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArenaEngine } from './shared/arenaEngine';
import {
  ArenaSnapshot,
  ClientToServerMessage,
  Direction,
  GRID_SIZE,
  LifeTradeOffer,
  LOOT_BOX_REGISTRY,
  PackedArenaSnapshot,
  ServerGridSize,
  ServerToClientMessage,
  SNAKE_PALETTES,
  TICK_MS,
} from './shared/gameTypes';
import { packSnapshot, unpackSnapshot } from './shared/wireProtocol';
import {
  DISCOVERED_SNAKE_FACES,
  getFaceById,
  getFaceImage,
  loadSelectedFaceId,
  saveSelectedFaceId,
} from './utils/faceManager';
import {
  ADMIN_AUDIO_TRACKS,
  DISCOVERED_AUDIO_TRACKS,
  loadPlaylistStore,
  PlaylistStoreState,
  savePlaylistStore,
} from './utils/playlistManager';
import { soundEngine } from './utils/soundEngine';

const getMeshTopic = (size: ServerGridSize) => `gridslurp/v3/arena/global_main_${size}x${size}`;
const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
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
  const [isSpectating, setIsSpectating] = useState<boolean>(false);
  const [spectatedSnakeInfo, setSpectatedSnakeInfo] = useState<{
    id: string;
    name: string;
    color: string;
    isBot: boolean;
    score: number;
    length: number;
  } | null>(null);
  const [serverGridSize, setServerGridSize] = useState<ServerGridSize>(32);
  const [zoomIn16, setZoomIn16] = useState<boolean>(false);
  const [mobileControlsEnabled, setMobileControlsEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('gridslurp_mobile_controls') === 'true';
    } catch {
      return false;
    }
  });
  const [playerName, setPlayerName] = useState<string>('VIPER_01');
  const [selectedColorId, setSelectedColorId] = useState<string>('emerald');
  const [selectedFaceId, setSelectedFaceId] = useState<string>(() => loadSelectedFaceId());
  const [muted, setMuted] = useState<boolean>(soundEngine.muted);
  const [, setConnectionMode] = useState<'ws' | 'local-sync'>('ws');
  const [showAdminModal, setShowAdminModal] = useState<boolean>(false);
  const [adminAutoPilot, setAdminAutoPilot] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('gridslurp_admin_autopilot');
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [keepAutoPilotOnClose, setKeepAutoPilotOnClose] = useState<boolean>(() => {
    try {
      return localStorage.getItem('gridslurp_admin_autopilot_keep_on_close') === 'true';
    } catch {
      return false;
    }
  });
  const [autoPilotActive, setAutoPilotActive] = useState<boolean>(false);
  const [playlistStore, setPlaylistStore] = useState<PlaylistStoreState>(() => loadPlaylistStore());
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>(
    () => loadPlaylistStore().activePlaylistId
  );
  const [newPlaylistName, setNewPlaylistName] = useState<string>('');
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [isMusicPlaying, setIsMusicPlaying] = useState<boolean>(false);
  const [isAdminMusicActive, setIsAdminMusicActive] = useState<boolean>(false);

  const [adminKickedThisSession, setAdminKickedThisSession] = useState<boolean>(false);
  const [kickFeedbackMsg, setKickFeedbackMsg] = useState<string | null>(null);
  const [pelletFloodFeedback, setPelletFloodFeedback] = useState<string | null>(null);
  const [debugLivesFeedback, setDebugLivesFeedback] = useState<string | null>(null);
  const [showTradeModal, setShowTradeModal] = useState<boolean>(false);
  const [incomingTrades, setIncomingTrades] = useState<LifeTradeOffer[]>([]);
  const [tradeFeedback, setTradeFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [tradeTargetId, setTradeTargetId] = useState<string>('');
  const [tradeGiveType, setTradeGiveType] = useState<'LIFE' | 'SCORE'>('LIFE');
  const [tradeGiveScore, setTradeGiveScore] = useState<number>(500);
  const [tradeWantType, setTradeWantType] = useState<'LIFE' | 'SCORE'>('SCORE');
  const [tradeWantScore, setTradeWantScore] = useState<number>(500);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isAdminMusicActiveRef = useRef<boolean>(false);
  const playNextAdminTrackRef = useRef<(forceTrackId?: string) => void>(() => {});
  const handleIncomingAdminKickRef = useRef<(targetPlayerId: string, issuedByClientId: string) => void>(
    () => {}
  );
  const autoPilotActiveRef = useRef<boolean>(false);
  const keepAutoPilotOnCloseRef = useRef<boolean>(keepAutoPilotOnClose);
  const normalizedPlayerName = playerName.trim().toUpperCase();
  const isSuperAdminRy = !adminKickedThisSession && normalizedPlayerName.startsWith('ADMINRY');
  const isAdminName = !adminKickedThisSession && normalizedPlayerName.startsWith('ADMIN');
  const isAdminNameRef = useRef<boolean>(isAdminName);
  const isSuperAdminRyRef = useRef<boolean>(isSuperAdminRy);
  const playerNameRef = useRef<string>(playerName);
  const selectedColorIdRef = useRef<string>(selectedColorId);
  const selectedFaceIdRef = useRef<string>(selectedFaceId);
  const lastAutoRespawnAtRef = useRef<number>(0);
  const triggerAutoPilotRespawnRef = useRef<() => void>(() => {});

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
    extraLives: number;
    deathReason?: string;
    killedByName?: string;
    bigPelletsOnGrid: number;
    onlineCount: number;
    humanPlayers: Array<{
      id: string;
      name: string;
      color: string;
      alive: boolean;
      autoPilot: boolean;
      extraLives: number;
      score: number;
    }>;
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
    extraLives: 0,
    bigPelletsOnGrid: 0,
    onlineCount: 1,
    humanPlayers: [],
    leaderboard: [],
    killFeed: [],
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mqttRef = useRef<MqttClient | null>(null);
  const localEngineRef = useRef<ArenaEngine | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  const playerIdRef = useRef<string>(`plr_${Math.random().toString(36).slice(2, 9)}`);
  const activePeersRef = useRef<
    Map<
      string,
      {
        lastSeen: number;
        playing: boolean;
        name: string;
        colorId: string;
        hidden: boolean;
      }
    >
  >(new Map());
  const meshCoordRef = useRef<{
    isCoordinator: boolean;
    activeCoordId: string | null;
    activeCoordHidden: boolean;
    coordEpoch: number;
    lastAcceptedEpoch: number;
    lastAcceptedTick: number;
    lastCoordMsgAt: number;
    needsHydrateBeforeStep: boolean;
    readyToLeadAt: number;
  }>({
    isCoordinator: false,
    activeCoordId: null,
    activeCoordHidden: false,
    coordEpoch: 0,
    lastAcceptedEpoch: 0,
    lastAcceptedTick: -1,
    lastCoordMsgAt: 0,
    needsHydrateBeforeStep: false,
    readyToLeadAt: 0,
  });
  const lastAutoJoinSentAtRef = useRef<number>(0);
  const myJoinInfoRef = useRef<{ name: string; colorId: string; faceId?: string; playing: boolean }>({
    name: 'VIPER_01',
    colorId: 'emerald',
    faceId: undefined,
    playing: false,
  });

  const snapshotRef = useRef<ArenaSnapshot | null>(null);
  const lastSnapshotTimeRef = useRef<number>(performance.now());
  const processedKillsRef = useRef<Set<string>>(new Set());
  const processedSlurpsRef = useRef<Set<string>>(new Set());
  const processedTelegraphsRef = useRef<Set<string>>(new Set());
  const processedLootPickupsRef = useRef<Set<string>>(new Set());
  const processedExtraLifeSavesRef = useRef<Set<string>>(new Set());

  // Visual juice pools
  const particlesRef = useRef<Particle[]>([]);
  const popupsRef = useRef<FloatingPopup[]>([]);
  const shockwavesRef = useRef<Shockwave[]>([]);
  const shakeRef = useRef<number>(0);
  const hitstopUntilRef = useRef<number>(0);
  const gameStateRef = useRef<GameState>(gameState);
  const isSpectatingRef = useRef<boolean>(isSpectating);
  const spectatedSnakeIdRef = useRef<string | null>(null);
  const zoomIn16Ref = useRef<boolean>(zoomIn16);
  const camRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const predictedTurnsRef = useRef<Array<{ dir: Direction; seq: number; sentAt: number }>>([]);
  const turnSeqRef = useRef<number>(0);
  const lastHudReactSyncRef = useRef<number>(0);
  const lastHudSigRef = useRef<string>('');

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    isSpectatingRef.current = isSpectating;
  }, [isSpectating]);

  useEffect(() => {
    zoomIn16Ref.current = zoomIn16;
  }, [zoomIn16]);

  const pickRandomSpectatedSnake = useCallback(
    (snap?: ArenaSnapshot | null, excludeId?: string | null) => {
      const targetSnap = snap ?? snapshotRef.current;
      const aliveSnakes = targetSnap?.snakes.filter((s) => s.alive) ?? [];
      if (aliveSnakes.length === 0) {
        spectatedSnakeIdRef.current = null;
        setSpectatedSnakeInfo(null);
        return null;
      }
      const candidates =
        aliveSnakes.length > 1 && excludeId
          ? aliveSnakes.filter((s) => s.id !== excludeId)
          : aliveSnakes;
      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      spectatedSnakeIdRef.current = chosen.id;
      setSpectatedSnakeInfo({
        id: chosen.id,
        name: chosen.name,
        color: chosen.color.head,
        isBot: chosen.isBot,
        score: chosen.score,
        length: chosen.segments.length,
      });
      return chosen;
    },
    []
  );

  const spawnBurst = useCallback((gridX: number, gridY: number, color: string, count = 18) => {
    if (particlesRef.current.length >= 260) return;
    const allowed = Math.min(count, 260 - particlesRef.current.length);
    for (let i = 0; i < allowed; i++) {
      const angle = (Math.PI * 2 * i) / Math.max(1, count) + (Math.random() - 0.5) * 0.4;
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

      // New pellet slurps (coalesce audio to once per tick when flooding screen with pellets)
      let playedSlurpThisBatch = false;
      for (const slurp of snap.recentSlurps) {
        if (!processedSlurpsRef.current.has(slurp.id)) {
          processedSlurpsRef.current.add(slurp.id);
          spawnBurst(slurp.toX, slurp.toY, slurp.color || '#F59E0B', 6);

          if (slurp.snakeId === myId && gameStateRef.current === 'PLAYING') {
            if (!playedSlurpThisBatch) {
              soundEngine.playPelletSlurp();
              playedSlurpThisBatch = true;
            }
            if (popupsRef.current.length < 40) {
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
      }

      // New Loot Box pickups
      for (const pickup of snap.recentLootPickups || []) {
        if (!processedLootPickupsRef.current.has(pickup.id)) {
          processedLootPickupsRef.current.add(pickup.id);
          const def = LOOT_BOX_REGISTRY[pickup.ability];
          spawnBurst(pickup.x, pickup.y, def.badgeColor, 20);
          shockwavesRef.current.push({
            x: pickup.x + 0.5,
            y: pickup.y + 0.5,
            radius: 0.35,
            maxRadius: 3.4,
            color: def.badgeColor,
            alpha: 0.9,
          });
          if (pickup.snakeId === myId && gameStateRef.current === 'PLAYING') {
            soundEngine.playLootBoxPickup();
            popupsRef.current.push({
              x: pickup.x + 0.5,
              y: pickup.y - 0.15,
              text: def.shortLabel,
              color: def.accentColor,
              alpha: 1,
              vy: -0.055,
            });
          }
        }
      }

      // Extra Life phase-through saves
      for (const saved of snap.recentExtraLifeSaves || []) {
        if (!processedExtraLifeSavesRef.current.has(saved.id)) {
          processedExtraLifeSavesRef.current.add(saved.id);
          spawnBurst(saved.x, saved.y, '#38BDF8', 24);
          shockwavesRef.current.push({
            x: saved.x + 0.5,
            y: saved.y + 0.5,
            radius: 0.4,
            maxRadius: 4.0,
            color: '#38BDF8',
            alpha: 0.95,
          });
          if (saved.snakeId === myId && gameStateRef.current === 'PLAYING') {
            soundEngine.playExtraLifeSave();
            shakeRef.current = 8;
            popupsRef.current.push({
              x: saved.x + 0.5,
              y: saved.y - 0.25,
              text: 'EXTRA LIFE · INVINCIBLE!',
              color: '#7DD3FC',
              alpha: 1,
              vy: -0.06,
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

          // Prevent unbounded growth of deduplication Sets over long flood sessions
          if (processedSlurpsRef.current.size > 600) processedSlurpsRef.current.clear();
          if (processedTelegraphsRef.current.size > 300) processedTelegraphsRef.current.clear();
          if (processedLootPickupsRef.current.size > 300) processedLootPickupsRef.current.clear();
          if (processedExtraLifeSavesRef.current.size > 300) processedExtraLifeSavesRef.current.clear();
          if (processedKillsRef.current.size > 300) processedKillsRef.current.clear();

          // If watching a snake in spectator mode and it is killed:
          // zoom into the killer snake if killed by another snake, otherwise focus on a random other snake
          if (kill.victimId === spectatedSnakeIdRef.current) {
            const killerSnake = kill.killerId
              ? snap.snakes.find((s) => s.id === kill.killerId && s.alive)
              : undefined;
            if (killerSnake) {
              spectatedSnakeIdRef.current = killerSnake.id;
              setSpectatedSnakeInfo({
                id: killerSnake.id,
                name: killerSnake.name,
                color: killerSnake.color.head,
                isBot: killerSnake.isBot,
                score: killerSnake.score,
                length: killerSnake.segments.length,
              });
            } else {
              pickRandomSpectatedSnake(snap, kill.victimId);
            }
          }

          if (kill.victimId === myId && gameStateRef.current === 'PLAYING') {
            soundEngine.playPlayerDeath();
            shakeRef.current = 14;
            hitstopUntilRef.current = performance.now() + 65;
            if (autoPilotActiveRef.current && isAdminNameRef.current) {
              triggerAutoPilotRespawnRef.current();
            } else {
              gameStateRef.current = 'GAME_OVER';
              myJoinInfoRef.current.playing = false;
              setGameState('GAME_OVER');
            }
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
          } else if (gameStateRef.current === 'PLAYING' || isSpectatingRef.current) {
            soundEngine.playRivalKill(false);
            shakeRef.current = 4;
          }
        }
      }

      // Keep spectator focus valid: if the watched snake left the game or died, focus on killer or a random other snake
      if (gameStateRef.current !== 'PLAYING') {
        let watched = spectatedSnakeIdRef.current
          ? snap.snakes.find((s) => s.id === spectatedSnakeIdRef.current && s.alive)
          : undefined;
        if (!watched) {
          const recentKill = spectatedSnakeIdRef.current
            ? [...snap.recentKills]
                .reverse()
                .find((k) => k.victimId === spectatedSnakeIdRef.current && k.killerId)
            : undefined;
          const killerSnake = recentKill?.killerId
            ? snap.snakes.find((s) => s.id === recentKill.killerId && s.alive)
            : undefined;
          if (killerSnake) {
            spectatedSnakeIdRef.current = killerSnake.id;
            watched = killerSnake;
          } else {
            watched = pickRandomSpectatedSnake(snap, spectatedSnakeIdRef.current) ?? undefined;
          }
        }
        if (watched) {
          setSpectatedSnakeInfo({
            id: watched.id,
            name: watched.name,
            color: watched.color.head,
            isBot: watched.isBot,
            score: watched.score,
            length: watched.segments.length,
          });
        } else {
          setSpectatedSnakeInfo(null);
        }
      }

      // Update HUD state
      const aliveSnakes = snap.snakes.filter((s) => s.alive);
      const sorted = [...aliveSnakes].sort((a, b) => b.score - a.score);

      const feed = snap.recentKills
        .slice(-4)
        .reverse()
        .map((k) => {
          let desc = `${k.victimName} hit the outer wall (${k.pelletsDropped} big pellets!)`;
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
      const nowMs = performance.now();

      // Ensure AI autopilot auto-respawns seamlessly even if the kill event scrolled past
      if (
        me &&
        !me.alive &&
        gameStateRef.current === 'PLAYING' &&
        autoPilotActiveRef.current &&
        isAdminNameRef.current
      ) {
        triggerAutoPilotRespawnRef.current();
      }

      // Reconcile in-flight client turn queue using authoritative server sequence acknowledgments
      if (!me || !me.alive || me.autoPilot) {
        predictedTurnsRef.current = [];
      } else if (predictedTurnsRef.current.length > 0) {
        while (predictedTurnsRef.current.length > 0) {
          const front = predictedTurnsRef.current[0];
          const ackedBySeq =
            typeof me.lastTurnSeq === 'number' && front.seq <= me.lastTurnSeq;
          const staleTurn = nowMs - front.sentAt > 1500;
          if (ackedBySeq || staleTurn) {
            predictedTurnsRef.current.shift();
          } else {
            break;
          }
        }
      }

      const humanMap = new Map<
        string,
        {
          id: string;
          name: string;
          color: string;
          alive: boolean;
          autoPilot: boolean;
          extraLives: number;
          score: number;
        }
      >();
      for (const s of snap.snakes) {
        if (s.isBot || s.id === myId) continue;
        humanMap.set(s.id, {
          id: s.id,
          name: s.name,
          color: s.color.head,
          alive: s.alive,
          autoPilot: Boolean(s.autoPilot),
          extraLives: s.extraLives || 0,
          score: s.score,
        });
      }
      for (const [pid, info] of activePeersRef.current.entries()) {
        if (pid === myId || nowMs - info.lastSeen > 6500 || humanMap.has(pid)) continue;
        humanMap.set(pid, {
          id: pid,
          name: info.name,
          color: '#94A3B8',
          alive: false,
          autoPilot: false,
          extraLives: 0,
          score: 0,
        });
      }
      const humanPlayers = Array.from(humanMap.values()).sort((a, b) => {
        const aAdmin = a.name.trim().toUpperCase().startsWith('ADMIN') ? 0 : 1;
        const bAdmin = b.name.trim().toUpperCase().startsWith('ADMIN') ? 0 : 1;
        if (aAdmin !== bAdmin) return aAdmin - bAdmin;
        return a.name.localeCompare(b.name);
      });

      const livesSig = humanPlayers.map((p) => `${p.id}:${p.extraLives}`).join(',');
      const criticalHudSig = `${me?.alive ?? false}|${me?.kills ?? 0}|${me?.extraLives ?? 0}|${(snap.lootBoxes || []).length}|${snap.onlinePlayers}|${humanPlayers.length}|${livesSig}|${feed[0]?.id ?? ''}|${(me?.shieldTicks ?? 0) > 0}`;
      if (criticalHudSig !== lastHudSigRef.current || nowMs - lastHudReactSyncRef.current >= 220) {
        lastHudSigRef.current = criticalHudSig;
        lastHudReactSyncRef.current = nowMs;
        setHudStats((prev) => ({
          score: me ? me.score : prev.score,
          length: me ? me.segments.length : prev.length,
          kills: me ? me.kills : prev.kills,
          slurped: me ? me.pelletsSlurped : prev.slurped,
          headX: me && me.segments[0] ? Math.max(0, Math.min(activeSize - 1, me.segments[0].x)) : prev.headX,
          headY: me && me.segments[0] ? Math.max(0, Math.min(activeSize - 1, me.segments[0].y)) : prev.headY,
          alive: me ? me.alive : false,
          shieldTicks: me ? me.shieldTicks : 0,
          extraLives: me ? me.extraLives || 0 : 0,
          deathReason: me?.deathReason || prev.deathReason,
          killedByName: me?.killedByName || prev.killedByName,
          bigPelletsOnGrid: snap.pellets.length,
          onlineCount: Math.max(
            snap.onlinePlayers,
            1 +
              Array.from(activePeersRef.current.values()).filter(
                (p) => nowMs - p.lastSeen < 6500
              ).length
          ),
          humanPlayers,
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
      }
    },
    [pickRandomSpectatedSnake, spawnBurst]
  );

  // Setup Live Multiplayer: Direct /ws Server + Global Cross-Device WSS Mesh (for Vercel) + BroadcastChannel
  useEffect(() => {
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let tickTimeout: ReturnType<typeof setTimeout> | null = null;
    let tickWorker: Worker | null = null;
    let tickWorkerUrl: string | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let isUnmounted = false;
    const meshTopic = getMeshTopic(serverGridSize);
    activePeersRef.current.clear();
    localEngineRef.current = null;

    // Reset coordinator state cleanly for this room
    meshCoordRef.current = {
      isCoordinator: false,
      activeCoordId: null,
      activeCoordHidden: false,
      coordEpoch: 0,
      lastAcceptedEpoch: 0,
      lastAcceptedTick: -1,
      lastCoordMsgAt: 0,
      needsHydrateBeforeStep: false,
      readyToLeadAt: performance.now() + 900,
    };

    const isSelfHidden = (): boolean =>
      typeof document !== 'undefined' ? Boolean(document.hidden) : false;

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

    const canBecomeCoordinator = (now: number): boolean => {
      const mc = meshCoordRef.current;
      if (mc.isCoordinator) return true;

      // Wait for initial discovery window so we never collide with an active room host
      if (now < mc.readyToLeadAt) return false;

      const amHidden = isSelfHidden();
      const coordSilentMs = now - mc.lastCoordMsgAt;
      // Treat any coordinator that is backgrounded while we are foregrounded (or silent > 420ms, i.e. 1Hz-throttled) as degraded
      const coordHealthy =
        Boolean(mc.activeCoordId) &&
        coordSilentMs <= Math.max(420, TICK_MS * 3) &&
        (!mc.activeCoordHidden || amHidden);

      if (coordHealthy) {
        return false;
      }

      // Deterministic tie-break: visible foreground peers strictly outrank hidden background peers,
      // then smallest alive peer ID steps up
      const myId = playerIdRef.current;
      let anyVisiblePeer = false;
      for (const [pid, info] of activePeersRef.current.entries()) {
        if (pid === myId) continue;
        if (now - info.lastSeen > 5000) continue;
        if (!info.hidden) {
          anyVisiblePeer = true;
          if (amHidden) return false;
          if (pid < myId) return false;
        } else if (amHidden && !anyVisiblePeer && pid < myId) {
          return false;
        }
      }
      // If we are hidden and still see a non-expired coordinator within 4.5s, don't fight it
      if (amHidden && mc.activeCoordId && coordSilentMs < 4500) {
        return false;
      }
      return true;
    };

    const applyAuthoritativeSnapshot = (remoteSnap: ArenaSnapshot, now: number) => {
      snapshotRef.current = remoteSnap;
      lastSnapshotTimeRef.current = now;
      processSnapshotEvents(remoteSnap);

      const myId = playerIdRef.current;
      const mySnake = remoteSnap.snakes.find((s) => s.id === myId);

      // Sync GAME_OVER synchronously if coordinator reports our snake dead (unless AI autopilot auto-respawns)
      if (mySnake && !mySnake.alive && gameStateRef.current === 'PLAYING') {
        if (autoPilotActiveRef.current && isAdminNameRef.current) {
          triggerAutoPilotRespawnRef.current();
        } else {
          gameStateRef.current = 'GAME_OVER';
          myJoinInfoRef.current.playing = false;
          setGameState('GAME_OVER');
        }
        return;
      }

      // If we just joined and aren't on the coordinator's board yet, resend join cleanly once per 850ms
      if (
        myJoinInfoRef.current.playing &&
        gameStateRef.current === 'PLAYING' &&
        !mySnake &&
        now - lastAutoJoinSentAtRef.current > 850
      ) {
        lastAutoJoinSentAtRef.current = now;
        publishMeshPacket({
          type: 'mesh_cmd',
          senderId: myId,
          cmd: {
            type: 'join',
            clientId: myId,
            name: myJoinInfoRef.current.name,
            colorId: myJoinInfoRef.current.colorId,
            faceId: myJoinInfoRef.current.faceId,
            gridSize: serverGridSize,
          },
        });
      }
    };

    const handleMeshPacket = (data: Record<string, unknown>) => {
      if (!data || typeof data.type !== 'string') return;
      const senderId = String(data.senderId || '');
      const myId = playerIdRef.current;
      if (!senderId || senderId === myId) return;

      const now = performance.now();
      const existingPeer = activePeersRef.current.get(senderId);
      const remoteHidden =
        typeof data.hidden === 'boolean' ? data.hidden : existingPeer?.hidden ?? false;
      activePeersRef.current.set(senderId, {
        lastSeen: now,
        playing: typeof data.playing === 'boolean' ? data.playing : existingPeer?.playing ?? false,
        name: typeof data.name === 'string' ? data.name : existingPeer?.name ?? 'PLAYER',
        colorId: typeof data.colorId === 'string' ? data.colorId : existingPeer?.colorId ?? 'cyan',
        hidden: remoteHidden,
      });

      const mc = meshCoordRef.current;

      if (data.type === 'mesh_state' && data.state && localEngineRef.current) {
        const remoteEpoch = Number(data.epoch) || 1;
        const remoteSnap = unpackSnapshot(data.state as ArenaSnapshot | PackedArenaSnapshot);

        // If we thought we were coordinator, yield cleanly to visible peers when hidden, higher epoch, higher tick, or lower ID
        if (mc.isCoordinator) {
          const ourTick = localEngineRef.current.tick;
          const amHidden = isSelfHidden();
          const remoteWins =
            (amHidden && !remoteHidden && remoteEpoch >= mc.coordEpoch) ||
            remoteEpoch > mc.coordEpoch ||
            (remoteEpoch === mc.coordEpoch && remoteSnap.tick > ourTick + 1) ||
            (remoteEpoch === mc.coordEpoch &&
              Math.abs(remoteSnap.tick - ourTick) <= 1 &&
              (amHidden === remoteHidden ? senderId < myId : !remoteHidden));
          if (!remoteWins) {
            return;
          }
          mc.isCoordinator = false;
        }

        // Strict monotonic epoch + tick guard: never accept stale or out-of-order states
        if (
          remoteEpoch < mc.lastAcceptedEpoch ||
          (remoteEpoch === mc.lastAcceptedEpoch && remoteSnap.tick <= mc.lastAcceptedTick)
        ) {
          return;
        }

        // Ignore rogue weaker sender while active coordinator is healthy & visible
        if (
          mc.activeCoordId &&
          senderId !== mc.activeCoordId &&
          remoteEpoch === mc.lastAcceptedEpoch &&
          now - mc.lastCoordMsgAt < Math.max(420, TICK_MS * 3) &&
          !mc.activeCoordHidden
        ) {
          return;
        }

        mc.activeCoordId = senderId;
        mc.activeCoordHidden = remoteHidden;
        mc.coordEpoch = remoteEpoch;
        mc.lastAcceptedEpoch = remoteEpoch;
        mc.lastAcceptedTick = remoteSnap.tick;
        mc.lastCoordMsgAt = now;
        mc.needsHydrateBeforeStep = true;

        applyAuthoritativeSnapshot(remoteSnap, now);
      } else if (data.type === 'mesh_handoff' && data.state && localEngineRef.current) {
        const remoteEpoch = Number(data.epoch) || 1;
        const remoteSnap = unpackSnapshot(data.state as ArenaSnapshot | PackedArenaSnapshot);
        if (
          remoteEpoch > mc.lastAcceptedEpoch ||
          (remoteEpoch === mc.lastAcceptedEpoch && remoteSnap.tick > mc.lastAcceptedTick)
        ) {
          mc.lastAcceptedEpoch = remoteEpoch;
          mc.lastAcceptedTick = remoteSnap.tick;
          snapshotRef.current = remoteSnap;
          lastSnapshotTimeRef.current = now;
          mc.needsHydrateBeforeStep = true;
        }
        if (data.nextCoordId === myId) {
          if (snapshotRef.current) {
            localEngineRef.current.hydrateFromSnapshot(snapshotRef.current);
            mc.needsHydrateBeforeStep = false;
          }
          mc.isCoordinator = true;
          mc.activeCoordId = myId;
          mc.activeCoordHidden = isSelfHidden();
          mc.coordEpoch = Math.max(mc.coordEpoch, mc.lastAcceptedEpoch) + 1;
          mc.lastCoordMsgAt = now;
        } else {
          mc.activeCoordId = typeof data.nextCoordId === 'string' ? data.nextCoordId : null;
          mc.activeCoordHidden = false;
          mc.lastCoordMsgAt = now;
        }
      } else if (data.type === 'mesh_cmd' && data.cmd && localEngineRef.current) {
        const cmd = data.cmd as ClientToServerMessage & { clientId?: string };
        if (cmd.type === 'admin_track') {
          isAdminMusicActiveRef.current = true;
          setIsAdminMusicActive(true);
          playNextAdminTrackRef.current(cmd.trackId);
          return;
        }
        if (cmd.type === 'kick_admin') {
          if (mc.isCoordinator) {
            if (cmd.targetPlayerId === '*') {
              for (const s of localEngineRef.current.snakes.values()) {
                if (!s.isBot && s.id !== cmd.issuedByClientId) {
                  localEngineRef.current.setAutopilot(s.id, false);
                }
              }
            } else if (cmd.targetPlayerId && cmd.targetPlayerId !== cmd.issuedByClientId) {
              localEngineRef.current.setAutopilot(cmd.targetPlayerId, false);
            }
          }
          handleIncomingAdminKickRef.current(cmd.targetPlayerId, cmd.issuedByClientId);
          return;
        }

        // Only the authoritative coordinator mutates the simulation on incoming commands
        if (!mc.isCoordinator) return;

        const targetId = cmd.clientId || senderId;
        const engine = localEngineRef.current;

        if (cmd.type === 'join') {
          const existing = engine.snakes.get(targetId);
          if (!existing || !existing.alive) {
            engine.spawnPlayer(
              targetId,
              cmd.name,
              cmd.colorId,
              Boolean(cmd.autoPilot),
              cmd.autoPilotTier,
              cmd.faceId
            );
          }
        } else if (cmd.type === 'respawn') {
          engine.spawnPlayer(
            targetId,
            cmd.name,
            cmd.colorId,
            Boolean(cmd.autoPilot),
            cmd.autoPilotTier,
            cmd.faceId
          );
        } else if (cmd.type === 'set_face') {
          engine.setPlayerFace(targetId, cmd.faceId);
        } else if (cmd.type === 'turn') {
          engine.queueTurn(targetId, cmd.dir, cmd.seq);
        } else if (cmd.type === 'autopilot') {
          engine.setAutopilot(targetId, Boolean(cmd.enabled), cmd.tier);
        } else if (cmd.type === 'adminry_pellet_flood') {
          const senderSnake = engine.snakes.get(targetId);
          const candidateName = (senderSnake?.name || cmd.issuedByName || '').trim().toUpperCase();
          if (candidateName.startsWith('ADMINRY')) {
            const action = cmd.action === 'CLEAR' ? 'CLEAR' : 'FLOOD_SCREEN';
            const count =
              action === 'CLEAR' ? engine.clearAllPellets() : engine.floodScreenWithPellets();
            const msgText =
              action === 'CLEAR'
                ? `ADMINRY cleared ${count} pellets from the grid.`
                : `ADMINRY flooded the screen with ${count.toLocaleString()} flashing pellets!`;
            if (action === 'FLOOD_SCREEN') {
              soundEngine.playLootBoxPickup();
            }
            setPelletFloodFeedback(msgText);
            publishMeshPacket({
              type: 'mesh_pellet_flood',
              senderId: myId,
              action,
              count,
              byName: candidateName,
            });
          }
        } else if (cmd.type === 'adminry_give_lives') {
          const senderSnake = engine.snakes.get(targetId);
          const candidateName = (senderSnake?.name || cmd.issuedByName || '').trim().toUpperCase();
          if (candidateName.startsWith('ADMINRY')) {
            const resolvedTarget = cmd.targetPlayerId === 'ME' ? targetId : cmd.targetPlayerId;
            const amount = Math.max(-999, Math.min(99, Math.trunc(Number(cmd.amount) || 0)));
            const res = engine.adminGiveExtraLives(resolvedTarget, amount);
            if (res.ok) {
              const summary =
                amount < 0
                  ? `${candidateName} cleared Extra Lives for ${res.targetName || 'player'}.`
                  : resolvedTarget === '*'
                    ? `${candidateName} gave +${amount} Extra ${amount === 1 ? 'Life' : 'Lives'} to all alive players!`
                    : `${candidateName} gave +${amount} Extra ${amount === 1 ? 'Life' : 'Lives'} to ${res.targetName || 'player'} (now ×${res.newLives ?? 0}).`;
              publishMeshPacket({
                type: 'mesh_trade_result',
                senderId: myId,
                offerId: `dbg_${Date.now()}`,
                fromId: targetId,
                toId: resolvedTarget === '*' ? myId : resolvedTarget,
                ok: true,
                accepted: amount > 0,
                summary,
              });
              if (resolvedTarget === myId || resolvedTarget === '*') {
                if (amount > 0) soundEngine.playLootBoxPickup();
                setDebugLivesFeedback(summary);
              }
            }
          }
        } else if (cmd.type === 'give_life') {
          const res = engine.giveExtraLife(targetId, cmd.targetPlayerId);
          const fromSnake = engine.snakes.get(targetId);
          const toSnake = engine.snakes.get(cmd.targetPlayerId);
          const summary = res.ok
            ? `${fromSnake?.name || 'Player'} gave 1 Extra Life to ${toSnake?.name || 'Player'}!`
            : res.reason || 'Transfer failed.';
          publishMeshPacket({
            type: 'mesh_trade_result',
            senderId: myId,
            offerId: `give_${Date.now()}`,
            fromId: targetId,
            toId: cmd.targetPlayerId,
            ok: res.ok,
            accepted: true,
            summary,
          });
          if (cmd.targetPlayerId === myId && res.ok) {
            soundEngine.playLootBoxPickup();
            setTradeFeedback({ text: summary, ok: true });
          }
        } else if (cmd.type === 'trade_offer') {
          if (cmd.offer && cmd.offer.toId === myId) {
            setIncomingTrades((prev) =>
              prev.some((o) => o.id === cmd.offer.id) ? prev : [...prev.slice(-3), cmd.offer]
            );
          }
        } else if (cmd.type === 'trade_response') {
          const offer = cmd.offer;
          let ok = true;
          let summary = `${offer.toName} declined the life trade.`;
          if (cmd.accepted) {
            const res = engine.executeLifeTrade(offer);
            ok = res.ok;
            const giveLabel =
              offer.giveType === 'LIFE' ? `${offer.giveAmount} Life` : `${offer.giveAmount} PTS`;
            const wantLabel =
              offer.wantType === 'LIFE' ? `${offer.wantAmount} Life` : `${offer.wantAmount} PTS`;
            summary = res.ok
              ? `Trade complete: ${offer.fromName} (${giveLabel}) ⇄ ${offer.toName} (${wantLabel})`
              : res.reason || 'Trade failed.';
          }
          publishMeshPacket({
            type: 'mesh_trade_result',
            senderId: myId,
            offerId: cmd.offerId,
            fromId: offer.fromId,
            toId: offer.toId,
            ok,
            accepted: cmd.accepted,
            summary,
          });
          if (offer.fromId === myId || offer.toId === myId) {
            if (ok && cmd.accepted) soundEngine.playLootBoxPickup();
            setTradeFeedback({ text: summary, ok });
          }
        } else if (cmd.type === 'leave') {
          engine.removePlayer(targetId);
        }
      } else if (data.type === 'mesh_cmd' && data.cmd) {
        const cmd = data.cmd as ClientToServerMessage & { clientId?: string };
        if (cmd.type === 'trade_offer' && cmd.offer && cmd.offer.toId === myId) {
          setIncomingTrades((prev) =>
            prev.some((o) => o.id === cmd.offer.id) ? prev : [...prev.slice(-3), cmd.offer]
          );
        }
      } else if (data.type === 'mesh_trade_result') {
        const fromId = String(data.fromId || '');
        const toId = String(data.toId || '');
        if (fromId === myId || toId === myId) {
          const ok = Boolean(data.ok);
          const accepted = Boolean(data.accepted);
          if (ok && accepted) soundEngine.playLootBoxPickup();
          setTradeFeedback({ text: String(data.summary || ''), ok });
          setIncomingTrades((prev) => prev.filter((o) => o.id !== data.offerId));
        }
      } else if (data.type === 'mesh_pellet_flood') {
        const count = Number(data.count) || 0;
        if (data.action === 'FLOOD_SCREEN') {
          soundEngine.playLootBoxPickup();
          setPelletFloodFeedback(
            `${String(data.byName || 'ADMINRY')} flooded the screen with ${count.toLocaleString()} flashing pellets!`
          );
        } else {
          setPelletFloodFeedback(
            `${String(data.byName || 'ADMINRY')} cleared ${count.toLocaleString()} pellets.`
          );
        }
      }
    };

    const sendCoordinatorHandoff = () => {
      const mc = meshCoordRef.current;
      if (!mc.isCoordinator || !localEngineRef.current) return;
      const now = performance.now();
      let nextCoordId: string | null = null;
      let nextCoordIsVisible = false;
      for (const [pid, info] of activePeersRef.current.entries()) {
        if (pid === playerIdRef.current) continue;
        if (now - info.lastSeen > 5000) continue;
        const peerVisible = !info.hidden;
        if (
          !nextCoordId ||
          (peerVisible && !nextCoordIsVisible) ||
          (peerVisible === nextCoordIsVisible && pid < nextCoordId)
        ) {
          nextCoordId = pid;
          nextCoordIsVisible = peerVisible;
        }
      }
      if (nextCoordId) {
        publishMeshPacket({
          type: 'mesh_handoff',
          senderId: playerIdRef.current,
          nextCoordId,
          epoch: mc.coordEpoch,
          state: packSnapshot(snapshotRef.current || localEngineRef.current.getSnapshot()),
        });
        mc.activeCoordId = nextCoordId;
        mc.activeCoordHidden = !nextCoordIsVisible;
      }
      mc.isCoordinator = false;
    };

    const startGlobalMeshEngine = () => {
      if (isUnmounted || localEngineRef.current) return;
      setConnectionMode('ws');
      const targetBots = serverGridSize === 64 ? 4 : 2;
      const engine = new ArenaEngine(targetBots, serverGridSize);
      localEngineRef.current = engine;

      // 1. Local multi-tab BroadcastChannel
      try {
        const bc = new BroadcastChannel(`gridslurp_${serverGridSize}x${serverGridSize}_arena_v3`);
        broadcastChannelRef.current = bc;
        bc.onmessage = (ev) => {
          handleMeshPacket(ev.data);
        };
      } catch {
        // BroadcastChannel optional
      }

      // 2. Global Cross-Device WSS Relay (MQTT over WebSockets - works on Vercel & worldwide browsers)
      const connectMqttBroker = (brokerIndex: number) => {
        if (isUnmounted) return;
        const brokerUrl = MQTT_BROKERS[brokerIndex] || MQTT_BROKERS[0];
        let connectedOnce = false;
        let brokerFallbackTimer: ReturnType<typeof setTimeout> | null = null;

        try {
          const client = mqtt.connect(brokerUrl, {
            clientId: `gridslurp_${playerIdRef.current}_${Math.random().toString(16).slice(2, 6)}`,
            clean: true,
            keepalive: 20,
            connectTimeout: 3500,
            reconnectPeriod: 1500,
          });
          mqttRef.current = client;

          if (brokerIndex === 0 && MQTT_BROKERS.length > 1) {
            brokerFallbackTimer = setTimeout(() => {
              if (!connectedOnce && !isUnmounted) {
                try {
                  client.end(true);
                } catch {
                  // ignore
                }
                connectMqttBroker(1);
              }
            }, 3800);
          }

          client.on('connect', () => {
            connectedOnce = true;
            if (brokerFallbackTimer) clearTimeout(brokerFallbackTimer);
            if (isUnmounted) return;
            setConnectionMode('ws');
            client.subscribe(meshTopic, { qos: 0 });
            publishMeshPacket({
              type: 'mesh_heartbeat',
              senderId: playerIdRef.current,
              playing: myJoinInfoRef.current.playing,
              name: myJoinInfoRef.current.name,
              colorId: myJoinInfoRef.current.colorId,
              hidden: isSelfHidden(),
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
      };

      connectMqttBroker(0);

      const initialSnap = engine.getSnapshot();
      snapshotRef.current = initialSnap;
      lastSnapshotTimeRef.current = performance.now();
      processSnapshotEvents(initialSnap);

      // Lightweight periodic peer heartbeat & stale player cleanup
      heartbeatInterval = setInterval(() => {
        const now = performance.now();
        // Coordinator already proves liveness every tick via mesh_state when active
        if (!meshCoordRef.current.isCoordinator || activePeersRef.current.size === 0) {
          publishMeshPacket({
            type: 'mesh_heartbeat',
            senderId: playerIdRef.current,
            playing: myJoinInfoRef.current.playing,
            name: myJoinInfoRef.current.name,
            colorId: myJoinInfoRef.current.colorId,
            hidden: isSelfHidden(),
          });
        }

        // Clean up disconnected remote human players after 6.5s of silence
        for (const [pid, info] of activePeersRef.current.entries()) {
          if (now - info.lastSeen > 6500) {
            activePeersRef.current.delete(pid);
            if (meshCoordRef.current.isCoordinator) {
              localEngineRef.current?.removePlayer(pid);
            }
          }
        }
      }, 900);

      // Drift-compensated Authoritative Room Coordinator step loop
      let lastTickExecutedAt = 0;
      const executeMeshTick = () => {
        if (isUnmounted) return;
        const now = performance.now();
        if (now - lastTickExecutedAt < TICK_MS * 0.65) {
          return;
        }
        lastTickExecutedAt = now;
        const mc = meshCoordRef.current;

        if (canBecomeCoordinator(now)) {
          if (!mc.isCoordinator) {
            mc.isCoordinator = true;
            mc.activeCoordId = playerIdRef.current;
            mc.activeCoordHidden = isSelfHidden();
            mc.coordEpoch = Math.max(1, mc.coordEpoch + 1, mc.lastAcceptedEpoch + 1);
            if (mc.needsHydrateBeforeStep && snapshotRef.current) {
              engine.hydrateFromSnapshot(snapshotRef.current);
              mc.needsHydrateBeforeStep = false;
            }
            // If local user joined during discovery window before promotion, ensure they spawn now
            if (
              myJoinInfoRef.current.playing &&
              gameStateRef.current === 'PLAYING' &&
              !engine.snakes.get(playerIdRef.current)?.alive
            ) {
              engine.spawnPlayer(
                playerIdRef.current,
                myJoinInfoRef.current.name,
                myJoinInfoRef.current.colorId,
                false,
                undefined,
                myJoinInfoRef.current.faceId
              );
            }
          }

          const snap = engine.step();
          const activeHumans =
            1 +
            Array.from(activePeersRef.current.values()).filter((p) => now - p.lastSeen < 6500)
              .length;
          snap.onlinePlayers = Math.max(snap.onlinePlayers, activeHumans);

          mc.lastAcceptedEpoch = mc.coordEpoch;
          mc.lastAcceptedTick = snap.tick;
          mc.lastCoordMsgAt = now;
          mc.activeCoordHidden = isSelfHidden();

          snapshotRef.current = snap;
          lastSnapshotTimeRef.current = now;
          processSnapshotEvents(snap);

          publishMeshPacket({
            type: 'mesh_state',
            senderId: playerIdRef.current,
            epoch: mc.coordEpoch,
            hidden: mc.activeCoordHidden,
            state: packSnapshot(snap),
          });
        }
      };

      // Use a dedicated Web Worker timer so browser background/occlusion throttling never clamps ticks to 1/sec
      let workerStarted = false;
      try {
        const workerSrc = `
          let running = false;
          let timer = null;
          let nextAt = 0;
          let stepMs = ${TICK_MS};
          function loop() {
            if (!running) return;
            const now = performance.now();
            self.postMessage('tick');
            nextAt += stepMs;
            if (nextAt < now - stepMs) nextAt = now + stepMs;
            timer = setTimeout(loop, Math.max(1, nextAt - performance.now()));
          }
          self.onmessage = function(e) {
            if (e.data === 'stop') {
              running = false;
              if (timer !== null) { clearTimeout(timer); timer = null; }
            } else if (typeof e.data === 'number') {
              stepMs = e.data;
              running = true;
              if (timer !== null) clearTimeout(timer);
              nextAt = performance.now() + stepMs;
              timer = setTimeout(loop, stepMs);
            }
          };
        `;
        const blob = new Blob([workerSrc], { type: 'application/javascript' });
        tickWorkerUrl = URL.createObjectURL(blob);
        tickWorker = new Worker(tickWorkerUrl);
        tickWorker.onmessage = () => {
          executeMeshTick();
        };
        tickWorker.postMessage(TICK_MS);
        workerStarted = true;
      } catch {
        workerStarted = false;
      }

      if (!workerStarted) {
        let nextTickAt = performance.now() + TICK_MS;
        const runMeshTickFallback = () => {
          if (isUnmounted) return;
          executeMeshTick();
          const now = performance.now();
          nextTickAt += TICK_MS;
          if (nextTickAt < now - TICK_MS) {
            nextTickAt = now + TICK_MS;
          }
          tickTimeout = setTimeout(runMeshTickFallback, Math.max(1, nextTickAt - performance.now()));
        };
        tickTimeout = setTimeout(runMeshTickFallback, TICK_MS);
      }
    };

    const handleVisibilityChange = () => {
      if (!localEngineRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) {
        sendCoordinatorHandoff();
      } else {
        publishMeshPacket({
          type: 'mesh_heartbeat',
          senderId: playerIdRef.current,
          playing: myJoinInfoRef.current.playing,
          name: myJoinInfoRef.current.name,
          colorId: myJoinInfoRef.current.colorId,
          hidden: false,
        });
      }
    };

    window.addEventListener('pagehide', sendCoordinatorHandoff);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    let activeTickSeenOnWs = -1;

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?size=${serverGridSize}`;
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
      }, 2000);

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
            const unpacked = unpackSnapshot(msg.state);
            activeTickSeenOnWs = unpacked.tick;
            snapshotRef.current = unpacked;
            lastSnapshotTimeRef.current = performance.now();
            processSnapshotEvents(unpacked);
          } else if (msg.type === 'state') {
            const unpacked = unpackSnapshot(msg.state);
            if (unpacked.tick < activeTickSeenOnWs) return;
            activeTickSeenOnWs = unpacked.tick;
            snapshotRef.current = unpacked;
            lastSnapshotTimeRef.current = performance.now();
            processSnapshotEvents(unpacked);
          } else if (msg.type === 'admin_track') {
            isAdminMusicActiveRef.current = true;
            setIsAdminMusicActive(true);
            playNextAdminTrackRef.current(msg.trackId);
          } else if (msg.type === 'kick_admin') {
            handleIncomingAdminKickRef.current(msg.targetPlayerId, msg.issuedByClientId);
          } else if (msg.type === 'trade_offer') {
            if (msg.offer.toId === playerIdRef.current) {
              setIncomingTrades((prev) =>
                prev.some((o) => o.id === msg.offer.id) ? prev : [...prev.slice(-3), msg.offer]
              );
            }
          } else if (msg.type === 'trade_result') {
            if (msg.ok && msg.accepted) {
              soundEngine.playLootBoxPickup();
            }
            setIncomingTrades((prev) => prev.filter((o) => o.id !== msg.offerId));
            setTradeFeedback({ text: msg.summary, ok: msg.ok });
          } else if (msg.type === 'pellet_flood_notice') {
            if (msg.action === 'FLOOD_SCREEN') {
              soundEngine.playLootBoxPickup();
              setPelletFloodFeedback(
                `${msg.byName} flooded the screen with ${msg.count.toLocaleString()} flashing pellets!`
              );
            } else {
              setPelletFloodFeedback(
                `${msg.byName} cleared ${msg.count.toLocaleString()} pellets from the grid.`
              );
            }
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
      window.removeEventListener('pagehide', sendCoordinatorHandoff);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      sendCoordinatorHandoff();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (tickTimeout) clearTimeout(tickTimeout);
      if (tickWorker) {
        try {
          tickWorker.postMessage('stop');
          tickWorker.terminate();
        } catch {
          // ignore
        }
      }
      if (tickWorkerUrl) {
        try {
          URL.revokeObjectURL(tickWorkerUrl);
        } catch {
          // ignore
        }
      }
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
          faceId: msg.faceId,
          playing: true,
        };
      } else if (msg.type === 'set_face') {
        myJoinInfoRef.current.faceId = msg.faceId;
      } else if (msg.type === 'leave') {
        myJoinInfoRef.current.playing = false;
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
        return;
      }

      // Global Mesh / Vercel Multiplayer command dispatch:
      // Only mutate localEngineRef directly when WE are the coordinator (or no coordinator is active yet)
      const engine = localEngineRef.current;
      const mc = meshCoordRef.current;
      if (engine && (mc.isCoordinator || !mc.activeCoordId)) {
        if (msg.type === 'join' || msg.type === 'respawn') {
          engine.spawnPlayer(
            pid,
            msg.name,
            msg.colorId,
            Boolean(msg.autoPilot),
            msg.autoPilotTier,
            msg.faceId
          );
          snapshotRef.current = engine.getSnapshot();
        } else if (msg.type === 'set_face') {
          engine.setPlayerFace(pid, msg.faceId);
          snapshotRef.current = engine.getSnapshot();
        } else if (msg.type === 'turn') {
          engine.queueTurn(pid, msg.dir, msg.seq);
        } else if (msg.type === 'autopilot') {
          engine.setAutopilot(pid, Boolean(msg.enabled), msg.tier);
        } else if (msg.type === 'kick_admin') {
          if (msg.targetPlayerId === '*') {
            for (const s of engine.snakes.values()) {
              if (!s.isBot && s.id !== msg.issuedByClientId) {
                engine.setAutopilot(s.id, false);
              }
            }
          } else if (msg.targetPlayerId && msg.targetPlayerId !== msg.issuedByClientId) {
            engine.setAutopilot(msg.targetPlayerId, false);
          }
        } else if (msg.type === 'adminry_pellet_flood') {
          const senderSnake = engine.snakes.get(pid);
          const candidateName = (senderSnake?.name || msg.issuedByName || '').trim().toUpperCase();
          if (candidateName.startsWith('ADMINRY')) {
            const action = msg.action === 'CLEAR' ? 'CLEAR' : 'FLOOD_SCREEN';
            const count =
              action === 'CLEAR' ? engine.clearAllPellets() : engine.floodScreenWithPellets();
            snapshotRef.current = engine.getSnapshot();
            if (action === 'FLOOD_SCREEN') {
              soundEngine.playLootBoxPickup();
              setPelletFloodFeedback(
                `Flooded the screen with ${count.toLocaleString()} flashing pellets!`
              );
            } else {
              setPelletFloodFeedback(`Cleared ${count.toLocaleString()} pellets from the grid.`);
            }
            const noticePacket = {
              type: 'mesh_pellet_flood',
              senderId: pid,
              action,
              count,
              byName: candidateName,
            };
            if (mqttRef.current && mqttRef.current.connected) {
              try {
                mqttRef.current.publish(getMeshTopic(serverGridSize), JSON.stringify(noticePacket), {
                  qos: 0,
                });
              } catch {
                // ignore
              }
            }
            try {
              broadcastChannelRef.current?.postMessage(noticePacket);
            } catch {
              // ignore
            }
          }
        } else if (msg.type === 'adminry_give_lives') {
          const senderSnake = engine.snakes.get(pid);
          const candidateName = (senderSnake?.name || msg.issuedByName || '').trim().toUpperCase();
          if (candidateName.startsWith('ADMINRY')) {
            const resolvedTarget = msg.targetPlayerId === 'ME' ? pid : msg.targetPlayerId;
            const amount = Math.max(-999, Math.min(99, Math.trunc(Number(msg.amount) || 0)));
            const res = engine.adminGiveExtraLives(resolvedTarget, amount);
            if (res.ok) {
              snapshotRef.current = engine.getSnapshot();
              if (amount > 0) soundEngine.playLootBoxPickup();
              const summary =
                amount < 0
                  ? `Cleared Extra Lives for ${res.targetName || 'player'}.`
                  : resolvedTarget === '*'
                    ? `Gave +${amount} Extra ${amount === 1 ? 'Life' : 'Lives'} to all alive players!`
                    : `Gave +${amount} Extra ${amount === 1 ? 'Life' : 'Lives'} to ${res.targetName || 'player'} (now ×${res.newLives ?? 0}).`;
              setDebugLivesFeedback(summary);
              const resultPacket = {
                type: 'mesh_trade_result',
                senderId: pid,
                offerId: `dbg_${Date.now()}`,
                fromId: pid,
                toId: resolvedTarget,
                ok: true,
                accepted: amount > 0,
                summary: `${candidateName}: ${summary}`,
              };
              if (mqttRef.current && mqttRef.current.connected) {
                try {
                  mqttRef.current.publish(
                    getMeshTopic(serverGridSize),
                    JSON.stringify(resultPacket),
                    { qos: 0 }
                  );
                } catch {
                  // ignore
                }
              }
              try {
                broadcastChannelRef.current?.postMessage(resultPacket);
              } catch {
                // ignore
              }
            } else {
              setDebugLivesFeedback('Spawn into the arena first so your snake can receive lives.');
            }
          }
        } else if (msg.type === 'give_life') {
          const res = engine.giveExtraLife(pid, msg.targetPlayerId);
          const fromSnake = engine.snakes.get(pid);
          const toSnake = engine.snakes.get(msg.targetPlayerId);
          const summary = res.ok
            ? `${fromSnake?.name || 'Player'} gave 1 Extra Life to ${toSnake?.name || 'Player'}!`
            : res.reason || 'Transfer failed.';
          if (res.ok) soundEngine.playLootBoxPickup();
          setTradeFeedback({ text: summary, ok: res.ok });
          const resultPacket = {
            type: 'mesh_trade_result',
            senderId: pid,
            offerId: `give_${Date.now()}`,
            fromId: pid,
            toId: msg.targetPlayerId,
            ok: res.ok,
            accepted: true,
            summary,
          };
          if (mqttRef.current && mqttRef.current.connected) {
            try {
              mqttRef.current.publish(getMeshTopic(serverGridSize), JSON.stringify(resultPacket), {
                qos: 0,
              });
            } catch {
              // ignore
            }
          }
          try {
            broadcastChannelRef.current?.postMessage(resultPacket);
          } catch {
            // ignore
          }
        } else if (msg.type === 'trade_response') {
          const offer = msg.offer;
          let ok = true;
          let summary = `${offer.toName} declined the life trade.`;
          if (msg.accepted) {
            const res = engine.executeLifeTrade(offer);
            ok = res.ok;
            const giveLabel =
              offer.giveType === 'LIFE' ? `${offer.giveAmount} Life` : `${offer.giveAmount} PTS`;
            const wantLabel =
              offer.wantType === 'LIFE' ? `${offer.wantAmount} Life` : `${offer.wantAmount} PTS`;
            summary = res.ok
              ? `Trade complete: ${offer.fromName} (${giveLabel}) ⇄ ${offer.toName} (${wantLabel})`
              : res.reason || 'Trade failed.';
          }
          if (ok && msg.accepted) soundEngine.playLootBoxPickup();
          setTradeFeedback({ text: summary, ok });
          const resultPacket = {
            type: 'mesh_trade_result',
            senderId: pid,
            offerId: msg.offerId,
            fromId: offer.fromId,
            toId: offer.toId,
            ok,
            accepted: msg.accepted,
            summary,
          };
          if (mqttRef.current && mqttRef.current.connected) {
            try {
              mqttRef.current.publish(getMeshTopic(serverGridSize), JSON.stringify(resultPacket), {
                qos: 0,
              });
            } catch {
              // ignore
            }
          }
          try {
            broadcastChannelRef.current?.postMessage(resultPacket);
          } catch {
            // ignore
          }
        } else if (msg.type === 'leave') {
          engine.removePlayer(pid);
        }
      }

      const packet = {
        type: 'mesh_cmd',
        senderId: pid,
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

  // Persist playlist store changes
  const updatePlaylistStore = useCallback(
    (updater: (prev: PlaylistStoreState) => PlaylistStoreState) => {
      setPlaylistStore((prev) => {
        const next = updater(prev);
        savePlaylistStore(next);
        return next;
      });
    },
    []
  );

  const adminQueueRef = useRef<{ queue: string[]; index: number }>({
    queue: [],
    index: 0,
  });
  const defaultQueueRef = useRef<{
    playlistKey: string;
    shuffle: boolean;
    queue: string[];
    index: number;
  }>({
    playlistKey: '',
    shuffle: true,
    queue: [],
    index: 0,
  });

  const createShuffledOrder = useCallback(
    (ids: string[], lastPlayedId?: string | null): string[] => {
      const shuffled = [...ids];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
      }
      // If reshuffling at the end of a playlist with 2+ tracks, avoid repeating the last track of the previous loop right away
      if (shuffled.length > 1 && lastPlayedId && shuffled[0] === lastPlayedId) {
        const swapIdx = 1 + Math.floor(Math.random() * (shuffled.length - 1));
        const tmp = shuffled[0];
        shuffled[0] = shuffled[swapIdx];
        shuffled[swapIdx] = tmp;
      }
      return shuffled;
    },
    []
  );

  // Play a shuffled track from the dedicated src/audio/admin/ folder (reshuffles & loops at end)
  const playNextAdminTrack = useCallback(
    (forceTrackId?: string) => {
      const audio = audioRef.current;
      if (!audio) return;

      if (ADMIN_AUDIO_TRACKS.length === 0) {
        return;
      }

      const poolIds = ADMIN_AUDIO_TRACKS.map((t) => t.id);
      let chosenId = forceTrackId;

      if (chosenId && ADMIN_AUDIO_TRACKS.some((t) => t.id === chosenId)) {
        adminQueueRef.current.queue = createShuffledOrder(poolIds);
        const foundIdx = adminQueueRef.current.queue.indexOf(chosenId);
        adminQueueRef.current.index = foundIdx >= 0 ? foundIdx + 1 : 0;
      } else {
        // When we reach the end of the admin playlist (or haven't built it yet), reshuffle and loop from the start!
        if (
          adminQueueRef.current.queue.length !== poolIds.length ||
          adminQueueRef.current.index >= adminQueueRef.current.queue.length
        ) {
          adminQueueRef.current.queue = createShuffledOrder(poolIds, currentTrackId);
          adminQueueRef.current.index = 0;
        }
        chosenId = adminQueueRef.current.queue[adminQueueRef.current.index];
        adminQueueRef.current.index += 1;
      }

      const track = ADMIN_AUDIO_TRACKS.find((t) => t.id === chosenId);
      if (!track) return;

      setCurrentTrackId(track.id);
      const targetHref = new URL(track.url, window.location.origin).href;
      if (audio.src !== targetHref) {
        audio.src = track.url;
      } else {
        audio.currentTime = 0;
      }
      audio.volume = muted || !playlistStore.musicEnabled ? 0 : playlistStore.volume;
      audio
        .play()
        .then(() => setIsMusicPlaying(true))
        .catch(() => setIsMusicPlaying(false));
    },
    [createShuffledOrder, currentTrackId, muted, playlistStore.musicEnabled, playlistStore.volume]
  );

  useEffect(() => {
    playNextAdminTrackRef.current = playNextAdminTrack;
  }, [playNextAdminTrack]);

  // Pick next track from the active default playlist: plays through all tracks, then reshuffles and loops at the end
  const playNextPlaylistTrack = useCallback(
    (forceTrackId?: string) => {
      const audio = audioRef.current;
      if (!audio) return;

      isAdminMusicActiveRef.current = false;
      setIsAdminMusicActive(false);

      const activePl =
        playlistStore.playlists.find((p) => p.id === playlistStore.activePlaylistId) ||
        playlistStore.playlists[0];
      const poolIds =
        activePl && activePl.trackIds.length > 0
          ? activePl.trackIds
          : DISCOVERED_AUDIO_TRACKS.map((t) => t.id);

      if (poolIds.length === 0) {
        audio.pause();
        setIsMusicPlaying(false);
        return;
      }

      const playlistKey = `${activePl?.id || 'default'}:${poolIds.join(',')}`;
      let chosenId = forceTrackId;

      if (chosenId && DISCOVERED_AUDIO_TRACKS.some((t) => t.id === chosenId)) {
        const nextQueue = playlistStore.shuffle
          ? createShuffledOrder(poolIds)
          : [...poolIds];
        const foundIdx = nextQueue.indexOf(chosenId);
        defaultQueueRef.current = {
          playlistKey,
          shuffle: playlistStore.shuffle,
          queue: nextQueue,
          index: foundIdx >= 0 ? foundIdx + 1 : 0,
        };
      } else {
        const qState = defaultQueueRef.current;
        const needsRebuildOrReshuffle =
          qState.playlistKey !== playlistKey ||
          qState.shuffle !== playlistStore.shuffle ||
          qState.queue.length === 0 ||
          qState.index >= qState.queue.length;

        // Once it gets to the end of the playlist, reshuffle and loop from that new order!
        if (needsRebuildOrReshuffle) {
          qState.playlistKey = playlistKey;
          qState.shuffle = playlistStore.shuffle;
          qState.queue = playlistStore.shuffle
            ? createShuffledOrder(poolIds, currentTrackId)
            : [...poolIds];
          qState.index = 0;
        }

        chosenId = qState.queue[qState.index];
        qState.index += 1;
      }

      const track = DISCOVERED_AUDIO_TRACKS.find((t) => t.id === chosenId);
      if (!track) return;

      setCurrentTrackId(track.id);
      const targetHref = new URL(track.url, window.location.origin).href;
      if (audio.src !== targetHref) {
        audio.src = track.url;
      } else {
        audio.currentTime = 0;
      }
      audio.volume = muted || !playlistStore.musicEnabled ? 0 : playlistStore.volume;
      audio
        .play()
        .then(() => setIsMusicPlaying(true))
        .catch(() => setIsMusicPlaying(false));
    },
    [createShuffledOrder, playlistStore, currentTrackId, muted]
  );

  // Sync volume & mute state to the HTML5 Audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = muted || !playlistStore.musicEnabled ? 0 : playlistStore.volume;
    if (!playlistStore.musicEnabled && !audio.paused) {
      audio.pause();
      setIsMusicPlaying(false);
    }
  }, [muted, playlistStore.volume, playlistStore.musicEnabled]);

  const lastSentAutoPilotRef = useRef<boolean>(false);

  useEffect(() => {
    autoPilotActiveRef.current = autoPilotActive;
  }, [autoPilotActive]);

  useEffect(() => {
    keepAutoPilotOnCloseRef.current = keepAutoPilotOnClose;
  }, [keepAutoPilotOnClose]);

  const stopAutoPilot = useCallback(() => {
    autoPilotActiveRef.current = false;
    setAutoPilotActive(false);
    if (lastSentAutoPilotRef.current) {
      lastSentAutoPilotRef.current = false;
      sendCommand({ type: 'autopilot', enabled: false });
    }
  }, [sendCommand]);

  // Keep local mesh heartbeat name synced while in menu so peers can see ADMIN names
  useEffect(() => {
    if (!myJoinInfoRef.current.playing) {
      myJoinInfoRef.current.name = playerName.trim().toUpperCase().slice(0, 24) || 'VIPER_01';
    }
  }, [playerName]);

  // Ephemeral session-only admin kick receiver (resets automatically on page reload; never stored on server)
  useEffect(() => {
    handleIncomingAdminKickRef.current = (targetPlayerId: string, issuedByClientId: string) => {
      const myId = playerIdRef.current;
      if (issuedByClientId === myId) return;
      if (targetPlayerId !== myId && targetPlayerId !== '*') return;

      setAdminKickedThisSession(true);
      setShowAdminModal(false);
      stopAutoPilot();
      if (isAdminMusicActiveRef.current) {
        isAdminMusicActiveRef.current = false;
        setIsAdminMusicActive(false);
        if (audioRef.current && !audioRef.current.paused) {
          audioRef.current.pause();
          setIsMusicPlaying(false);
        }
      }
    };
  }, [stopAutoPilot]);

  const handleKickOffAdmin = useCallback(
    (targetPlayerId: string, displayLabel: string) => {
      if (!isSuperAdminRy) return;
      sendCommand({
        type: 'kick_admin',
        targetPlayerId,
        issuedByClientId: playerIdRef.current,
      });
      setKickFeedbackMsg(`Kicked ${displayLabel} off admin until they reload the page.`);
    },
    [isSuperAdminRy, sendCommand]
  );

  const handleAdminRyPelletFlood = useCallback(
    (action: 'FLOOD_SCREEN' | 'CLEAR') => {
      if (!isSuperAdminRy) return;
      sendCommand({
        type: 'adminry_pellet_flood',
        action,
        issuedByName: playerName.trim().toUpperCase().slice(0, 24),
      });
      setPelletFloodFeedback(
        action === 'FLOOD_SCREEN'
          ? 'Flooding the entire arena with flashing pellets...'
          : 'Clearing pellets from the arena...'
      );
    },
    [isSuperAdminRy, playerName, sendCommand]
  );

  const handleAdminRyGiveLives = useCallback(
    (targetPlayerId: string, amount: number, targetLabel: string) => {
      if (!isSuperAdminRy) return;
      if (targetPlayerId === 'ME' && (gameState !== 'PLAYING' || !hudStats.alive)) {
        setDebugLivesFeedback('Spawn into the arena first to give lives to your snake.');
        return;
      }
      sendCommand({
        type: 'adminry_give_lives',
        targetPlayerId,
        amount,
        issuedByName: playerName.trim().toUpperCase().slice(0, 24),
      });
      setDebugLivesFeedback(
        amount < 0
          ? `Cleared Extra Lives for ${targetLabel}.`
          : `Granted +${amount} Extra ${amount === 1 ? 'Life' : 'Lives'} to ${targetLabel}.`
      );
    },
    [gameState, hudStats.alive, isSuperAdminRy, playerName, sendCommand]
  );

  useEffect(() => {
    if (!kickFeedbackMsg) return;
    const timer = setTimeout(() => setKickFeedbackMsg(null), 3000);
    return () => clearTimeout(timer);
  }, [kickFeedbackMsg]);

  useEffect(() => {
    if (!pelletFloodFeedback) return;
    const timer = setTimeout(() => setPelletFloodFeedback(null), 4000);
    return () => clearTimeout(timer);
  }, [pelletFloodFeedback]);

  useEffect(() => {
    if (!debugLivesFeedback) return;
    const timer = setTimeout(() => setDebugLivesFeedback(null), 3800);
    return () => clearTimeout(timer);
  }, [debugLivesFeedback]);

  useEffect(() => {
    if (!tradeFeedback) return;
    const timer = setTimeout(() => setTradeFeedback(null), 3800);
    return () => clearTimeout(timer);
  }, [tradeFeedback]);

  useEffect(() => {
    if (gameState !== 'PLAYING') {
      setShowTradeModal(false);
    }
  }, [gameState]);

  const handleGiveExtraLife = useCallback(
    (targetId: string, targetName: string) => {
      if (hudStats.extraLives < 1) {
        setTradeFeedback({ text: 'You need at least 1 Extra Life to give.', ok: false });
        return;
      }
      sendCommand({ type: 'give_life', targetPlayerId: targetId });
      setTradeFeedback({ text: `Sending 1 Extra Life to ${targetName}...`, ok: true });
    },
    [hudStats.extraLives, sendCommand]
  );

  const handleSendTradeOffer = useCallback(
    (
      targetId: string,
      targetName: string,
      giveType: 'LIFE' | 'SCORE',
      giveAmount: number,
      wantType: 'LIFE' | 'SCORE',
      wantAmount: number
    ) => {
      if (!targetId) return;
      if (giveType === 'LIFE' && hudStats.extraLives < giveAmount) {
        setTradeFeedback({ text: `You need at least ${giveAmount} Extra Life.`, ok: false });
        return;
      }
      if (giveType === 'SCORE' && hudStats.score < giveAmount) {
        setTradeFeedback({ text: `You need at least ${giveAmount} Score.`, ok: false });
        return;
      }
      const offer: LifeTradeOffer = {
        id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        fromId: playerIdRef.current,
        fromName: playerName.trim().toUpperCase().slice(0, 24) || 'VIPER_01',
        toId: targetId,
        toName: targetName,
        giveType,
        giveAmount,
        wantType,
        wantAmount,
        createdAt: Date.now(),
      };
      sendCommand({ type: 'trade_offer', offer });
      setTradeFeedback({ text: `Trade offer sent to ${targetName}!`, ok: true });
    },
    [hudStats.extraLives, hudStats.score, playerName, sendCommand]
  );

  const handleRespondToTrade = useCallback(
    (offer: LifeTradeOffer, accepted: boolean) => {
      sendCommand({
        type: 'trade_response',
        offerId: offer.id,
        accepted,
        offer,
      });
      setIncomingTrades((prev) => prev.filter((o) => o.id !== offer.id));
    },
    [sendCommand]
  );

  const openAdminModal = useCallback(() => {
    if (!isAdminName) return;
    setShowAdminModal(true);
    if (gameState === 'PLAYING' && isAdminName && adminAutoPilot) {
      autoPilotActiveRef.current = true;
      setAutoPilotActive(true);
    }
  }, [adminAutoPilot, gameState, isAdminName]);

  const closeAdminModal = useCallback(
    (forceKeepAutopilot = false) => {
      if (forceKeepAutopilot && gameState === 'PLAYING' && isAdminName) {
        autoPilotActiveRef.current = true;
        setAutoPilotActive(true);
      } else if (!keepAutoPilotOnCloseRef.current) {
        stopAutoPilot();
      }
      setShowAdminModal(false);
    },
    [gameState, isAdminName, stopAutoPilot]
  );

  const handleSelectFace = useCallback(
    (faceId: string) => {
      const normalized = faceId && faceId !== 'default' ? faceId : 'default';
      setSelectedFaceId(normalized);
      selectedFaceIdRef.current = normalized;
      saveSelectedFaceId(normalized);
      if (gameStateRef.current === 'PLAYING') {
        sendCommand({
          type: 'set_face',
          faceId: normalized !== 'default' ? normalized : undefined,
        });
      }
    },
    [sendCommand]
  );

  const handleStartOrRespawn = useCallback(() => {
    const cleanName = playerName.trim().toUpperCase().slice(0, 24) || 'VIPER_01';
    const cleanFaceId = selectedFaceId !== 'default' ? selectedFaceId : undefined;
    lastAutoJoinSentAtRef.current = performance.now();
    lastSentAutoPilotRef.current = false;
    autoPilotActiveRef.current = false;
    setAutoPilotActive(false);
    predictedTurnsRef.current = [];
    sendCommand({
      type: 'join',
      name: cleanName,
      colorId: selectedColorId,
      faceId: cleanFaceId,
      clientId: playerIdRef.current,
      gridSize: serverGridSize,
    });
    setIsSpectating(false);
    setGameState('PLAYING');
  }, [playerName, selectedColorId, selectedFaceId, serverGridSize, sendCommand]);

  const handleToggleMute = useCallback(() => {
    const nextMuted = soundEngine.toggleMute();
    setMuted(nextMuted);
  }, []);

  const handleToggleZoom = useCallback(() => {
    setZoomIn16((prev) => {
      const next = !prev;
      if (next && gameStateRef.current !== 'PLAYING') {
        pickRandomSpectatedSnake(snapshotRef.current, spectatedSnakeIdRef.current);
      }
      return next;
    });
  }, [pickRandomSpectatedSnake]);

  const handleToggleSpectatorMode = useCallback(() => {
    setGameState('TITLE_MENU');
    setIsSpectating((prev) => {
      const next = !prev;
      if (next && zoomIn16Ref.current) {
        const snap = snapshotRef.current;
        const currentValid =
          spectatedSnakeIdRef.current &&
          snap?.snakes.some((s) => s.id === spectatedSnakeIdRef.current && s.alive);
        if (!currentValid) {
          pickRandomSpectatedSnake(snap);
        }
      }
      return next;
    });
  }, [pickRandomSpectatedSnake]);

  const handleToggleMobileControls = useCallback(() => {
    setMobileControlsEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('gridslurp_mobile_controls', String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const issueDirectionalTurn = useCallback(
    (requestedDir: Direction) => {
      if (gameStateRef.current !== 'PLAYING') return;
      if (autoPilotActiveRef.current) {
        stopAutoPilot();
      }

      const snap = snapshotRef.current;
      const me = snap?.snakes.find((s) => s.id === playerIdRef.current && s.alive);
      const pending = predictedTurnsRef.current;
      const plannedQueue: Direction[] = [
        ...(me?.nextDirs ?? []),
        ...pending.map((p) => p.dir),
      ];
      const lastPlannedDir =
        plannedQueue.length > 0 ? plannedQueue[plannedQueue.length - 1] : me?.dir;

      if (lastPlannedDir && requestedDir === lastPlannedDir) {
        return;
      }

      if (plannedQueue.length >= 4) {
        return;
      }

      const seq = ++turnSeqRef.current;
      pending.push({
        dir: requestedDir,
        seq,
        sentAt: performance.now(),
      });

      soundEngine.playTurnBlip();
      sendCommand({ type: 'turn', dir: requestedDir, seq });
    },
    [sendCommand, stopAutoPilot]
  );

  const handleMobileTurn = useCallback(
    (dir: Direction) => {
      issueDirectionalTurn(dir);
    },
    [issueDirectionalTurn]
  );

  const handleToggleAdminAutoPilot = useCallback(() => {
    setAdminAutoPilot((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('gridslurp_admin_autopilot', String(next));
      } catch {
        // ignore storage errors
      }
      if (gameState === 'PLAYING' && isAdminName && showAdminModal) {
        autoPilotActiveRef.current = next;
        setAutoPilotActive(next);
      } else if (!next) {
        autoPilotActiveRef.current = false;
        setAutoPilotActive(false);
      }
      return next;
    });
  }, [gameState, isAdminName, showAdminModal]);

  const handleToggleKeepAutoPilotOnClose = useCallback(() => {
    setKeepAutoPilotOnClose((prev) => {
      const next = !prev;
      keepAutoPilotOnCloseRef.current = next;
      try {
        localStorage.setItem('gridslurp_admin_autopilot_keep_on_close', String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  useEffect(() => {
    isAdminNameRef.current = isAdminName;
    isSuperAdminRyRef.current = isSuperAdminRy;
    playerNameRef.current = playerName;
    selectedColorIdRef.current = selectedColorId;
    selectedFaceIdRef.current = selectedFaceId;
  }, [isAdminName, isSuperAdminRy, playerName, selectedColorId, selectedFaceId]);

  useEffect(() => {
    triggerAutoPilotRespawnRef.current = () => {
      const now = performance.now();
      if (now - lastAutoRespawnAtRef.current < 350) return;
      if (!autoPilotActiveRef.current || !isAdminNameRef.current) return;
      lastAutoRespawnAtRef.current = now;

      const cleanName = playerNameRef.current.trim().toUpperCase().slice(0, 24) || 'VIPER_01';
      const tier: 'STANDARD' | 'ADMINRY' = isSuperAdminRyRef.current ? 'ADMINRY' : 'STANDARD';
      const cleanFaceId =
        selectedFaceIdRef.current && selectedFaceIdRef.current !== 'default'
          ? selectedFaceIdRef.current
          : undefined;

      predictedTurnsRef.current = [];
      gameStateRef.current = 'PLAYING';
      setGameState('PLAYING');
      setIsSpectating(false);
      lastSentAutoPilotRef.current = true;
      lastAutoJoinSentAtRef.current = now;

      sendCommand({
        type: 'respawn',
        name: cleanName,
        colorId: selectedColorIdRef.current,
        faceId: cleanFaceId,
        gridSize: serverGridSize,
        autoPilot: true,
        autoPilotTier: tier,
      });
      sendCommand({
        type: 'autopilot',
        enabled: true,
        tier,
      });
    };
  }, [sendCommand, serverGridSize]);

  // If autopilot is active and GAME_OVER ever opened, automatically close the menu and continue
  useEffect(() => {
    if (gameState === 'GAME_OVER' && autoPilotActiveRef.current && isAdminName) {
      triggerAutoPilotRespawnRef.current();
      return;
    }
    if ((gameState !== 'PLAYING' && gameState !== 'GAME_OVER') || !isAdminName) {
      if (autoPilotActiveRef.current) {
        autoPilotActiveRef.current = false;
        setAutoPilotActive(false);
      }
    }
  }, [gameState, isAdminName]);

  // Sync AI Autopilot state & tier with the server / arena coordinator
  useEffect(() => {
    const shouldEnable = gameState === 'PLAYING' && isAdminName && autoPilotActive;
    if (shouldEnable !== lastSentAutoPilotRef.current) {
      lastSentAutoPilotRef.current = shouldEnable;
      sendCommand({
        type: 'autopilot',
        enabled: shouldEnable,
        tier: isSuperAdminRy ? 'ADMINRY' : 'STANDARD',
      });
    }
  }, [autoPilotActive, gameState, isAdminName, isSuperAdminRy, sendCommand]);

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

      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        handleToggleZoom();
        return;
      }

      if (gameState === 'TITLE_MENU' || gameState === 'GAME_OVER') {
        if (e.key === 'Escape' && gameState === 'TITLE_MENU' && isSpectatingRef.current) {
          e.preventDefault();
          setIsSpectating(false);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleStartOrRespawn();
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (showAdminModal) {
          closeAdminModal(false);
          return;
        }
        if (showTradeModal) {
          setShowTradeModal(false);
          return;
        }
        setGameState((prev) => (prev === 'PLAYING' ? 'PAUSED' : 'PLAYING'));
        return;
      }

      if ((e.key === 't' || e.key === 'T') && gameState === 'PLAYING' && !showAdminModal) {
        e.preventDefault();
        setShowTradeModal((prev) => !prev);
        return;
      }

      if (showAdminModal || showTradeModal) return;

      if (gameState !== 'PLAYING') return;

      if (e.repeat) return;

      // Strictly WASD and Arrow Keys for directional movement on the grid
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
        issueDirectionalTurn(requestedDir);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    closeAdminModal,
    gameState,
    handleStartOrRespawn,
    handleToggleMute,
    handleToggleZoom,
    issueDirectionalTurn,
    showAdminModal,
    showTradeModal,
  ]);

  // 60FPS Hardware-Accelerated Pixel Matrix Canvas Loop
  useEffect(() => {
    let rafId = 0;
    let lastFrameTime = performance.now();
    let camInitialized = false;
    // Reusable 64x64 spatial bitmap so stacked/overlapping segments on the same cell are drawn only once
    const visitedCells = new Uint8Array(64 * 64);

    // Offscreen static LED matrix cache for full-grid view (replaces 1,024-4,096 fillRects/frame with 1 drawImage)
    const bgCacheCanvas = document.createElement('canvas');
    let bgCacheKey = '';

    // Reusable per-frame geometry buckets (zero heap allocation in 60fps loop)
    const pelletBuckets = new Map<string, number[]>();
    const pelletWhiteCores: number[] = [];
    const pelletHaloCoords: number[] = [];
    const bodyBaseXs: number[] = [];
    const bodyBaseYs: number[] = [];
    const bodyTailXs: number[] = [];
    const bodyTailYs: number[] = [];
    const bodyRimXs: number[] = [];
    const bodyRimYs: number[] = [];

    const renderFrame = (now: number) => {
      rafId = requestAnimationFrame(renderFrame);
      const dtSec = Math.min(0.1, Math.max(0.001, (now - lastFrameTime) / 1000));
      lastFrameTime = now;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Hitstop freeze for heavy collision impact feel
      if (now < hitstopUntilRef.current) {
        return;
      }

      const dpr = Math.min(2, window.devicePixelRatio || 1);
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
      const isZoomed = zoomIn16Ref.current;
      // When zoomed in, a line from left to right spans exactly 16 squares on the grid
      const visibleSquares = isZoomed ? 16 : activeGridSize;
      const boardPx = displaySize;
      const cellPx = boardPx / visibleSquares;
      const gap = Math.max(0.9, cellPx * 0.09);

      const myId = playerIdRef.current;
      const rawMe = snap?.snakes.find((s) => s.id === myId && s.alive);
      let projectedMe = rawMe;

      // Show crisp queued head orientation immediately without unconfirmed segment jumps that snap back
      if (rawMe && gameStateRef.current === 'PLAYING' && !rawMe.autoPilot && !autoPilotActiveRef.current) {
        const pending = predictedTurnsRef.current;
        const plannedQueue: Direction[] = [
          ...(rawMe.nextDirs ?? []),
          ...pending.map((p) => p.dir),
        ];
        const immediateDir = plannedQueue.length > 0 ? plannedQueue[0] : rawMe.dir;

        if (immediateDir !== rawMe.dir) {
          projectedMe = {
            ...rawMe,
            dir: immediateDir,
          };
        }
      }

      // Compute continuous sub-tick camera offset in grid coordinates when zoomed to 16x16 squares
      if (isZoomed) {
        const meSnake =
          gameStateRef.current === 'PLAYING' || gameStateRef.current === 'PAUSED'
            ? projectedMe
            : undefined;
        let trackedSnake = meSnake;

        if (!trackedSnake && snap) {
          trackedSnake = snap.snakes.find(
            (s) => s.id === spectatedSnakeIdRef.current && s.alive
          );
          if (!trackedSnake) {
            // If the watched snake was killed by another snake, immediately focus on that killer snake
            const recentKill = spectatedSnakeIdRef.current
              ? [...snap.recentKills]
                  .reverse()
                  .find((k) => k.victimId === spectatedSnakeIdRef.current && k.killerId)
              : undefined;
            const killerSnake = recentKill?.killerId
              ? snap.snakes.find((s) => s.id === recentKill.killerId && s.alive)
              : undefined;
            if (killerSnake) {
              spectatedSnakeIdRef.current = killerSnake.id;
              trackedSnake = killerSnake;
            } else {
              // If the snake left the game or died to the wall, focus on a random other alive snake
              const aliveSnakes = snap.snakes.filter((s) => s.alive);
              if (aliveSnakes.length > 0) {
                const chosen =
                  aliveSnakes[Math.floor(Math.random() * aliveSnakes.length)];
                spectatedSnakeIdRef.current = chosen.id;
                trackedSnake = chosen;
              }
            }
          }
        }

        // Sub-tick interpolation factor (0.0 -> 1.0 over TICK_MS) eliminates grid-step jolts without wrap-around snaps
        const elapsedFromSnap = Math.max(0, now - lastSnapshotTimeRef.current);
        const tickAlpha = Math.min(1, elapsedFromSnap / TICK_MS);

        let focusX = activeGridSize * 0.5;
        let focusY = activeGridSize * 0.5;

        if (trackedSnake && trackedSnake.segments[0]) {
          const currHead = trackedSnake.segments[0];
          const prevHead =
            trackedSnake.prevSegments && trackedSnake.prevSegments[0]
              ? trackedSnake.prevSegments[0]
              : currHead;

          // If snake just teleported/respawned (>2 cells jump), snap to currHead; otherwise glide smoothly
          const jumpDist =
            Math.abs(currHead.x - prevHead.x) + Math.abs(currHead.y - prevHead.y);
          const interpX =
            jumpDist <= 2
              ? prevHead.x + (currHead.x - prevHead.x) * tickAlpha
              : currHead.x;
          const interpY =
            jumpDist <= 2
              ? prevHead.y + (currHead.y - prevHead.y) * tickAlpha
              : currHead.y;

          focusX = interpX + 0.5;
          focusY = interpY + 0.5;
        }

        const targetCamX = Math.max(0, Math.min(activeGridSize - 16, focusX - 8));
        const targetCamY = Math.max(0, Math.min(activeGridSize - 16, focusY - 8));

        if (!camInitialized) {
          camRef.current.x = targetCamX;
          camRef.current.y = targetCamY;
          camInitialized = true;
        } else {
          // Crisp frame-rate-independent exponential smoothing over the continuous target
          const smoothFactor = 1 - Math.exp(-dtSec * 22);
          camRef.current.x += (targetCamX - camRef.current.x) * smoothFactor;
          camRef.current.y += (targetCamY - camRef.current.y) * smoothFactor;
        }
      } else {
        camRef.current.x = 0;
        camRef.current.y = 0;
        camInitialized = false;
      }

      const startX = isZoomed ? Math.max(0, Math.floor(camRef.current.x) - 1) : 0;
      const endX = isZoomed
        ? Math.min(activeGridSize, Math.ceil(camRef.current.x + 16) + 1)
        : activeGridSize;
      const startY = isZoomed ? Math.max(0, Math.floor(camRef.current.y) - 1) : 0;
      const endY = isZoomed
        ? Math.min(activeGridSize, Math.ceil(camRef.current.y + 16) + 1)
        : activeGridSize;

      const socketSize = cellPx - gap;
      const halfGap = gap * 0.5;
      const lastIdx = activeGridSize - 1;
      const worldPx = activeGridSize * cellPx;

      // 1 & 2. Render LED Pixel Backplane + Matrix Sockets
      if (!isZoomed) {
        const nextBgKey = `${activeGridSize}|${targetPx}`;
        if (nextBgKey !== bgCacheKey) {
          bgCacheKey = nextBgKey;
          bgCacheCanvas.width = targetPx;
          bgCacheCanvas.height = targetPx;
          const bctx = bgCacheCanvas.getContext('2d');
          if (bctx) {
            bctx.save();
            bctx.scale(dpr, dpr);
            bctx.fillStyle = '#070A0F';
            bctx.fillRect(0, 0, boardPx, boardPx);

            bctx.fillStyle = '#0E1522';
            for (let y = 1; y < lastIdx; y++) {
              const py = y * cellPx + halfGap;
              for (let x = 1; x < lastIdx; x++) {
                bctx.fillRect(x * cellPx + halfGap, py, socketSize, socketSize);
              }
            }

            bctx.fillStyle = '#131826';
            for (let x = 0; x < activeGridSize; x++) {
              const px = x * cellPx + halfGap;
              bctx.fillRect(px, halfGap, socketSize, socketSize);
              bctx.fillRect(px, lastIdx * cellPx + halfGap, socketSize, socketSize);
            }
            for (let y = 1; y < lastIdx; y++) {
              const py = y * cellPx + halfGap;
              bctx.fillRect(halfGap, py, socketSize, socketSize);
              bctx.fillRect(lastIdx * cellPx + halfGap, py, socketSize, socketSize);
            }

            bctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
            bctx.lineWidth = 1;
            bctx.beginPath();
            for (let i = 8; i < activeGridSize; i += 8) {
              const pos = i * cellPx;
              bctx.moveTo(pos, 0);
              bctx.lineTo(pos, worldPx);
              bctx.moveTo(0, pos);
              bctx.lineTo(worldPx, pos);
            }
            bctx.stroke();
            bctx.restore();
          }
        }
        ctx.drawImage(bgCacheCanvas, 0, 0, boardPx, boardPx);
        ctx.save();
      } else {
        ctx.fillStyle = '#070A0F';
        ctx.fillRect(0, 0, boardPx, boardPx);
        ctx.save();
        ctx.translate(-camRef.current.x * cellPx, -camRef.current.y * cellPx);

        ctx.fillStyle = '#0E1522';
        for (let y = startY; y < endY; y++) {
          const isEdgeY = y === 0 || y === lastIdx;
          const py = y * cellPx + halfGap;
          for (let x = startX; x < endX; x++) {
            if (isEdgeY || x === 0 || x === lastIdx) continue;
            ctx.fillRect(x * cellPx + halfGap, py, socketSize, socketSize);
          }
        }

        ctx.fillStyle = '#131826';
        for (let y = startY; y < endY; y++) {
          const isEdgeY = y === 0 || y === lastIdx;
          const py = y * cellPx + halfGap;
          for (let x = startX; x < endX; x++) {
            if (isEdgeY || x === 0 || x === lastIdx) {
              ctx.fillRect(x * cellPx + halfGap, py, socketSize, socketSize);
            }
          }
        }

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 8; i < activeGridSize; i += 8) {
          const pos = i * cellPx;
          ctx.moveTo(pos, 0);
          ctx.lineTo(pos, worldPx);
          ctx.moveTo(0, pos);
          ctx.lineTo(worldPx, pos);
        }
        ctx.stroke();
      }

      if (snap) {
        const me = projectedMe;

        // 3. Render Nearby Rival Spawn Telegraphs (Flashing Radar Crosshairs on the grid)
        const pulseFast = Math.sin(now * 0.022) > 0;
        for (let tIdx = 0; tIdx < snap.telegraphs.length; tIdx++) {
          const tele = snap.telegraphs[tIdx];
          if (tele.x < startX - 1 || tele.x > endX || tele.y < startY - 1 || tele.y > endY) {
            continue;
          }
          const cx = (tele.x + 0.5) * cellPx;
          const cy = (tele.y + 0.5) * cellPx;

          ctx.strokeStyle = pulseFast ? '#F59E0B' : tele.color.head;
          ctx.lineWidth = 2;
          ctx.strokeRect(
            tele.x * cellPx - 2,
            tele.y * cellPx - 2,
            cellPx + 4,
            cellPx + 4
          );

          const rad = cellPx * (0.9 + 0.35 * Math.sin(now * 0.015));
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = '#FDE047';
          ctx.font = `700 ${Math.max(9, Math.floor(cellPx * 0.42))}px "IBM Plex Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(`SPAWN ${tele.ticksLeft}`, cx, tele.y * cellPx - 5);
        }

        // 4. Render BIG FLASHING PELLETS (Batched by color bucket to stay 60fps even at 4,096 pellets!)
        const pellets = snap.pellets;
        if (pellets.length > 0) {
          for (const arr of pelletBuckets.values()) {
            arr.length = 0;
          }
          pelletWhiteCores.length = 0;
          pelletHaloCoords.length = 0;

          const flashBase = (now / 85) | 0;
          const scalePulseBase = Math.sin(now * 0.018);
          const expand = cellPx * (0.1 + 0.08 * scalePulseBase);
          const framePad = expand * 0.5;
          const frameSize = cellPx + expand;
          const corePad = cellPx * 0.24;
          const coreSize = cellPx * 0.52;
          const drawHalos = pellets.length <= 360;

          for (let pIdx = 0; pIdx < pellets.length; pIdx++) {
            const pellet = pellets[pIdx];
            if (
              pellet.x < startX ||
              pellet.x >= endX ||
              pellet.y < startY ||
              pellet.y >= endY
            ) {
              continue;
            }
            const px = pellet.x * cellPx;
            const py = pellet.y * cellPx;
            const flashPhase = (flashBase + pellet.x * 3 + pellet.y * 5) % 3;
            const primaryColor =
              flashPhase === 0 ? '#FEF08A' : flashPhase === 1 ? '#F59E0B' : pellet.color;

            let bucket = pelletBuckets.get(primaryColor);
            if (!bucket) {
              bucket = [];
              pelletBuckets.set(primaryColor, bucket);
            }
            bucket.push(px, py);
            pelletWhiteCores.push(px, py);
            if (drawHalos) {
              pelletHaloCoords.push(px, py);
            }
          }

          if (drawHalos && pelletHaloCoords.length > 0) {
            const haloPad = expand * 1.4;
            const haloSize = cellPx + expand * 2.8;
            ctx.globalAlpha = 0.28;
            ctx.fillStyle = '#F59E0B';
            for (let i = 0; i < pelletHaloCoords.length; i += 2) {
              ctx.fillRect(
                pelletHaloCoords[i] - haloPad,
                pelletHaloCoords[i + 1] - haloPad,
                haloSize,
                haloSize
              );
            }
          }

          ctx.globalAlpha = 1;
          for (const [color, coords] of pelletBuckets.entries()) {
            if (coords.length === 0) continue;
            ctx.fillStyle = color;
            for (let i = 0; i < coords.length; i += 2) {
              ctx.fillRect(coords[i] - framePad, coords[i + 1] - framePad, frameSize, frameSize);
            }
          }

          if (pelletWhiteCores.length > 0) {
            ctx.fillStyle = '#FFFFFF';
            for (let i = 0; i < pelletWhiteCores.length; i += 2) {
              ctx.fillRect(
                pelletWhiteCores[i] + corePad,
                pelletWhiteCores[i + 1] + corePad,
                coreSize,
                coreSize
              );
            }
          }
        }

        // 4b. Render Collectible Loot Boxes (extensible crate visuals per ability)
        const lootBoxes = snap.lootBoxes || [];
        for (let bIdx = 0; bIdx < lootBoxes.length; bIdx++) {
          const box = lootBoxes[bIdx];
          if (box.x < startX || box.x >= endX || box.y < startY || box.y >= endY) {
            continue;
          }
          const def = LOOT_BOX_REGISTRY[box.ability];
          const bx = box.x * cellPx;
          const by = box.y * cellPx;
          const bob = Math.sin(now * 0.008 + box.x + box.y) * (cellPx * 0.06);
          const pulse = 0.72 + 0.28 * Math.sin(now * 0.012 + box.x * 2);

          // Soft emerald/ability aura
          ctx.globalAlpha = 0.26 * pulse;
          ctx.fillStyle = def.badgeColor;
          ctx.fillRect(
            bx - cellPx * 0.2,
            by - cellPx * 0.2 + bob,
            cellPx * 1.4,
            cellPx * 1.4
          );

          // Crate outer body
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#0B1320';
          ctx.fillRect(bx + halfGap, by + halfGap + bob, socketSize, socketSize);

          // Crisp colored crate border
          ctx.strokeStyle = def.badgeColor;
          ctx.lineWidth = Math.max(1.5, cellPx * 0.11);
          ctx.strokeRect(bx + halfGap, by + halfGap + bob, socketSize, socketSize);

          // Corner crate rivets
          const rivet = Math.max(1.5, socketSize * 0.16);
          ctx.fillStyle = def.accentColor;
          ctx.fillRect(bx + halfGap + 1, by + halfGap + bob + 1, rivet, rivet);
          ctx.fillRect(bx + halfGap + socketSize - rivet - 1, by + halfGap + bob + 1, rivet, rivet);
          ctx.fillRect(bx + halfGap + 1, by + halfGap + bob + socketSize - rivet - 1, rivet, rivet);
          ctx.fillRect(
            bx + halfGap + socketSize - rivet - 1,
            by + halfGap + bob + socketSize - rivet - 1,
            rivet,
            rivet
          );

          // Center '+' emblem for Extra Life / powerup crate
          const midX = bx + cellPx * 0.5;
          const midY = by + cellPx * 0.5 + bob;
          const barThick = Math.max(2, socketSize * 0.18);
          const barLen = socketSize * 0.52;
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(midX - barLen * 0.5, midY - barThick * 0.5, barLen, barThick);
          ctx.fillRect(midX - barThick * 0.5, midY - barLen * 0.5, barThick, barLen);

          // Mini overhead crate label
          ctx.font = `700 ${Math.max(8, Math.floor(cellPx * 0.36))}px "IBM Plex Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
          ctx.fillText(def.shortLabel, midX + 1, by + bob - 3);
          ctx.fillStyle = def.accentColor;
          ctx.fillText(def.shortLabel, midX, by + bob - 4);
        }

        // 5. Render All Snakes as Lit Colored Pixels on the Grid (Batched per-snake paths for 60fps at any length!)
        const orderedSnakes = snap.snakes
          .map((s) => (s.id === myId && projectedMe ? projectedMe : s))
          .sort((a, b) => (a.id === myId ? 1 : b.id === myId ? -1 : 0));

        const meBorderW = Math.max(1.1, cellPx * 0.065);
        const otherBorderW = Math.max(1, cellPx * 0.05);
        const headBorderW = Math.max(1.5, cellPx * 0.09);

        for (let sIdx = 0; sIdx < orderedSnakes.length; sIdx++) {
          const snake = orderedSnakes[sIdx];
          if (!snake.alive) continue;
          const isMe = snake.id === myId;
          const segs = snake.segments;
          const len = segs.length;
          const denom = Math.max(1, len - 1);
          const isShielded = (snake.shieldTicks || 0) > 0;
          const shieldBlink = isShielded ? 0.62 + 0.38 * Math.sin(now * 0.028) : 1;

          // Clear spatial deduplication bitmap & reusable segment arrays
          visitedCells.fill(0);
          bodyBaseXs.length = 0;
          bodyBaseYs.length = 0;
          bodyTailXs.length = 0;
          bodyTailYs.length = 0;
          bodyRimXs.length = 0;
          bodyRimYs.length = 0;

          let hasHead = false;
          let headSx = 0;
          let headSy = 0;

          for (let i = 0; i < len; i++) {
            const seg = segs[i];
            const gx = seg.x;
            const gy = seg.y;
            if (gx < startX || gx >= endX || gy < startY || gy >= endY) continue;

            const cellBitIdx = (gy << 6) | gx;
            if (visitedCells[cellBitIdx] === 1) continue;
            visitedCells[cellBitIdx] = 1;

            const sx = gx * cellPx + halfGap;
            const sy = gy * cellPx + halfGap;

            if (i === 0) {
              hasHead = true;
              headSx = sx;
              headSy = sy;
            } else {
              const ratio = i / denom;
              if (ratio > 0.72) {
                bodyTailXs.push(sx);
                bodyTailYs.push(sy);
              } else {
                bodyBaseXs.push(sx);
                bodyBaseYs.push(sy);
              }
              bodyRimXs.push(sx);
              bodyRimYs.push(sy);
            }
          }

          // Batched Body Squares Pass 1: Main Body Color
          if (bodyBaseXs.length > 0) {
            ctx.globalAlpha = shieldBlink;
            ctx.fillStyle = snake.color.body;
            for (let b = 0; b < bodyBaseXs.length; b++) {
              ctx.fillRect(bodyBaseXs[b], bodyBaseYs[b], socketSize, socketSize);
            }
          }

          // Batched Body Squares Pass 2: Tail Accent Color
          if (bodyTailXs.length > 0) {
            ctx.globalAlpha = shieldBlink;
            ctx.fillStyle = snake.color.tail;
            for (let b = 0; b < bodyTailXs.length; b++) {
              ctx.fillRect(bodyTailXs[b], bodyTailYs[b], socketSize, socketSize);
            }
          }

          // Batched Body Squares Pass 3: Single-Path Rim/Bezel + Inner Highlights
          if (bodyRimXs.length > 0) {
            ctx.globalAlpha = shieldBlink;
            if (isMe) {
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
              ctx.lineWidth = meBorderW;
              ctx.beginPath();
              for (let b = 0; b < bodyRimXs.length; b++) {
                ctx.rect(bodyRimXs[b] + 0.75, bodyRimYs[b] + 0.75, socketSize - 1.5, socketSize - 1.5);
              }
              ctx.stroke();

              const dRadius = socketSize * 0.25;
              const halfSoc = socketSize * 0.5;
              ctx.fillStyle = '#FFFFFF';
              ctx.globalAlpha = 0.82 * shieldBlink;
              ctx.beginPath();
              for (let b = 0; b < bodyRimXs.length; b++) {
                const cx = bodyRimXs[b] + halfSoc;
                const cy = bodyRimYs[b] + halfSoc;
                ctx.moveTo(cx, cy - dRadius);
                ctx.lineTo(cx + dRadius, cy);
                ctx.lineTo(cx, cy + dRadius);
                ctx.lineTo(cx - dRadius, cy);
                ctx.closePath();
              }
              ctx.fill();
            } else {
              ctx.strokeStyle = 'rgba(8, 11, 16, 0.7)';
              ctx.lineWidth = otherBorderW;
              ctx.beginPath();
              for (let b = 0; b < bodyRimXs.length; b++) {
                ctx.rect(bodyRimXs[b] + 0.5, bodyRimYs[b] + 0.5, socketSize - 1, socketSize - 1);
              }
              ctx.stroke();

              ctx.fillStyle = snake.color.head;
              ctx.globalAlpha = 0.3 * shieldBlink;
              const inOff = socketSize * 0.3;
              const inSize = socketSize * 0.4;
              for (let b = 0; b < bodyRimXs.length; b++) {
                ctx.fillRect(bodyRimXs[b] + inOff, bodyRimYs[b] + inOff, inSize, inSize);
              }
            }

            if (isShielded) {
              ctx.globalAlpha = shieldBlink;
              ctx.strokeStyle = '#38BDF8';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              for (let b = 0; b < bodyRimXs.length; b++) {
                ctx.rect(bodyRimXs[b] - 1, bodyRimYs[b] - 1, socketSize + 2, socketSize + 2);
              }
              ctx.stroke();
            }
          }

          // Render Head Pixel on Top
          if (hasHead) {
            if (isShielded) {
              ctx.globalAlpha = shieldBlink;
              ctx.strokeStyle = '#38BDF8';
              ctx.lineWidth = 1.5;
              ctx.strokeRect(headSx - 1, headSy - 1, socketSize + 2, socketSize + 2);
            }

            ctx.globalAlpha = (isMe ? 0.32 : 0.22) * shieldBlink;
            ctx.fillStyle = isShielded ? '#38BDF8' : isMe ? '#FFFFFF' : snake.color.head;
            ctx.fillRect(headSx - 2.5, headSy - 2.5, socketSize + 5, socketSize + 5);

            ctx.globalAlpha = shieldBlink;
            ctx.fillStyle = snake.color.head;
            ctx.fillRect(headSx, headSy, socketSize, socketSize);

            const customFaceImg = snake.faceId ? getFaceImage(snake.faceId) : null;
            if (customFaceImg) {
              const prevSmoothing = ctx.imageSmoothingEnabled;
              ctx.imageSmoothingEnabled = customFaceImg.naturalWidth > 64;
              ctx.drawImage(customFaceImg, headSx, headSy, socketSize, socketSize);
              ctx.imageSmoothingEnabled = prevSmoothing;
            } else {
              // Directional pixel eyes on the head cell
              ctx.fillStyle = '#080B10';
              const eyeSize = Math.max(2, socketSize * 0.22);
              let e1x = headSx + socketSize * 0.22;
              let e1y = headSy + socketSize * 0.22;
              let e2x = headSx + socketSize * 0.62;
              let e2y = headSy + socketSize * 0.22;

              if (snake.dir === 'DOWN') {
                e1y = headSy + socketSize * 0.62;
                e2y = headSy + socketSize * 0.62;
              } else if (snake.dir === 'LEFT') {
                e1x = headSx + socketSize * 0.2;
                e1y = headSy + socketSize * 0.22;
                e2x = headSx + socketSize * 0.2;
                e2y = headSy + socketSize * 0.62;
              } else if (snake.dir === 'RIGHT') {
                e1x = headSx + socketSize * 0.64;
                e1y = headSy + socketSize * 0.22;
                e2x = headSx + socketSize * 0.64;
                e2y = headSy + socketSize * 0.62;
              }
              ctx.fillRect(e1x, e1y, eyeSize, eyeSize);
              ctx.fillRect(e2x, e2y, eyeSize, eyeSize);

              if (isMe) {
                ctx.fillStyle = '#FFFFFF';
                const glint = Math.max(1, eyeSize * 0.42);
                ctx.fillRect(e1x + eyeSize * 0.15, e1y + eyeSize * 0.15, glint, glint);
                ctx.fillRect(e2x + eyeSize * 0.15, e2y + eyeSize * 0.15, glint, glint);
              }
            }

            if (isMe) {
              ctx.strokeStyle = '#FFFFFF';
              ctx.lineWidth = headBorderW;
              ctx.strokeRect(headSx + 0.75, headSy + 0.75, socketSize - 1.5, socketSize - 1.5);
            } else if (isShielded) {
              ctx.strokeStyle = '#E0F2FE';
              ctx.lineWidth = 1.5;
              ctx.strokeRect(headSx + 1, headSy + 1, socketSize - 2, socketSize - 2);
            }
          }
          ctx.globalAlpha = 1;

          // Floating Callsign & Fail-Safe Shield Timer readout above snake head
          const head = segs[0];
          if (head && head.x >= startX && head.x < endX && head.y >= startY && head.y < endY) {
            const hx = (head.x + 0.5) * cellPx;
            const hy = head.y * cellPx - 4;
            ctx.font = `${isMe ? '700' : '600'} ${Math.max(9, Math.floor(cellPx * 0.42))}px "IBM Plex Mono", monospace`;
            ctx.textAlign = 'center';
            const shieldSec = ((snake.shieldTicks * TICK_MS) / 1000).toFixed(1);
            const lifeTag = (snake.extraLives || 0) > 0 ? ` [+${snake.extraLives} LIFE]` : '';
            const label = isShielded
              ? `${isMe ? '★ ' : ''}${snake.name} [SAFE ${shieldSec}s]${lifeTag}`
              : `${isMe ? '★ ' : ''}${snake.name}${lifeTag}`;
            const textY = Math.max(11, hy);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.fillText(label, hx + 1, textY + 1);
            ctx.fillStyle = isShielded
              ? '#7DD3FC'
              : (snake.extraLives || 0) > 0
                ? '#6EE7B7'
                : isMe
                  ? '#FFFFFF'
                  : 'rgba(241, 245, 249, 0.85)';
            ctx.fillText(label, hx, textY);
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
        ctx.strokeRect(1, 1, worldPx - 2, worldPx - 2);
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
      ctx.restore();
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [serverGridSize]);

  const deathExplanation = (() => {
    switch (hudStats.deathReason) {
      case 'WALL_CRASH':
        return 'You ran off the unforgiving outer grid border.';
      case 'SELF_CRASH':
        return 'You went over top of your own lit pixel trail.';
      case 'KILLED_BY_SNAKE':
        return `You ran into ${hudStats.killedByName || 'a rival snake'} and burst into flashing big pellets.`;
      case 'HEAD_COLLISION':
        return `Eliminated in a head-to-head collision with ${hudStats.killedByName || 'a rival snake'}.`;
      default:
        return 'Your snake shattered into big flashing pellets on the pixel grid.';
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
            {hudStats.extraLives > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-emerald-300 font-semibold">
                  EXTRA LIFE ×{hudStats.extraLives}
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
          {gameState === 'PLAYING' && (
            <button
              type="button"
              onClick={() => setShowTradeModal((prev) => !prev)}
              className={`relative px-2.5 py-1 text-xs font-semibold rounded border transition-colors whitespace-nowrap cursor-pointer flex items-center gap-1.5 ${
                showTradeModal || incomingTrades.length > 0
                  ? 'bg-emerald-500/25 border-emerald-400 text-emerald-200'
                  : 'bg-slate-800/80 hover:bg-slate-700/80 text-emerald-300 border-emerald-500/40'
              }`}
              title="Give or trade Extra Lives with other players (Shortcut: T)"
            >
              <span>Trade Lives [T]</span>
              {hudStats.extraLives > 0 && (
                <span className="px-1 rounded bg-emerald-400/20 text-emerald-200 font-mono-tabular text-[10px]">
                  ×{hudStats.extraLives}
                </span>
              )}
              {incomingTrades.length > 0 && (
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              )}
            </button>
          )}
          {isAdminName && (
            <button
              type="button"
              onClick={openAdminModal}
              className="px-2.5 py-1 text-xs font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-400/60 rounded transition-colors whitespace-nowrap cursor-pointer"
            >
              Admin Menu
            </button>
          )}
          {gameState === 'TITLE_MENU' && (
            <button
              type="button"
              onClick={handleToggleSpectatorMode}
              className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap cursor-pointer ${
                isSpectating
                  ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-300'
                  : 'bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border-slate-700'
              }`}
              title="Hide or show the main menu to spectate the live arena"
            >
              {isSpectating ? 'Show Main Menu' : 'Spectate (Hide Menu)'}
            </button>
          )}
          <button
            type="button"
            onClick={handleToggleMobileControls}
            className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap cursor-pointer ${
              mobileControlsEnabled
                ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-300'
                : 'bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border-slate-700'
            }`}
            title="Enable or disable on-screen mobile directional controls"
          >
            {mobileControlsEnabled ? 'Mobile: On' : 'Mobile: Off'}
          </button>
          <button
            type="button"
            onClick={handleToggleZoom}
            className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap cursor-pointer ${
              zoomIn16
                ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-300'
                : 'bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border-slate-700'
            }`}
            title="Toggle 16-square Zoom In view (Shortcut: Z)"
          >
            {zoomIn16 ? 'Zoom: 16×16 [Z]' : 'Zoom: Full [Z]'}
          </button>
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

              {gameState === 'PLAYING' && autoPilotActive && !showAdminModal && (
                <div
                  className={`absolute top-5 left-1/2 -translate-x-1/2 z-10 pointer-events-none px-3.5 py-1.5 rounded-lg bg-[#080B10]/90 shadow-lg flex items-center gap-2 whitespace-nowrap border ${
                    isSuperAdminRy ? 'border-amber-400/80' : 'border-emerald-400/70'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full animate-pulse ${
                      isSuperAdminRy ? 'bg-amber-400' : 'bg-emerald-400'
                    }`}
                  />
                  <span
                    className={`text-[11px] font-mono-tabular font-bold tracking-wide ${
                      isSuperAdminRy ? 'text-amber-300' : 'text-emerald-300'
                    }`}
                  >
                    {isSuperAdminRy
                      ? 'ADMINRY APEX AI ACTIVE · PRESS ANY DIRECTION TO DRIVE'
                      : 'AI AUTOPILOT ACTIVE · PRESS ANY DIRECTION TO DRIVE'}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Right Perimeter Sidebar: Live Leaderboard, Kill Feed & Tactical Rules (Desktop) */}
          <aside className="hidden xl:flex flex-col justify-between w-72 h-full max-h-[calc(100vh-6.2rem)] py-1 shrink-0 pointer-events-none">
            <div className="space-y-4">
              {/* Arena Leaderboard */}
              <div className="p-4 rounded-lg bg-[#0D131F]/90 border border-slate-800/80">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xs font-semibold tracking-wider text-slate-300 font-display">
                    ARENA LEADERS
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
                cross over your own tail, but hitting a rival trail or stepping off the outer grid
                border is instant death.
              </p>
              <p className="pt-1 text-[11px] font-mono-tabular text-slate-300">
                Controls: WASD, Arrow Keys, or Mobile Controls
              </p>
            </div>
          </aside>
        </div>

        {/* ON-SCREEN MOBILE CONTROLS D-PAD OVERLAY */}
        {mobileControlsEnabled && gameState === 'PLAYING' && (
          <div
            className="fixed bottom-5 right-5 z-20 select-none touch-none"
            aria-label="Mobile Directional Controls"
          >
            <div className="p-2.5 rounded-2xl bg-[#0B111D]/85 border border-slate-700/80 backdrop-blur-md shadow-[0_8px_32px_rgba(0,0,0,0.65)]">
              <div className="grid grid-cols-3 gap-2 w-40 h-40 sm:w-44 sm:h-44">
                <div />
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleMobileTurn('UP');
                  }}
                  aria-label="Turn Up"
                  className="flex items-center justify-center rounded-xl bg-slate-800/90 active:bg-emerald-500/40 hover:bg-slate-700/90 border border-slate-600/80 active:border-emerald-400 text-white shadow-inner transition-colors cursor-pointer touch-none select-none"
                >
                  <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 5l7 9H5l7-9z" />
                  </svg>
                </button>
                <div />

                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleMobileTurn('LEFT');
                  }}
                  aria-label="Turn Left"
                  className="flex items-center justify-center rounded-xl bg-slate-800/90 active:bg-emerald-500/40 hover:bg-slate-700/90 border border-slate-600/80 active:border-emerald-400 text-white shadow-inner transition-colors cursor-pointer touch-none select-none"
                >
                  <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M5 12l9-7v14l-9-7z" />
                  </svg>
                </button>

                <div className="flex items-center justify-center rounded-xl bg-[#070A0F]/80 border border-slate-800/90">
                  <div className="w-2.5 h-2.5 rounded-xs bg-emerald-400/70" />
                </div>

                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleMobileTurn('RIGHT');
                  }}
                  aria-label="Turn Right"
                  className="flex items-center justify-center rounded-xl bg-slate-800/90 active:bg-emerald-500/40 hover:bg-slate-700/90 border border-slate-600/80 active:border-emerald-400 text-white shadow-inner transition-colors cursor-pointer touch-none select-none"
                >
                  <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 12l-9 7V5l9 7z" />
                  </svg>
                </button>

                <div />
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleMobileTurn('DOWN');
                  }}
                  aria-label="Turn Down"
                  className="flex items-center justify-center rounded-xl bg-slate-800/90 active:bg-emerald-500/40 hover:bg-slate-700/90 border border-slate-600/80 active:border-emerald-400 text-white shadow-inner transition-colors cursor-pointer touch-none select-none"
                >
                  <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 19l-7-9h14l-7 9z" />
                  </svg>
                </button>
                <div />
              </div>
            </div>
          </div>
        )}

        {/* SPECTATOR MODE FLOATING HUD BAR (WHEN MAIN MENU IS HIDDEN) */}
        {gameState === 'TITLE_MENU' && isSpectating && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-20 flex flex-wrap items-center justify-center gap-3 px-4 py-2.5 rounded-xl bg-[#0D131F]/95 border border-cyan-500/40 shadow-[0_8px_32px_rgba(0,0,0,0.75)] backdrop-blur-md">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              <span className="font-display font-bold text-xs tracking-wider text-cyan-300">
                SPECTATOR MODE
              </span>
            </div>

            <span className="text-slate-700" aria-hidden="true">
              |
            </span>

            {zoomIn16 && spectatedSnakeInfo ? (
              <div className="flex items-center gap-2 text-xs font-mono-tabular">
                <span className="text-slate-400">WATCHING:</span>
                <span
                  className="w-2.5 h-2.5 rounded-xs shrink-0"
                  style={{ backgroundColor: spectatedSnakeInfo.color }}
                />
                <span className="font-bold text-white">{spectatedSnakeInfo.name}</span>
                <span className="text-[10px] text-slate-400">
                  ({spectatedSnakeInfo.length}px · {spectatedSnakeInfo.score} pts)
                </span>
              </div>
            ) : (
              <span className="text-xs font-mono-tabular text-slate-300">
                Full Grid View · Press Zoom [Z] to follow a random snake
              </span>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleToggleZoom}
                className={`px-3 py-1 rounded-lg border text-xs font-mono-tabular font-semibold transition-colors cursor-pointer ${
                  zoomIn16
                    ? 'bg-emerald-500/20 border-emerald-400/70 text-emerald-300 hover:bg-emerald-500/30'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-slate-200'
                }`}
              >
                {zoomIn16 ? 'Zoom: 16×16 [Z]' : 'Zoom Random Snake [Z]'}
              </button>
              <button
                type="button"
                onClick={() => setIsSpectating(false)}
                className="px-3 py-1 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-display font-bold text-xs tracking-wide transition-colors cursor-pointer"
              >
                Show Main Menu [Esc]
              </button>
            </div>
          </div>
        )}

        {/* TITLE SCREEN OVERLAY */}
        {gameState === 'TITLE_MENU' && !isSpectating && (
          <div className="absolute inset-0 z-30 bg-[#080B10]/80 flex items-center justify-center p-4">
            <div className="w-full max-w-xl max-h-[92vh] overflow-y-auto face-tray-scroll rounded-xl bg-[#0D131F] border border-slate-700/80 shadow-2xl p-5 sm:p-7 space-y-5">
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
                    Rivals spawn nearby on the pixel grid. Bait them into running into your lit pixel trail.
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-[#080B10] border border-slate-800">
                  <div className="font-semibold text-amber-400 mb-1">2. Slurp Big Pellets</div>
                  <p className="text-slate-400 leading-relaxed">
                    No passive little dots. Killed snakes drop <strong className="text-amber-200">flashing big pellets</strong>—slurp them before rivals do!
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-[#080B10] border border-slate-800">
                  <div className="font-semibold text-rose-400 mb-1">3. Unforgiving Border</div>
                  <p className="text-slate-400 leading-relaxed">
                    You can cross your own tail safely, but hitting rivals or stepping 1 pixel off the outer border is fatal.
                  </p>
                </div>
              </div>

              {/* Player Name & Pixel Color Customizer */}
              <div className="space-y-4 pt-1">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label
                      htmlFor="callsign-input"
                      className="block text-xs font-medium text-slate-300"
                    >
                      NAME
                    </label>
                    {isAdminName && (
                      <button
                        type="button"
                        onClick={openAdminModal}
                        className="px-3 py-1 rounded-md bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-xs tracking-wide transition-colors cursor-pointer shadow-sm"
                      >
                        ADMIN MENU
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="callsign-input"
                      type="text"
                      maxLength={24}
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value.toUpperCase())}
                      placeholder="VIPER_01"
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#080B10] border border-slate-700 text-white font-mono-tabular text-sm uppercase focus:outline-none focus:border-emerald-400"
                    />
                    {isAdminName && (
                      <button
                        type="button"
                        onClick={openAdminModal}
                        className="shrink-0 px-4 py-2.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/70 text-amber-300 font-display font-bold text-xs tracking-wider transition-colors cursor-pointer"
                      >
                        OPEN ADMIN MENU
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="block text-xs font-medium text-slate-300">
                      SNAKE BODY COLOR
                    </span>
                    {(() => {
                      const previewBody =
                        SNAKE_PALETTES.find((p) => p.id === selectedColorId) || SNAKE_PALETTES[0];
                      const previewFace = getFaceById(selectedFaceId);
                      return (
                        <div className="flex items-center gap-1.5 text-[11px] font-mono-tabular text-slate-400">
                          <span>MIX:</span>
                          <div className="flex items-center gap-0.5 p-1 rounded bg-[#080B10] border border-slate-800">
                            <span
                              className="w-3.5 h-3.5 rounded-xs"
                              style={{ backgroundColor: previewBody.tail }}
                            />
                            <span
                              className="w-3.5 h-3.5 rounded-xs"
                              style={{ backgroundColor: previewBody.body }}
                            />
                            <span
                              className="w-3.5 h-3.5 rounded-xs"
                              style={{ backgroundColor: previewBody.body }}
                            />
                            <span
                              className="relative w-4 h-4 rounded-xs overflow-hidden flex items-center justify-center border border-white/80"
                              style={{ backgroundColor: previewBody.head }}
                            >
                              {previewFace ? (
                                <img
                                  src={previewFace.url}
                                  alt={previewFace.label}
                                  className="w-full h-full object-contain [image-rendering:pixelated]"
                                />
                              ) : (
                                <span className="flex flex-col gap-0.5 translate-x-0.5">
                                  <span className="w-1 h-1 bg-[#080B10] block" />
                                  <span className="w-1 h-1 bg-[#080B10] block" />
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
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

                {/* Scrollable PNG Face Picker (auto-discovers *.png from src/faces/) */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="block text-xs font-medium text-slate-300">
                      SNAKE FACE · <span className="font-mono-tabular text-emerald-400">src/faces/*.png</span>
                    </span>
                    <span className="text-[11px] font-mono-tabular text-slate-400">
                      {DISCOVERED_SNAKE_FACES.length} PNG{DISCOVERED_SNAKE_FACES.length === 1 ? '' : 's'} · SCROLL
                    </span>
                  </div>
                  {(() => {
                    const activeBodyPalette =
                      SNAKE_PALETTES.find((p) => p.id === selectedColorId) || SNAKE_PALETTES[0];
                    return (
                      <div className="grid grid-cols-4 sm:grid-cols-5 gap-2 h-24 overflow-y-scroll pr-1.5 p-2 rounded-lg bg-[#080B10] border border-slate-800 face-tray-scroll">
                        <button
                          type="button"
                          onClick={() => handleSelectFace('default')}
                          className={`flex flex-col items-center justify-center gap-1 p-1.5 rounded-md border transition-all cursor-pointer ${
                            selectedFaceId === 'default'
                              ? 'bg-slate-800/90 border-white text-white shadow-sm'
                              : 'bg-[#0D131F] border-slate-800 text-slate-400 hover:border-slate-600'
                          }`}
                          title="Default pixel eyes"
                        >
                          <div
                            className="w-7 h-7 rounded-xs flex items-center justify-center border border-black/30"
                            style={{ backgroundColor: activeBodyPalette.head }}
                          >
                            <div className="flex flex-col gap-1 translate-x-1">
                              <span className="w-1.5 h-1.5 bg-[#080B10] block" />
                              <span className="w-1.5 h-1.5 bg-[#080B10] block" />
                            </div>
                          </div>
                          <span className="text-[10px] truncate w-full text-center font-mono-tabular">
                            Classic
                          </span>
                        </button>

                        {DISCOVERED_SNAKE_FACES.map((face) => {
                          const active = selectedFaceId === face.id;
                          return (
                            <button
                              key={face.id}
                              type="button"
                              onClick={() => handleSelectFace(face.id)}
                              className={`flex flex-col items-center justify-center gap-1 p-1.5 rounded-md border transition-all cursor-pointer ${
                                active
                                  ? 'bg-slate-800/90 border-white text-white shadow-sm'
                                  : 'bg-[#0D131F] border-slate-800 text-slate-400 hover:border-slate-600'
                              }`}
                              title={`${face.filename} (src/faces/${face.id})`}
                            >
                              <div
                                className="w-7 h-7 rounded-xs overflow-hidden flex items-center justify-center border border-black/30"
                                style={{ backgroundColor: activeBodyPalette.head }}
                              >
                                <img
                                  src={face.url}
                                  alt={face.label}
                                  className="w-full h-full object-contain [image-rendering:pixelated]"
                                />
                              </div>
                              <span className="text-[10px] truncate w-full text-center font-mono-tabular">
                                {face.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <span className="block text-xs font-medium text-slate-300 mb-2">
                      ARENA SERVER
                    </span>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setServerGridSize(32)}
                        className={`py-2 px-2 rounded-lg border text-xs font-mono-tabular font-semibold transition-all cursor-pointer ${
                          serverGridSize === 32
                            ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                            : 'bg-[#080B10] border-slate-800 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        32×32
                      </button>
                      <button
                        type="button"
                        onClick={() => setServerGridSize(64)}
                        className={`py-2 px-2 rounded-lg border text-xs font-mono-tabular font-semibold transition-all cursor-pointer ${
                          serverGridSize === 64
                            ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                            : 'bg-[#080B10] border-slate-800 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        64×64
                      </button>
                    </div>
                  </div>

                  <div>
                    <span className="block text-xs font-medium text-slate-300 mb-2">
                      CAMERA VIEW
                    </span>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setZoomIn16(false)}
                        className={`py-2 px-2 rounded-lg border text-xs font-mono-tabular font-semibold transition-all cursor-pointer ${
                          !zoomIn16
                            ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                            : 'bg-[#080B10] border-slate-800 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        FULL
                      </button>
                      <button
                        type="button"
                        onClick={() => setZoomIn16(true)}
                        className={`py-2 px-2 rounded-lg border text-xs font-mono-tabular font-semibold transition-all cursor-pointer ${
                          zoomIn16
                            ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                            : 'bg-[#080B10] border-slate-800 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        16×16
                      </button>
                    </div>
                  </div>

                  <div>
                    <span className="block text-xs font-medium text-slate-300 mb-2">
                      MOBILE CONTROLS
                    </span>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          if (mobileControlsEnabled) handleToggleMobileControls();
                        }}
                        className={`py-2 px-2 rounded-lg border text-xs font-mono-tabular font-semibold transition-all cursor-pointer ${
                          !mobileControlsEnabled
                            ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                            : 'bg-[#080B10] border-slate-800 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        OFF
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!mobileControlsEnabled) handleToggleMobileControls();
                        }}
                        className={`py-2 px-2 rounded-lg border text-xs font-mono-tabular font-semibold transition-all cursor-pointer ${
                          mobileControlsEnabled
                            ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                            : 'bg-[#080B10] border-slate-800 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        ON
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Primary Start CTA & Spectator Mode Button */}
              <div className="space-y-2.5 pt-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <button
                    type="button"
                    onClick={handleStartOrRespawn}
                    className="sm:col-span-2 py-3.5 px-6 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-display font-bold text-base tracking-wide transition-colors cursor-pointer shadow-lg shadow-emerald-500/20"
                  >
                    Drop Into {serverGridSize}×{serverGridSize} Grid [Enter]
                  </button>
                  <button
                    type="button"
                    onClick={handleToggleSpectatorMode}
                    className="py-3.5 px-4 rounded-lg bg-slate-800/90 hover:bg-slate-700/90 border border-cyan-500/40 text-cyan-300 font-display font-semibold text-xs sm:text-sm tracking-wide transition-colors cursor-pointer"
                  >
                    Spectate (Hide Menu)
                  </button>
                </div>
                <p className="text-center text-xs text-slate-400 font-mono-tabular">
                  WASD / Arrow Keys Move · Z Toggle 16×16 Zoom · M Mute · Esc Pause
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
                <strong className="text-slate-200">Arrow Keys</strong> to steer your pixel snake
                across the arena grid.
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
                  SIGNAL TERMINATED IN ARENA
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
                  onClick={handleToggleSpectatorMode}
                  className="py-3 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 border border-cyan-500/40 text-cyan-300 font-medium text-sm transition-colors cursor-pointer"
                >
                  Spectate
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsSpectating(false);
                    setGameState('TITLE_MENU');
                  }}
                  className="py-3 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-sm transition-colors cursor-pointer"
                >
                  Main Menu
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ADMIN AUDIO PLAYLIST MENU MODAL */}
        {showAdminModal && (
          <div className="absolute inset-0 z-40 bg-[#080B10]/85 flex items-center justify-center p-4">
            <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl bg-[#0D131F] border border-amber-500/50 shadow-2xl overflow-hidden">
              {/* Modal Header */}
              <div className="px-6 py-4 bg-[#090D16] border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] font-mono-tabular text-amber-400 font-semibold">
                    ADMIN AUDIO CONSOLE · FOLDER: src/audio/
                  </div>
                  <h2 className="font-display text-xl font-bold text-white">
                    SHUFFLED GAME AUDIO PLAYLISTS
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {gameState === 'PLAYING' && isAdminName && (
                    <button
                      type="button"
                      onClick={() => closeAdminModal(true)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold cursor-pointer transition-colors"
                      title="Close the Admin Menu while AI Autopilot continues steering until you press a direction"
                    >
                      Close & Keep Autopilot
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => closeAdminModal(false)}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold cursor-pointer"
                  >
                    Close
                  </button>
                </div>
              </div>

              {/* Modal Body */}
              <div className="p-6 overflow-y-auto space-y-5 text-xs">
                {/* Super-Admin ADMINRY Section: Kick Anyone Off Admin (Session-Only, Not Stored on Server) */}
                {isSuperAdminRy && (
                  <div className="p-4 rounded-lg bg-[#080B10] border border-rose-500/50 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-1 max-w-md">
                        <div className="flex items-center gap-2">
                          <span className="font-display font-semibold text-rose-300 tracking-wide">
                            ADMINRY OVERRIDE · KICK OFF ADMIN
                          </span>
                          <span className="px-2 py-0.5 rounded bg-rose-500/20 border border-rose-400/50 text-rose-200 font-mono-tabular text-[10px] font-bold">
                            SESSION ONLY
                          </span>
                        </div>
                        <p className="text-slate-400 leading-relaxed text-[11px]">
                          Revoke admin access for any connected player right now. Nothing is stored
                          on the server—reloading the page restores normal access.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleKickOffAdmin('*', 'all other admins')}
                        className="px-3.5 py-2 rounded-lg bg-rose-500 hover:bg-rose-400 text-slate-950 font-mono-tabular font-bold text-xs transition-colors cursor-pointer shrink-0"
                      >
                        Kick All Other Admins
                      </button>
                    </div>

                    {kickFeedbackMsg && (
                      <div className="px-3 py-2 rounded bg-rose-500/15 border border-rose-400/40 text-rose-200 font-mono-tabular text-[11px]">
                        {kickFeedbackMsg}
                      </div>
                    )}

                    <div className="pt-2 border-t border-slate-800/80 space-y-2">
                      <div className="text-[11px] font-mono-tabular text-slate-400">
                        CONNECTED PLAYERS ({hudStats.humanPlayers.length} OTHER HUMAN
                        {hudStats.humanPlayers.length === 1 ? '' : 'S'})
                      </div>
                      {hudStats.humanPlayers.length === 0 ? (
                        <div className="text-[11px] text-slate-500 py-1">
                          No other spawned players detected right now. Use &ldquo;Kick All Other
                          Admins&rdquo; above to also kick anyone sitting on the menu.
                        </div>
                      ) : (
                        <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                          {hudStats.humanPlayers.map((p) => {
                            const looksAdmin = p.name.trim().toUpperCase().startsWith('ADMIN');
                            return (
                              <div
                                key={p.id}
                                className="flex items-center justify-between gap-2 px-3 py-2 rounded bg-[#0D131F] border border-slate-800"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    className="w-2.5 h-2.5 rounded-xs shrink-0"
                                    style={{ backgroundColor: p.color }}
                                  />
                                  <span className="font-mono-tabular font-semibold text-slate-200 truncate">
                                    {p.name}
                                  </span>
                                  {looksAdmin && (
                                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-400/50 text-amber-300 font-mono-tabular text-[10px] font-bold shrink-0">
                                      ADMIN
                                    </span>
                                  )}
                                  {p.autoPilot && (
                                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 font-mono-tabular text-[10px] shrink-0">
                                      AI
                                    </span>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleKickOffAdmin(p.id, p.name)}
                                  className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/35 border border-rose-400/60 text-rose-200 font-mono-tabular font-semibold text-[11px] transition-colors cursor-pointer shrink-0"
                                >
                                  Kick Off Admin
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Super-Admin ADMINRY Fun Tool: Full-Screen Pellet Flood */}
                {isSuperAdminRy && (
                  <div className="p-4 rounded-lg bg-[#080B10] border border-amber-400/60 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-1 max-w-md">
                        <div className="flex items-center gap-2">
                          <span className="font-display font-semibold text-amber-300 tracking-wide">
                            ADMINRY FUN TOOL · FULL-SCREEN PELLET FLOOD
                          </span>
                          <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/50 text-amber-200 font-mono-tabular text-[10px] font-bold">
                            ADMINRY ONLY
                          </span>
                        </div>
                        <p className="text-slate-400 leading-relaxed text-[11px]">
                          Blanket every open tile across the entire arena with rainbow flashing big
                          pellets! Active pellets on grid:{' '}
                          <span className="text-amber-300 font-mono-tabular font-semibold">
                            {hudStats.bigPelletsOnGrid.toLocaleString()}
                          </span>
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleAdminRyPelletFlood('FLOOD_SCREEN')}
                          className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-mono-tabular font-bold text-xs transition-colors cursor-pointer"
                        >
                          Flood Entire Screen
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAdminRyPelletFlood('CLEAR')}
                          className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-mono-tabular font-semibold text-xs transition-colors cursor-pointer"
                        >
                          Clear Pellets
                        </button>
                      </div>
                    </div>

                    {pelletFloodFeedback && (
                      <div className="px-3 py-2 rounded bg-amber-500/15 border border-amber-400/50 text-amber-200 font-mono-tabular text-[11px] font-semibold">
                        {pelletFloodFeedback}
                      </div>
                    )}
                  </div>
                )}

                {/* Super-Admin ADMINRY Debug Tool: Give Extra Lives */}
                {isSuperAdminRy && (
                  <div className="p-4 rounded-lg bg-[#080B10] border border-emerald-400/50 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-1 max-w-md">
                        <div className="flex items-center gap-2">
                          <span className="font-display font-semibold text-emerald-300 tracking-wide">
                            ADMINRY DEBUG · GIVE EXTRA LIVES
                          </span>
                          <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/50 text-emerald-200 font-mono-tabular text-[10px] font-bold">
                            ADMINRY ONLY
                          </span>
                        </div>
                        <p className="text-slate-400 leading-relaxed text-[11px]">
                          Grant Extra Lives for testing phase-through saves or trading. Your Extra
                          Lives:{' '}
                          <span className="text-emerald-300 font-mono-tabular font-bold">
                            ×{hudStats.extraLives}
                          </span>
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleAdminRyGiveLives('ME', 1, 'yourself')}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono-tabular font-bold text-xs transition-colors cursor-pointer"
                        >
                          +1 Life (Me)
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAdminRyGiveLives('ME', 5, 'yourself')}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400/60 text-emerald-200 font-mono-tabular font-bold text-xs transition-colors cursor-pointer"
                        >
                          +5 Lives (Me)
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAdminRyGiveLives('*', 1, 'all alive players')}
                          className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/35 border border-cyan-400/60 text-cyan-200 font-mono-tabular font-semibold text-xs transition-colors cursor-pointer"
                        >
                          +1 Life (All)
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAdminRyGiveLives('ME', -999, 'yourself')}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-mono-tabular text-xs transition-colors cursor-pointer"
                        >
                          Reset Mine
                        </button>
                      </div>
                    </div>

                    {debugLivesFeedback && (
                      <div className="px-3 py-2 rounded bg-emerald-500/15 border border-emerald-400/50 text-emerald-200 font-mono-tabular text-[11px] font-semibold">
                        {debugLivesFeedback}
                      </div>
                    )}

                    {hudStats.humanPlayers.some((p) => p.alive) && (
                      <div className="pt-2 border-t border-slate-800/80 space-y-1.5">
                        <div className="text-[11px] font-mono-tabular text-slate-400">
                          GIVE LIVES TO ALIVE PLAYERS
                        </div>
                        <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                          {hudStats.humanPlayers
                            .filter((p) => p.alive)
                            .map((p) => (
                              <div
                                key={p.id}
                                className="flex items-center justify-between gap-2 px-3 py-1.5 rounded bg-[#0D131F] border border-slate-800"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    className="w-2.5 h-2.5 rounded-xs shrink-0"
                                    style={{ backgroundColor: p.color }}
                                  />
                                  <span className="font-mono-tabular font-semibold text-slate-200 truncate">
                                    {p.name}
                                  </span>
                                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono-tabular text-[10px]">
                                    ×{p.extraLives} LIVES
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => handleAdminRyGiveLives(p.id, 1, p.name)}
                                    className="px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/35 border border-emerald-400/60 text-emerald-200 font-mono-tabular font-bold text-[11px] cursor-pointer"
                                  >
                                    +1 Life
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleAdminRyGiveLives(p.id, 5, p.name)}
                                    className="px-2.5 py-1 rounded bg-emerald-500/10 hover:bg-emerald-500/25 border border-emerald-400/40 text-emerald-300 font-mono-tabular text-[11px] cursor-pointer"
                                  >
                                    +5
                                  </button>
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Admin Menu AI Autopilot Controls */}
                <div className="p-4 rounded-lg bg-[#080B10] border border-emerald-500/40 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1 max-w-md">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-display font-semibold text-emerald-300 tracking-wide">
                          {isSuperAdminRy ? 'ADMINRY APEX HUNTER AI' : 'ADMIN MENU AI AUTOPILOT'}
                        </span>
                        {isSuperAdminRy && (
                          <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/60 text-amber-300 font-mono-tabular text-[10px] font-bold">
                            EXTRA POWERFUL
                          </span>
                        )}
                        {gameState === 'PLAYING' && isAdminName && autoPilotActive && (
                          <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/60 text-emerald-300 font-mono-tabular text-[10px] font-bold animate-pulse">
                            STEERING ACTIVE
                          </span>
                        )}
                      </div>
                      <p className="text-slate-400 leading-relaxed text-[11px]">
                        {isSuperAdminRy
                          ? 'ADMINRY unlocks full-grid BFS flood-fill anti-trap pathing, aggressive rival cut-off hunting, head-on kill sweeps when longer, and instant pellet cluster vacuuming.'
                          : 'When enabled, an AI automatically steers your snake safely away from outer walls and rival trails while you have the Admin Menu open.'}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={handleToggleAdminAutoPilot}
                      className={`px-3.5 py-2 rounded-lg border font-mono-tabular font-semibold text-xs transition-colors cursor-pointer shrink-0 ${
                        adminAutoPilot
                          ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 hover:bg-emerald-500/30'
                          : 'bg-[#0D131F] border-slate-700 text-slate-400 hover:border-slate-500'
                      }`}
                    >
                      {adminAutoPilot ? 'AI AUTOPILOT: ON' : 'AI AUTOPILOT: OFF'}
                    </button>
                  </div>

                  <div className="pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5 max-w-md">
                      <div className="font-semibold text-slate-200 text-[11px]">
                        Keep Autopilot Running After Closing Admin Menu
                      </div>
                      <p className="text-slate-400 text-[11px] leading-relaxed">
                        AI stays in control after closing this menu and only hands steering back
                        once you press a direction key or D-Pad button.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={handleToggleKeepAutoPilotOnClose}
                        className={`px-3 py-1.5 rounded-lg border font-mono-tabular font-semibold text-[11px] transition-colors cursor-pointer ${
                          keepAutoPilotOnClose
                            ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 hover:bg-emerald-500/30'
                            : 'bg-[#0D131F] border-slate-700 text-slate-400 hover:border-slate-500'
                        }`}
                      >
                        {keepAutoPilotOnClose ? 'KEEP ON CLOSE: ON' : 'KEEP ON CLOSE: OFF'}
                      </button>

                      {gameState === 'PLAYING' && isAdminName && (
                        <button
                          type="button"
                          onClick={() => closeAdminModal(true)}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono-tabular font-bold text-[11px] transition-colors cursor-pointer"
                        >
                          Close & Keep Steering
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Folder Info Banners (Default Folder vs Extra Admin Folder) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3.5 rounded-lg bg-[#080B10] border border-slate-800 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-200">
                        Default Music (<code className="text-emerald-300">src/audio/</code>)
                      </span>
                      <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono-tabular text-[11px] font-semibold">
                        {DISCOVERED_AUDIO_TRACKS.length} TRACKS
                      </span>
                    </div>
                    <p className="text-slate-400 leading-relaxed text-[11px]">
                      Does not auto-play on launch. Organize into playlists below or start manually.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-lg bg-[#080B10] border border-amber-500/40 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-amber-300">
                        Admin Folder (<code className="text-amber-200">src/audio/admin/</code>)
                      </span>
                      <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-mono-tabular text-[11px] font-semibold">
                        {ADMIN_AUDIO_TRACKS.length} ADMIN TRACKS
                      </span>
                    </div>
                    <p className="text-slate-400 leading-relaxed text-[11px]">
                      Hidden from default playlists. Does not auto-play on join—select any song below whenever you want to play it.
                    </p>
                  </div>
                </div>

                {/* Playback & Shuffle Controls Bar */}
                <div className="p-4 rounded-lg bg-[#080B10] border border-slate-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="text-[11px] font-mono-tabular text-slate-400">
                        {isAdminMusicActive
                          ? 'ADMIN FOLDER MUSIC ACTIVE'
                          : `DEFAULT PLAYLIST (${playlistStore.shuffle ? 'SHUFFLED' : 'IN ORDER'})`}
                      </div>
                      <div className="text-sm font-mono-tabular font-semibold text-amber-300">
                        {currentTrackId
                          ? DISCOVERED_AUDIO_TRACKS.find((t) => t.id === currentTrackId)?.title ||
                            ADMIN_AUDIO_TRACKS.find((t) => t.id === currentTrackId)?.title ||
                            currentTrackId
                          : 'Stopped (Manual Play Only)'}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const audio = audioRef.current;
                          if (!audio) return;
                          if (isMusicPlaying && !audio.paused) {
                            audio.pause();
                            setIsMusicPlaying(false);
                          } else {
                            if (isAdminMusicActiveRef.current) {
                              playNextAdminTrack();
                            } else {
                              playNextPlaylistTrack();
                            }
                          }
                        }}
                        className="px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold cursor-pointer"
                      >
                        {isMusicPlaying ? 'Pause Music' : 'Play Default Playlist'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (isAdminMusicActiveRef.current) {
                            playNextAdminTrack();
                          } else {
                            playNextPlaylistTrack();
                          }
                        }}
                        className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium cursor-pointer"
                      >
                        Next Shuffled Track ⏭
                      </button>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800/80 grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
                    <button
                      type="button"
                      onClick={() =>
                        updatePlaylistStore((prev) => ({ ...prev, shuffle: !prev.shuffle }))
                      }
                      className={`py-2 px-3 rounded border font-mono-tabular font-semibold cursor-pointer transition-colors ${
                        playlistStore.shuffle
                          ? 'bg-amber-500/15 border-amber-400 text-amber-300'
                          : 'bg-[#0D131F] border-slate-700 text-slate-400'
                      }`}
                    >
                      SHUFFLE: {playlistStore.shuffle ? 'ON (DEFAULT)' : 'OFF'}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        updatePlaylistStore((prev) => ({
                          ...prev,
                          musicEnabled: !prev.musicEnabled,
                        }))
                      }
                      className={`py-2 px-3 rounded border font-mono-tabular font-semibold cursor-pointer transition-colors ${
                        playlistStore.musicEnabled
                          ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                          : 'bg-[#0D131F] border-slate-700 text-slate-400'
                      }`}
                    >
                      GAME MUSIC: {playlistStore.musicEnabled ? 'ENABLED' : 'MUTED'}
                    </button>

                    <div className="flex items-center gap-2 px-2">
                      <span className="text-slate-400 font-mono-tabular">
                        VOL {Math.round(playlistStore.volume * 100)}%
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={playlistStore.volume}
                        onChange={(e) =>
                          updatePlaylistStore((prev) => ({
                            ...prev,
                            volume: Number(e.target.value),
                          }))
                        }
                        className="w-full accent-emerald-400 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>

                {/* Admin Music Folder Track Selector (src/audio/admin/) */}
                <div className="p-4 rounded-lg bg-[#080B10] border border-amber-500/40 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-display font-semibold text-amber-300 tracking-wide">
                        CHOOSE ADMIN SONG (<code className="text-amber-200">src/audio/admin/</code>)
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Select any song in the admin folder to play it right now. When it finishes,
                        the admin folder continues shuffling and looping.
                      </p>
                    </div>
                    {ADMIN_AUDIO_TRACKS.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          isAdminMusicActiveRef.current = true;
                          setIsAdminMusicActive(true);
                          playNextAdminTrack();
                        }}
                        className="px-2.5 py-1.5 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/60 text-amber-200 font-mono-tabular font-semibold text-[11px] cursor-pointer"
                      >
                        Shuffle Next Admin Song ⏭
                      </button>
                    )}
                  </div>

                  {ADMIN_AUDIO_TRACKS.length === 0 ? (
                    <div className="p-3 rounded bg-[#0D131F] border border-slate-800 text-slate-400 text-[11px]">
                      No audio files found in <code>src/audio/admin/</code>. Drop any{' '}
                      <code>.mp3</code> into <code>src/audio/admin/</code> to select it here.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-44 overflow-y-auto pr-1">
                      {ADMIN_AUDIO_TRACKS.map((track) => {
                        const isCurrentlyPlayingThis =
                          currentTrackId === track.id && isMusicPlaying;
                        return (
                          <div
                            key={track.id}
                            className={`p-2.5 rounded-lg border flex items-center justify-between gap-2.5 transition-colors ${
                              isCurrentlyPlayingThis
                                ? 'bg-amber-500/15 border-amber-400 text-white'
                                : 'bg-[#0D131F] border-slate-800 text-slate-200 hover:border-slate-700'
                            }`}
                          >
                            <div className="truncate">
                              <div className="font-mono-tabular font-semibold truncate">
                                {track.title}
                              </div>
                              <div className="text-[10px] text-slate-400 font-mono-tabular truncate">
                                src/audio/{track.id}
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => {
                                isAdminMusicActiveRef.current = true;
                                setIsAdminMusicActive(true);
                                playNextAdminTrack(track.id);
                                sendCommand({ type: 'admin_track', trackId: track.id });
                              }}
                              className={`px-3 py-1.5 rounded text-[11px] font-mono-tabular font-semibold shrink-0 cursor-pointer transition-colors ${
                                isCurrentlyPlayingThis
                                  ? 'bg-amber-400 text-slate-950'
                                  : 'bg-slate-800 hover:bg-amber-500 hover:text-slate-950 text-amber-300 border border-amber-500/40'
                              }`}
                            >
                              {isCurrentlyPlayingThis ? 'PLAYING NOW' : 'PLAY SONG'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Playlists Organizer Grid */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                  {/* Left Column: Playlists List & Create New Playlist */}
                  <div className="md:col-span-5 space-y-3">
                    <div className="font-display font-semibold text-slate-200 tracking-wide">
                      1. SELECT OR CREATE PLAYLIST
                    </div>

                    <div className="space-y-1.5">
                      {playlistStore.playlists.map((pl) => {
                        const isSelected = selectedPlaylistId === pl.id;
                        const isActiveInGame = playlistStore.activePlaylistId === pl.id;
                        return (
                          <div
                            key={pl.id}
                            onClick={() => setSelectedPlaylistId(pl.id)}
                            className={`p-2.5 rounded-lg border transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                              isSelected
                                ? 'bg-slate-800/90 border-amber-400/70 text-white'
                                : 'bg-[#080B10] border-slate-800 text-slate-300 hover:border-slate-700'
                            }`}
                          >
                            <div className="truncate">
                              <div className="font-semibold truncate">{pl.name}</div>
                              <div className="text-[11px] text-slate-400 font-mono-tabular">
                                {pl.trackIds.length} tracks
                                {isActiveInGame ? ' · ACTIVE IN GAME' : ''}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updatePlaylistStore((prev) => ({
                                    ...prev,
                                    activePlaylistId: pl.id,
                                  }));
                                }}
                                className={`px-2 py-1 rounded text-[10px] font-mono-tabular font-semibold cursor-pointer ${
                                  isActiveInGame
                                    ? 'bg-emerald-500 text-slate-950'
                                    : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                                }`}
                              >
                                {isActiveInGame ? 'ACTIVE' : 'SET ACTIVE'}
                              </button>
                              {!pl.isBuiltIn && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    updatePlaylistStore((prev) => {
                                      const filtered = prev.playlists.filter((p) => p.id !== pl.id);
                                      const nextActive =
                                        prev.activePlaylistId === pl.id
                                          ? 'all_tracks'
                                          : prev.activePlaylistId;
                                      return {
                                        ...prev,
                                        playlists: filtered,
                                        activePlaylistId: nextActive,
                                      };
                                    });
                                    if (selectedPlaylistId === pl.id) {
                                      setSelectedPlaylistId('all_tracks');
                                    }
                                  }}
                                  className="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[10px] font-semibold cursor-pointer"
                                  title="Delete playlist"
                                >
                                  DEL
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Create New Playlist Input */}
                    <div className="pt-2 flex items-center gap-2">
                      <input
                        type="text"
                        maxLength={24}
                        value={newPlaylistName}
                        onChange={(e) => setNewPlaylistName(e.target.value.toUpperCase())}
                        placeholder="NEW PLAYLIST NAME..."
                        className="flex-1 px-3 py-2 rounded-lg bg-[#080B10] border border-slate-700 text-white font-mono-tabular text-xs uppercase focus:outline-none focus:border-amber-400"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const clean = newPlaylistName.trim().toUpperCase();
                          if (!clean) return;
                          const newId = `custom_${Date.now()}`;
                          updatePlaylistStore((prev) => ({
                            ...prev,
                            playlists: [
                              ...prev.playlists,
                              {
                                id: newId,
                                name: clean,
                                trackIds: DISCOVERED_AUDIO_TRACKS.map((t) => t.id),
                              },
                            ],
                            activePlaylistId: newId,
                          }));
                          setSelectedPlaylistId(newId);
                          setNewPlaylistName('');
                        }}
                        className="px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs whitespace-nowrap cursor-pointer"
                      >
                        + Create
                      </button>
                    </div>
                  </div>

                  {/* Right Column: Organize Tracks Inside Selected Playlist */}
                  <div className="md:col-span-7 space-y-3">
                    {(() => {
                      const editingPl =
                        playlistStore.playlists.find((p) => p.id === selectedPlaylistId) ||
                        playlistStore.playlists[0];
                      if (!editingPl) return null;

                      return (
                        <>
                          <div className="flex items-center justify-between">
                            <div className="font-display font-semibold text-slate-200 tracking-wide">
                              2. ORGANIZE TRACKS IN "{editingPl.name}"
                            </div>
                            {!editingPl.isBuiltIn && (
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    updatePlaylistStore((prev) => ({
                                      ...prev,
                                      playlists: prev.playlists.map((p) =>
                                        p.id === editingPl.id
                                          ? {
                                              ...p,
                                              trackIds: DISCOVERED_AUDIO_TRACKS.map((t) => t.id),
                                            }
                                          : p
                                      ),
                                    }))
                                  }
                                  className="text-[11px] text-emerald-400 hover:underline cursor-pointer"
                                >
                                  Select All
                                </button>
                                <span className="text-slate-700">·</span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    updatePlaylistStore((prev) => ({
                                      ...prev,
                                      playlists: prev.playlists.map((p) =>
                                        p.id === editingPl.id ? { ...p, trackIds: [] } : p
                                      ),
                                    }))
                                  }
                                  className="text-[11px] text-slate-400 hover:underline cursor-pointer"
                                >
                                  Clear
                                </button>
                              </div>
                            )}
                          </div>

                          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                            {DISCOVERED_AUDIO_TRACKS.map((track) => {
                              const included = editingPl.trackIds.includes(track.id);
                              const isCurrent = currentTrackId === track.id && isMusicPlaying;
                              return (
                                <div
                                  key={track.id}
                                  className={`p-2.5 rounded-lg border flex items-center justify-between gap-3 ${
                                    included
                                      ? 'bg-[#080B10] border-slate-700 text-slate-100'
                                      : 'bg-[#080B10]/50 border-slate-800/60 text-slate-500'
                                  }`}
                                >
                                  <div className="flex items-center gap-2.5 truncate">
                                    <input
                                      type="checkbox"
                                      disabled={Boolean(editingPl.isBuiltIn)}
                                      checked={included}
                                      onChange={() => {
                                        if (editingPl.isBuiltIn) return;
                                        updatePlaylistStore((prev) => ({
                                          ...prev,
                                          playlists: prev.playlists.map((p) => {
                                            if (p.id !== editingPl.id) return p;
                                            const exists = p.trackIds.includes(track.id);
                                            return {
                                              ...p,
                                              trackIds: exists
                                                ? p.trackIds.filter((id) => id !== track.id)
                                                : [...p.trackIds, track.id],
                                            };
                                          }),
                                        }));
                                      }}
                                      className="w-4 h-4 accent-emerald-500 cursor-pointer"
                                    />
                                    <div className="truncate">
                                      <div className="font-mono-tabular font-medium truncate">
                                        {track.title}
                                      </div>
                                      <div className="text-[10px] text-slate-400 font-mono-tabular truncate">
                                        src/audio/{track.id}
                                      </div>
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => playNextPlaylistTrack(track.id)}
                                    className={`px-2.5 py-1 rounded text-[11px] font-mono-tabular font-semibold shrink-0 cursor-pointer ${
                                      isCurrent
                                        ? 'bg-amber-400 text-slate-950'
                                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                                    }`}
                                  >
                                    {isCurrent ? 'PLAYING' : 'PREVIEW'}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* INCOMING LIFE TRADE TOAST BANNER (Non-blocking while driving) */}
        {gameState === 'PLAYING' && !showTradeModal && incomingTrades.length > 0 && (
          <div className="fixed bottom-11 left-4 z-25 max-w-xs w-full p-3.5 rounded-xl bg-[#0D131F]/95 border border-emerald-400/70 shadow-2xl space-y-2.5">
            {(() => {
              const offer = incomingTrades[0];
              const giveLabel =
                offer.giveType === 'LIFE'
                  ? `${offer.giveAmount} Extra Life`
                  : `${offer.giveAmount} Score`;
              const wantLabel =
                offer.wantType === 'LIFE'
                  ? `${offer.wantAmount} Extra Life`
                  : `${offer.wantAmount} Score`;
              return (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-mono-tabular font-bold text-emerald-300">
                      INCOMING LIFE TRADE
                    </span>
                    {incomingTrades.length > 1 && (
                      <span className="text-[10px] font-mono-tabular text-amber-300">
                        +{incomingTrades.length - 1} more
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-200 leading-snug">
                    <strong className="text-white">{offer.fromName}</strong> offers{' '}
                    <span className="text-emerald-300 font-semibold">{giveLabel}</span> for your{' '}
                    <span className="text-amber-300 font-semibold">{wantLabel}</span>.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleRespondToTrade(offer, true)}
                      className="flex-1 py-1.5 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono-tabular font-bold text-xs cursor-pointer transition-colors"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRespondToTrade(offer, false)}
                      className="py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono-tabular text-xs cursor-pointer transition-colors"
                    >
                      Decline
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* TRADE FEEDBACK TOAST */}
        {tradeFeedback && !showTradeModal && (
          <div
            className={`fixed top-16 left-1/2 -translate-x-1/2 z-25 px-4 py-2 rounded-lg border font-mono-tabular text-xs font-semibold shadow-xl pointer-events-none ${
              tradeFeedback.ok
                ? 'bg-[#0B1512]/95 border-emerald-400/70 text-emerald-200'
                : 'bg-[#170D11]/95 border-rose-400/70 text-rose-200'
            }`}
          >
            {tradeFeedback.text}
          </div>
        )}

        {/* TRADE LIVES MODAL */}
        {showTradeModal && gameState === 'PLAYING' && (
          <div className="absolute inset-0 z-40 bg-[#080B10]/85 flex items-center justify-center p-4">
            <div className="w-full max-w-xl max-h-[88vh] flex flex-col rounded-xl bg-[#0D131F] border border-emerald-500/50 shadow-2xl overflow-hidden">
              <div className="px-6 py-4 bg-[#090D16] border-b border-slate-800 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-mono-tabular text-emerald-400 font-semibold">
                    PLAYER TRADING POST · EXTRA LIVES & SCORE
                  </div>
                  <h2 className="font-display text-xl font-bold text-white">TRADE LIVES</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setShowTradeModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold cursor-pointer"
                >
                  Close [Esc]
                </button>
              </div>

              <div className="p-5 overflow-y-auto space-y-4 text-xs">
                {/* Your Wallet Summary */}
                <div className="grid grid-cols-2 gap-3 font-mono-tabular">
                  <div className="p-3 rounded-lg bg-[#080B10] border border-emerald-500/30 flex items-center justify-between">
                    <span className="text-slate-400">YOUR EXTRA LIVES</span>
                    <span className="text-base font-bold text-emerald-300">
                      ×{hudStats.extraLives}
                    </span>
                  </div>
                  <div className="p-3 rounded-lg bg-[#080B10] border border-amber-500/30 flex items-center justify-between">
                    <span className="text-slate-400">YOUR SCORE</span>
                    <span className="text-base font-bold text-amber-300">{hudStats.score}</span>
                  </div>
                </div>

                {tradeFeedback && (
                  <div
                    className={`px-3.5 py-2 rounded-lg border font-mono-tabular text-[11px] font-semibold ${
                      tradeFeedback.ok
                        ? 'bg-emerald-500/15 border-emerald-400/50 text-emerald-200'
                        : 'bg-rose-500/15 border-rose-400/50 text-rose-200'
                    }`}
                  >
                    {tradeFeedback.text}
                  </div>
                )}

                {/* Pending Incoming Offers */}
                {incomingTrades.length > 0 && (
                  <div className="p-3.5 rounded-lg bg-[#080B10] border border-emerald-400/50 space-y-2.5">
                    <div className="font-display font-semibold text-emerald-300 tracking-wide">
                      INCOMING OFFERS ({incomingTrades.length})
                    </div>
                    <div className="space-y-2">
                      {incomingTrades.map((offer) => {
                        const giveLabel =
                          offer.giveType === 'LIFE'
                            ? `${offer.giveAmount} Extra Life`
                            : `${offer.giveAmount} Score`;
                        const wantLabel =
                          offer.wantType === 'LIFE'
                            ? `${offer.wantAmount} Extra Life`
                            : `${offer.wantAmount} Score`;
                        return (
                          <div
                            key={offer.id}
                            className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded bg-[#0D131F] border border-slate-800"
                          >
                            <div className="text-slate-200">
                              <strong>{offer.fromName}</strong> offers{' '}
                              <span className="text-emerald-300 font-semibold">{giveLabel}</span> ⇄{' '}
                              <span className="text-amber-300 font-semibold">{wantLabel}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleRespondToTrade(offer, true)}
                                className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono-tabular font-bold text-[11px] cursor-pointer"
                              >
                                Accept
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRespondToTrade(offer, false)}
                                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono-tabular text-[11px] cursor-pointer"
                              >
                                Decline
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Connected Alive Human Players */}
                {(() => {
                  const aliveHumans = hudStats.humanPlayers.filter((p) => p.alive);
                  const activeTarget =
                    aliveHumans.find((p) => p.id === tradeTargetId) || aliveHumans[0] || null;
                  return (
                    <>
                      <div className="p-3.5 rounded-lg bg-[#080B10] border border-slate-800 space-y-2.5">
                        <div className="font-display font-semibold text-slate-200 tracking-wide">
                          ALIVE PLAYERS IN ARENA ({aliveHumans.length})
                        </div>
                        {aliveHumans.length === 0 ? (
                          <p className="text-slate-500 py-1">
                            No other alive human players in this arena right now. Invite a friend
                            or wait for another player to spawn!
                          </p>
                        ) : (
                          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                            {aliveHumans.map((p) => {
                              const isSelected = activeTarget?.id === p.id;
                              return (
                                <div
                                  key={p.id}
                                  className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded border transition-colors ${
                                    isSelected
                                      ? 'bg-emerald-500/10 border-emerald-500/50'
                                      : 'bg-[#0D131F] border-slate-800'
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => setTradeTargetId(p.id)}
                                    className="flex items-center gap-2 min-w-0 text-left cursor-pointer"
                                  >
                                    <span
                                      className="w-2.5 h-2.5 rounded-xs shrink-0"
                                      style={{ backgroundColor: p.color }}
                                    />
                                    <span className="font-mono-tabular font-semibold text-slate-100 truncate">
                                      {p.name}
                                    </span>
                                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono-tabular text-[10px]">
                                      {p.extraLives} {p.extraLives === 1 ? 'LIFE' : 'LIVES'}
                                    </span>
                                    <span className="text-amber-300 font-mono-tabular text-[10px]">
                                      {p.score} PTS
                                    </span>
                                  </button>

                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                      type="button"
                                      disabled={hudStats.extraLives < 1}
                                      onClick={() => handleGiveExtraLife(p.id, p.name)}
                                      className={`px-2.5 py-1 rounded font-mono-tabular font-semibold text-[11px] transition-colors ${
                                        hudStats.extraLives >= 1
                                          ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 cursor-pointer'
                                          : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                                      }`}
                                      title="Immediately transfer 1 Extra Life to this player"
                                    >
                                      Give 1 Life
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setTradeTargetId(p.id)}
                                      className={`px-2.5 py-1 rounded border font-mono-tabular text-[11px] cursor-pointer ${
                                        isSelected
                                          ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                                          : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                                      }`}
                                    >
                                      Propose Trade
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* Custom Trade Proposal Builder */}
                      {activeTarget && (
                        <div className="p-4 rounded-lg bg-[#080B10] border border-amber-500/40 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="font-display font-semibold text-amber-300 tracking-wide">
                              TRADE OFFER TO {activeTarget.name}
                            </span>
                            <span className="text-[11px] font-mono-tabular text-slate-400">
                              Instant atomic swap on accept
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="p-3 rounded bg-[#0D131F] border border-slate-800 space-y-2">
                              <div className="text-[11px] font-mono-tabular text-slate-400">
                                YOU OFFER
                              </div>
                              <div className="grid grid-cols-2 gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setTradeGiveType('LIFE')}
                                  className={`py-1.5 px-2 rounded border font-mono-tabular text-[11px] font-semibold cursor-pointer ${
                                    tradeGiveType === 'LIFE'
                                      ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                                      : 'bg-[#080B10] border-slate-700 text-slate-400'
                                  }`}
                                >
                                  1 Extra Life
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setTradeGiveType('SCORE')}
                                  className={`py-1.5 px-2 rounded border font-mono-tabular text-[11px] font-semibold cursor-pointer ${
                                    tradeGiveType === 'SCORE'
                                      ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                                      : 'bg-[#080B10] border-slate-700 text-slate-400'
                                  }`}
                                >
                                  Score Points
                                </button>
                              </div>
                              {tradeGiveType === 'SCORE' && (
                                <select
                                  value={tradeGiveScore}
                                  onChange={(e) => setTradeGiveScore(Number(e.target.value))}
                                  className="w-full px-2.5 py-1.5 rounded bg-[#080B10] border border-slate-700 text-amber-300 font-mono-tabular text-xs"
                                >
                                  <option value={250}>250 PTS</option>
                                  <option value={500}>500 PTS</option>
                                  <option value={1000}>1,000 PTS</option>
                                  <option value={2000}>2,000 PTS</option>
                                </select>
                              )}
                            </div>

                            <div className="p-3 rounded bg-[#0D131F] border border-slate-800 space-y-2">
                              <div className="text-[11px] font-mono-tabular text-slate-400">
                                YOU ASK FOR
                              </div>
                              <div className="grid grid-cols-2 gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setTradeWantType('LIFE')}
                                  className={`py-1.5 px-2 rounded border font-mono-tabular text-[11px] font-semibold cursor-pointer ${
                                    tradeWantType === 'LIFE'
                                      ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                                      : 'bg-[#080B10] border-slate-700 text-slate-400'
                                  }`}
                                >
                                  1 Extra Life
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setTradeWantType('SCORE')}
                                  className={`py-1.5 px-2 rounded border font-mono-tabular text-[11px] font-semibold cursor-pointer ${
                                    tradeWantType === 'SCORE'
                                      ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                                      : 'bg-[#080B10] border-slate-700 text-slate-400'
                                  }`}
                                >
                                  Score Points
                                </button>
                              </div>
                              {tradeWantType === 'SCORE' && (
                                <select
                                  value={tradeWantScore}
                                  onChange={(e) => setTradeWantScore(Number(e.target.value))}
                                  className="w-full px-2.5 py-1.5 rounded bg-[#080B10] border border-slate-700 text-amber-300 font-mono-tabular text-xs"
                                >
                                  <option value={250}>250 PTS</option>
                                  <option value={500}>500 PTS</option>
                                  <option value={1000}>1,000 PTS</option>
                                  <option value={2000}>2,000 PTS</option>
                                </select>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                handleSendTradeOffer(
                                  activeTarget.id,
                                  activeTarget.name,
                                  tradeGiveType,
                                  tradeGiveType === 'LIFE' ? 1 : tradeGiveScore,
                                  tradeWantType,
                                  tradeWantType === 'LIFE' ? 1 : tradeWantScore
                                )
                              }
                              className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono-tabular font-bold text-xs cursor-pointer transition-colors"
                            >
                              Send Trade Offer
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Hidden HTML5 Audio Element for Shuffled In-Game Folder Playlists */}
      <audio
        ref={audioRef}
        onEnded={() => {
          if (isAdminMusicActiveRef.current) {
            playNextAdminTrack();
          } else {
            playNextPlaylistTrack();
          }
        }}
        className="hidden"
      />

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
