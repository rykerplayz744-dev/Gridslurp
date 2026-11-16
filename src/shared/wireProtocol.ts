import {
  ArenaSnapshot,
  BigPellet,
  Direction,
  KillEvent,
  PackedArenaSnapshot,
  PackedKill,
  PackedPellet,
  PackedSlurp,
  PackedSnake,
  PackedTelegraph,
  Point,
  SlurpEvent,
  SNAKE_PALETTES,
  SnakeColor,
  SnakeEntity,
  SpawnTelegraph,
} from './gameTypes';

const DIRS: Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
const DEATH_REASONS: Array<
  'WALL_CRASH' | 'SELF_CRASH' | 'KILLED_BY_SNAKE' | 'HEAD_COLLISION'
> = ['WALL_CRASH', 'SELF_CRASH', 'KILLED_BY_SNAKE', 'HEAD_COLLISION'];

const PALETTE_INDEX_BY_ID = new Map<string, number>(
  SNAKE_PALETTES.map((p, idx) => [p.id, idx])
);

function resolveColorFromCode(code: number | string): SnakeColor {
  if (typeof code === 'number' && SNAKE_PALETTES[code]) {
    return SNAKE_PALETTES[code];
  }
  const found = SNAKE_PALETTES.find((p) => p.id === code);
  return found || SNAKE_PALETTES[0];
}

/**
 * Lossless compact step encoding for snake segments.
 * Encodes adjacent steps as single digits:
 * '0'=dy-1, '1'=dy+1, '2'=dx-1, '3'=dx+1, '4'=same cell, or ';x,y:' on non-adjacent jump.
 * Reduces wire bytes per segment by ~12x-14x compared to JSON `{x,y}` objects.
 */
export function encodeSegments(segments: Point[]): string {
  if (!segments || segments.length === 0) return '';
  const head = segments[0];
  let out = `${head.x},${head.y}:`;
  let px = head.x;
  let py = head.y;

  for (let i = 1; i < segments.length; i++) {
    const s = segments[i];
    const dx = s.x - px;
    const dy = s.y - py;
    if (dx === 0 && dy === -1) {
      out += '0';
    } else if (dx === 0 && dy === 1) {
      out += '1';
    } else if (dx === -1 && dy === 0) {
      out += '2';
    } else if (dx === 1 && dy === 0) {
      out += '3';
    } else if (dx === 0 && dy === 0) {
      out += '4';
    } else {
      out += `;${s.x},${s.y}:`;
    }
    px = s.x;
    py = s.y;
  }
  return out;
}

export function decodeSegments(encoded: string): Point[] {
  if (!encoded) return [];
  const segs: Point[] = [];
  let i = 0;
  const n = encoded.length;

  const parsePair = (): { x: number; y: number } => {
    const commaIdx = encoded.indexOf(',', i);
    const colonIdx = encoded.indexOf(':', commaIdx + 1);
    const x = parseInt(encoded.slice(i, commaIdx), 10) || 0;
    const y = parseInt(encoded.slice(commaIdx + 1, colonIdx), 10) || 0;
    i = colonIdx + 1;
    return { x, y };
  };

  let curr = parsePair();
  segs.push({ x: curr.x, y: curr.y });

  while (i < n) {
    const ch = encoded.charCodeAt(i);
    if (ch === 59) {
      // ';' non-adjacent jump
      i++;
      curr = parsePair();
      segs.push({ x: curr.x, y: curr.y });
    } else {
      i++;
      if (ch === 48) curr = { x: curr.x, y: curr.y - 1 }; // '0'
      else if (ch === 49) curr = { x: curr.x, y: curr.y + 1 }; // '1'
      else if (ch === 50) curr = { x: curr.x - 1, y: curr.y }; // '2'
      else if (ch === 51) curr = { x: curr.x + 1, y: curr.y }; // '3'
      else curr = { x: curr.x, y: curr.y }; // '4'
      segs.push(curr);
    }
  }

  return segs;
}

export function isPackedSnapshot(
  data: ArenaSnapshot | PackedArenaSnapshot
): data is PackedArenaSnapshot {
  return (data as PackedArenaSnapshot)?.v === 2;
}

export function packSnapshot(snap: ArenaSnapshot): PackedArenaSnapshot {
  const sn: PackedSnake[] = snap.snakes.map((s) => {
    const prevHead =
      s.prevSegments && s.prevSegments[0]
        ? s.prevSegments[0]
        : s.segments[0] || { x: 0, y: 0 };
    const colorCode = PALETTE_INDEX_BY_ID.get(s.color.id) ?? s.color.id;
    const packed: PackedSnake = {
      i: s.id,
      n: s.name,
      c: colorCode,
      d: Math.max(0, DIRS.indexOf(s.dir)),
      s: s.score,
      k: s.kills,
      p: s.pelletsSlurped,
      f: (s.alive ? 1 : 0) | (s.isBot ? 2 : 0) | (s.autoPilot ? 4 : 0),
      sh: s.shieldTicks,
      px: prevHead.x,
      py: prevHead.y,
      g: encodeSegments(s.segments),
    };
    if (s.deathReason) {
      const drIdx = DEATH_REASONS.indexOf(s.deathReason);
      if (drIdx >= 0) packed.dr = drIdx;
    }
    if (s.killedByName) {
      packed.kb = s.killedByName;
    }
    if (s.nextDirs && s.nextDirs.length > 0) {
      packed.nd = s.nextDirs.map((d) => Math.max(0, DIRS.indexOf(d)));
    }
    if (typeof s.lastTurnSeq === 'number') {
      packed.ts = s.lastTurnSeq;
    }
    return packed;
  });

  const pl: PackedPellet[] = snap.pellets.map((p) => [
    p.id,
    p.x,
    p.y,
    p.value,
    p.growth,
    p.color,
    p.ttlTicks,
  ]);

  const tl: PackedTelegraph[] = snap.telegraphs.map((t) => [
    t.id,
    t.x,
    t.y,
    Math.max(0, DIRS.indexOf(t.dir)),
    PALETTE_INDEX_BY_ID.get(t.color.id) ?? t.color.id,
    t.name,
    t.ticksLeft,
    t.isBot ? 1 : 0,
  ]);

  const rk: PackedKill[] = snap.recentKills.map((k) => [
    k.id,
    k.tick,
    k.victimId,
    k.victimName,
    k.killerId || '',
    k.killerName || '',
    Math.max(0, DEATH_REASONS.indexOf(k.reason)),
    k.x,
    k.y,
    k.pelletsDropped,
    k.victimColor,
  ]);

  const rs: PackedSlurp[] = snap.recentSlurps.map((s) => [
    s.id,
    s.tick,
    s.snakeId,
    s.fromX,
    s.fromY,
    s.toX,
    s.toY,
    s.color,
    s.value,
  ]);

  return {
    v: 2,
    t: snap.tick,
    gs: snap.gridSize,
    sn,
    pl,
    tl,
    rk,
    rs,
    op: snap.onlinePlayers,
  };
}

export function unpackSnapshot(
  raw: ArenaSnapshot | PackedArenaSnapshot
): ArenaSnapshot {
  if (!isPackedSnapshot(raw)) {
    return raw;
  }

  const snakes: SnakeEntity[] = raw.sn.map((ps) => {
    const segments = decodeSegments(ps.g);
    return {
      id: ps.i,
      name: ps.n,
      color: resolveColorFromCode(ps.c),
      segments,
      prevSegments: [{ x: ps.px, y: ps.py }],
      dir: DIRS[ps.d] || 'RIGHT',
      nextDirs: Array.isArray(ps.nd) ? ps.nd.map((idx) => DIRS[idx] || 'RIGHT') : [],
      lastTurnSeq: ps.ts,
      score: ps.s,
      kills: ps.k,
      pelletsSlurped: ps.p,
      alive: (ps.f & 1) !== 0,
      isBot: (ps.f & 2) !== 0,
      autoPilot: (ps.f & 4) !== 0,
      spawnTick: 0,
      shieldTicks: ps.sh,
      deathReason: ps.dr !== undefined ? DEATH_REASONS[ps.dr] : undefined,
      killedByName: ps.kb,
    };
  });

  const pellets: BigPellet[] = raw.pl.map((pp) => ({
    id: pp[0],
    x: pp[1],
    y: pp[2],
    value: pp[3],
    growth: pp[4],
    color: pp[5],
    spawnTick: raw.t,
    ttlTicks: pp[6],
    fromSnakeName: '',
  }));

  const telegraphs: SpawnTelegraph[] = raw.tl.map((pt) => ({
    id: pt[0],
    x: pt[1],
    y: pt[2],
    dir: DIRS[pt[3]] || 'RIGHT',
    color: resolveColorFromCode(pt[4]),
    name: pt[5],
    ticksLeft: pt[6],
    isBot: pt[7] === 1,
  }));

  const recentKills: KillEvent[] = raw.rk.map((pk) => ({
    id: pk[0],
    tick: pk[1],
    victimId: pk[2],
    victimName: pk[3],
    killerId: pk[4] || undefined,
    killerName: pk[5] || undefined,
    reason: DEATH_REASONS[pk[6]] || 'WALL_CRASH',
    x: pk[7],
    y: pk[8],
    pelletsDropped: pk[9],
    victimColor: pk[10],
  }));

  const recentSlurps: SlurpEvent[] = raw.rs.map((ps) => ({
    id: ps[0],
    tick: ps[1],
    snakeId: ps[2],
    fromX: ps[3],
    fromY: ps[4],
    toX: ps[5],
    toY: ps[6],
    color: ps[7],
    value: ps[8],
  }));

  return {
    tick: raw.t,
    gridSize: raw.gs,
    snakes,
    pellets,
    telegraphs,
    recentKills,
    recentSlurps,
    onlinePlayers: raw.op,
  };
}
