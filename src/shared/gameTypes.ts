export const GRID_SIZE = 32;
export const TICK_MS = 120; // ~8.33 ticks/sec for crisp, responsive grid movement
export const SPAWN_PROTECTION_TICKS = 28; // ~3.36 seconds fail-safe spawn protection timer

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
  autoPilot?: boolean;
  autoPilotTier?: 'STANDARD' | 'ADMINRY';
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

export interface PackedSnake {
  i: string; // id
  n: string; // name
  c: number | string; // palette index (0..5) or color id
  d: number; // dir index 0..3
  s: number; // score
  k: number; // kills
  p: number; // pelletsSlurped
  f: number; // bitmask: bit0=alive, bit1=isBot
  sh: number; // shieldTicks
  dr?: number; // deathReason index 0..3
  kb?: string; // killedByName
  px: number; // prevHead.x
  py: number; // prevHead.y
  g: string; // compact RLE/step-encoded segments string
}

export type PackedPellet = [
  id: string,
  x: number,
  y: number,
  value: number,
  growth: number,
  color: string,
  ttlTicks: number,
];

export type PackedTelegraph = [
  id: string,
  x: number,
  y: number,
  dir: number,
  color: number | string,
  name: string,
  ticksLeft: number,
  isBot: number,
];

export type PackedKill = [
  id: string,
  tick: number,
  victimId: string,
  victimName: string,
  killerId: string,
  killerName: string,
  reasonIdx: number,
  x: number,
  y: number,
  pelletsDropped: number,
  victimColor: string,
];

export type PackedSlurp = [
  id: string,
  tick: number,
  snakeId: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
  value: number,
];

export interface PackedArenaSnapshot {
  v: 2;
  t: number; // tick
  gs: number; // gridSize
  sn: PackedSnake[];
  pl: PackedPellet[];
  tl: PackedTelegraph[];
  rk: PackedKill[];
  rs: PackedSlurp[];
  op: number; // onlinePlayers
}

export type ServerGridSize = 32 | 64;

export type ClientToServerMessage =
  | {
      type: 'join';
      name: string;
      colorId: string;
      clientId: string;
      gridSize?: ServerGridSize;
      autoPilot?: boolean;
      autoPilotTier?: 'STANDARD' | 'ADMINRY';
    }
  | { type: 'turn'; dir: Direction }
  | {
      type: 'respawn';
      name: string;
      colorId: string;
      gridSize?: ServerGridSize;
      autoPilot?: boolean;
      autoPilotTier?: 'STANDARD' | 'ADMINRY';
    }
  | { type: 'select_server'; gridSize: ServerGridSize }
  | { type: 'autopilot'; enabled: boolean; tier?: 'STANDARD' | 'ADMINRY' }
  | { type: 'admin_track'; trackId: string }
  | { type: 'kick_admin'; targetPlayerId: string; issuedByClientId: string }
  | { type: 'leave' };

export type ServerToClientMessage =
  | { type: 'welcome'; playerId: string; state: ArenaSnapshot | PackedArenaSnapshot }
  | { type: 'state'; state: ArenaSnapshot | PackedArenaSnapshot }
  | { type: 'admin_track'; trackId: string }
  | { type: 'kick_admin'; targetPlayerId: string; issuedByClientId: string };
