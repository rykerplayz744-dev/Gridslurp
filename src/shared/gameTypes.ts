export const GRID_SIZE = 32;
export const TICK_MS = 155; // ~6.45 ticks/sec for slightly slower, tactical pixel grid control
export const SPAWN_PROTECTION_TICKS = 22; // ~3.4 seconds fail-safe spawn protection timer

export type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

export interface Point {
  x: number;
  y: number;
}

export interface SnakeColor {
  id: string;
  name: string;
  head: string;
  body: string;
  tail: string;
  glow: string;
}

export const SNAKE_PALETTES: SnakeColor[] = [
  {
    id: 'emerald',
    name: 'Phosphor Mint',
    head: '#6EE7B7',
    body: '#10B981',
    tail: '#047857',
    glow: 'rgba(16, 185, 129, 0.55)',
  },
  {
    id: 'cyan',
    name: 'Arc Cyan',
    head: '#67E8F9',
    body: '#06B6D4',
    tail: '#0E7490',
    glow: 'rgba(6, 182, 212, 0.55)',
  },
  {
    id: 'rose',
    name: 'Laser Rose',
    head: '#FDA4AF',
    body: '#F43F5E',
    tail: '#BE123C',
    glow: 'rgba(244, 63, 94, 0.55)',
  },
  {
    id: 'violet',
    name: 'Plasma Violet',
    head: '#C4B5FD',
    body: '#8B5CF6',
    tail: '#5B21B6',
    glow: 'rgba(139, 92, 246, 0.55)',
  },
  {
    id: 'orange',
    name: 'Solar Tangerine',
    head: '#FDBA74',
    body: '#F97316',
    tail: '#C2410C',
    glow: 'rgba(249, 115, 22, 0.55)',
  },
  {
    id: 'lime',
    name: 'Volt Lime',
    head: '#BEF264',
    body: '#84CC16',
    tail: '#4D7C0F',
    glow: 'rgba(132, 204, 22, 0.55)',
  },
];

export interface BigPellet {
  id: string;
  x: number;
  y: number;
  value: number;
  growth: number;
  color: string;
  spawnTick: number;
  ttlTicks: number; // How many ticks until it fades
  fromSnakeName: string;
}

export interface SpawnTelegraph {
  id: string;
  x: number;
  y: number;
  dir: Direction;
  color: SnakeColor;
  name: string;
  ticksLeft: number;
  isBot: boolean;
  ownerId?: string;
}

export interface SnakeEntity {
  id: string;
  name: string;
  color: SnakeColor;
  segments: Point[]; // segments[0] is head
  prevSegments: Point[]; // for smooth sub-tick visual interpolation
  dir: Direction;
  nextDirs: Direction[]; // 2-step turn buffer
  score: number;
  kills: number;
  pelletsSlurped: number;
  alive: boolean;
  isBot: boolean;
  spawnTick: number;
  shieldTicks: number;
  deathReason?: 'WALL_CRASH' | 'SELF_CRASH' | 'KILLED_BY_SNAKE' | 'HEAD_COLLISION';
  killedByName?: string;
  botStyle?: 'HUNTER' | 'SCAVENGER' | 'INTERCEPTOR' | 'FLANKER';
}

export interface KillEvent {
  id: string;
  tick: number;
  victimId: string;
  victimName: string;
  killerId?: string;
  killerName?: string;
  reason: 'WALL_CRASH' | 'SELF_CRASH' | 'KILLED_BY_SNAKE' | 'HEAD_COLLISION';
  x: number;
  y: number;
  pelletsDropped: number;
  victimColor: string;
}

export interface SlurpEvent {
  id: string;
  tick: number;
  snakeId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color: string;
  value: number;
}

export interface ArenaSnapshot {
  tick: number;
  gridSize: number;
  snakes: SnakeEntity[];
  pellets: BigPellet[];
  telegraphs: SpawnTelegraph[];
  recentKills: KillEvent[];
  recentSlurps: SlurpEvent[];
  onlinePlayers: number;
}

export type ClientToServerMessage =
  | { type: 'join'; name: string; colorId: string; clientId: string }
  | { type: 'turn'; dir: Direction }
  | { type: 'respawn'; name: string; colorId: string }
  | { type: 'leave' };

export type ServerToClientMessage =
  | { type: 'welcome'; playerId: string; state: ArenaSnapshot }
  | { type: 'state'; state: ArenaSnapshot };
