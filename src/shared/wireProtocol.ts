import {
  ArenaSnapshot,
  BigPellet,
  Direction,
  ExtraLifeSaveEvent,
  KillEvent,
  LOOT_BOX_ABILITY_POOL,
  LootBoxItem,
  LootBoxPickupEvent,
  PackedArenaSnapshot,
  PackedExtraLifeSave,
  PackedKill,
  PackedLootBox,
  PackedLootPickup,
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

const PALETTE_INDEX_BY_HEAD = new Map<string, number>(
  SNAKE_PALETTES.map((p, idx) => [p.head, idx])
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
  let cx = 0;
  let cy = 0;

  const parsePair = () => {
    const commaIdx = encoded.indexOf(',', i);
    const colonIdx = encoded.indexOf(':', commaIdx + 1);
    cx = parseInt(encoded.slice(i, commaIdx), 10) || 0;
    cy = parseInt(encoded.slice(commaIdx + 1, colonIdx), 10) || 0;
    i = colonIdx + 1;
  };

  parsePair();
  segs.push({ x: cx, y: cy });

  while (i < n) {
    const ch = encoded.charCodeAt(i);
    if (ch === 59) {
      // ';' non-adjacent jump
      i++;
      parsePair();
    } else {
      i++;
      if (ch === 48) cy -= 1; // '0'
      else if (ch === 49) cy += 1; // '1'
      else if (ch === 50) cx -= 1; // '2'
      else if (ch === 51) cx += 1; // '3'
      // '4' keeps same cell
    }
    segs.push({ x: cx, y: cy });
  }

  return segs;
}

export function isPackedSnapshot(
  data: ArenaSnapshot | PackedArenaSnapshot
): data is PackedArenaSnapshot {
  return (data as PackedArenaSnapshot)?.v === 2;
}

export function packSnapshot(snap: ArenaSnapshot): PackedArenaSnapshot {
  const snakesSrc = snap.snakes;
  const sn: PackedSnake[] = new Array(snakesSrc.length);
  for (let i = 0; i < snakesSrc.length; i++) {
    const s = snakesSrc[i];
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
      const nd: number[] = new Array(s.nextDirs.length);
      for (let d = 0; d < s.nextDirs.length; d++) {
        nd[d] = Math.max(0, DIRS.indexOf(s.nextDirs[d]));
      }
      packed.nd = nd;
    }
    if (typeof s.lastTurnSeq === 'number') {
      packed.ts = s.lastTurnSeq;
    }
    if (s.extraLives > 0) {
      packed.el = s.extraLives;
    }
    if (s.faceId) {
      packed.fId = s.faceId;
    }
    if (s.deathEffectId) {
      packed.de = s.deathEffectId;
    }
    sn[i] = packed;
  }

  let ps = '';
  if (snap.pellets.length > 0) {
    const parts: string[] = new Array(snap.pellets.length);
    for (let i = 0; i < snap.pellets.length; i++) {
      const p = snap.pellets[i];
      const cell = ((p.x << 6) | p.y).toString(36);
      const colIdx = PALETTE_INDEX_BY_HEAD.get(p.color);
      const colStr = colIdx !== undefined ? String(colIdx) : p.color;
      const ttlStr = p.ttlTicks.toString(36);
      if (p.value === 100 && p.growth === 1) {
        parts[i] = `${cell}.${colStr}.${ttlStr}`;
      } else {
        parts[i] = `${cell}.${p.value.toString(36)}.${p.growth.toString(36)}.${colStr}.${ttlStr}`;
      }
    }
    ps = parts.join('|');
  }

  const tl: PackedTelegraph[] = new Array(snap.telegraphs.length);
  for (let i = 0; i < snap.telegraphs.length; i++) {
    const t = snap.telegraphs[i];
    tl[i] = [
      t.id,
      t.x,
      t.y,
      Math.max(0, DIRS.indexOf(t.dir)),
      PALETTE_INDEX_BY_ID.get(t.color.id) ?? t.color.id,
      t.name,
      t.ticksLeft,
      t.isBot ? 1 : 0,
    ];
  }

  const rk: PackedKill[] = new Array(snap.recentKills.length);
  for (let i = 0; i < snap.recentKills.length; i++) {
    const k = snap.recentKills[i];
    rk[i] = k.deathEffectId
      ? [
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
          k.deathEffectId,
        ]
      : [
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
        ];
  }

  const rs: PackedSlurp[] = new Array(snap.recentSlurps.length);
  for (let i = 0; i < snap.recentSlurps.length; i++) {
    const s = snap.recentSlurps[i];
    rs[i] = [s.id, s.tick, s.snakeId, s.fromX, s.fromY, s.toX, s.toY, s.color, s.value];
  }

  const boxesSrc = snap.lootBoxes || [];
  const lb: PackedLootBox[] = new Array(boxesSrc.length);
  for (let i = 0; i < boxesSrc.length; i++) {
    const box = boxesSrc[i];
    lb[i] = [
      box.id,
      box.x,
      box.y,
      Math.max(0, LOOT_BOX_ABILITY_POOL.indexOf(box.ability)),
      box.ttlTicks,
    ];
  }

  const pickupsSrc = snap.recentLootPickups || [];
  const rlp: PackedLootPickup[] = new Array(pickupsSrc.length);
  for (let i = 0; i < pickupsSrc.length; i++) {
    const e = pickupsSrc[i];
    rlp[i] = [
      e.id,
      e.tick,
      e.snakeId,
      e.snakeName,
      e.x,
      e.y,
      Math.max(0, LOOT_BOX_ABILITY_POOL.indexOf(e.ability)),
    ];
  }

  const savesSrc = snap.recentExtraLifeSaves || [];
  const rels: PackedExtraLifeSave[] = new Array(savesSrc.length);
  for (let i = 0; i < savesSrc.length; i++) {
    const e = savesSrc[i];
    rels[i] = [e.id, e.tick, e.snakeId, e.snakeName, e.x, e.y];
  }

  return {
    v: 2,
    t: snap.tick,
    gs: snap.gridSize,
    sn,
    ...(ps ? { ps } : {}),
    ...(lb.length > 0 ? { lb } : {}),
    tl,
    rk,
    rs,
    ...(rlp.length > 0 ? { rlp } : {}),
    ...(rels.length > 0 ? { rels } : {}),
    op: snap.onlinePlayers,
  };
}

export function unpackSnapshot(
  raw: ArenaSnapshot | PackedArenaSnapshot
): ArenaSnapshot {
  if (!isPackedSnapshot(raw)) {
    return raw;
  }

  const snakes: SnakeEntity[] = new Array(raw.sn.length);
  for (let i = 0; i < raw.sn.length; i++) {
    const ps = raw.sn[i];
    const nextDirs: Direction[] = Array.isArray(ps.nd) ? new Array(ps.nd.length) : [];
    if (Array.isArray(ps.nd)) {
      for (let d = 0; d < ps.nd.length; d++) {
        nextDirs[d] = DIRS[ps.nd[d]] || 'RIGHT';
      }
    }
    snakes[i] = {
      id: ps.i,
      name: ps.n,
      color: resolveColorFromCode(ps.c),
      faceId: ps.fId || undefined,
      deathEffectId: ps.de || undefined,
      segments: decodeSegments(ps.g),
      prevSegments: [{ x: ps.px, y: ps.py }],
      dir: DIRS[ps.d] || 'RIGHT',
      nextDirs,
      lastTurnSeq: ps.ts,
      score: ps.s,
      kills: ps.k,
      pelletsSlurped: ps.p,
      alive: (ps.f & 1) !== 0,
      isBot: (ps.f & 2) !== 0,
      autoPilot: (ps.f & 4) !== 0,
      spawnTick: 0,
      shieldTicks: ps.sh,
      extraLives: ps.el || 0,
      deathReason: ps.dr !== undefined ? DEATH_REASONS[ps.dr] : undefined,
      killedByName: ps.kb,
    };
  }

  const pellets: BigPellet[] = [];
  if (typeof raw.ps === 'string' && raw.ps.length > 0) {
    const psStr = raw.ps;
    const psLen = psStr.length;
    let tokStart = 0;
    while (tokStart < psLen) {
      let tokEnd = psStr.indexOf('|', tokStart);
      if (tokEnd < 0) tokEnd = psLen;

      const dot1 = psStr.indexOf('.', tokStart);
      if (dot1 > tokStart && dot1 < tokEnd) {
        const dot2 = psStr.indexOf('.', dot1 + 1);
        if (dot2 > dot1 && dot2 < tokEnd) {
          const dot3 = psStr.indexOf('.', dot2 + 1);
          const cell = parseInt(psStr.slice(tokStart, dot1), 36) || 0;
          const x = cell >> 6;
          const y = cell & 63;

          if (dot3 < 0 || dot3 >= tokEnd) {
            // 3-field compact pellet: cell.col.ttl
            const colRaw = psStr.slice(dot1 + 1, dot2);
            const colIdx = colRaw.charCodeAt(0) === 35 ? -1 : parseInt(colRaw, 10);
            const color =
              colIdx >= 0 && SNAKE_PALETTES[colIdx] ? SNAKE_PALETTES[colIdx].head : colRaw;
            pellets.push({
              id: `p_${cell}`,
              x,
              y,
              value: 100,
              growth: 1,
              color,
              spawnTick: raw.t,
              ttlTicks: parseInt(psStr.slice(dot2 + 1, tokEnd), 36) || 1,
              fromSnakeName: '',
            });
          } else {
            // 5-field pellet: cell.value.growth.col.ttl
            const dot4 = psStr.indexOf('.', dot3 + 1);
            if (dot4 > dot3 && dot4 < tokEnd) {
              const colRaw = psStr.slice(dot3 + 1, dot4);
              const colIdx = colRaw.charCodeAt(0) === 35 ? -1 : parseInt(colRaw, 10);
              const color =
                colIdx >= 0 && SNAKE_PALETTES[colIdx] ? SNAKE_PALETTES[colIdx].head : colRaw;
              pellets.push({
                id: `p_${cell}`,
                x,
                y,
                value: parseInt(psStr.slice(dot1 + 1, dot2), 36) || 100,
                growth: parseInt(psStr.slice(dot2 + 1, dot3), 36) || 1,
                color,
                spawnTick: raw.t,
                ttlTicks: parseInt(psStr.slice(dot4 + 1, tokEnd), 36) || 1,
                fromSnakeName: '',
              });
            }
          }
        }
      }

      tokStart = tokEnd + 1;
    }
  } else if (Array.isArray(raw.pl)) {
    for (let i = 0; i < raw.pl.length; i++) {
      const pp = raw.pl[i];
      pellets.push({
        id: pp[0],
        x: pp[1],
        y: pp[2],
        value: pp[3],
        growth: pp[4],
        color: pp[5],
        spawnTick: raw.t,
        ttlTicks: pp[6],
        fromSnakeName: '',
      });
    }
  }

  const telegraphs: SpawnTelegraph[] = new Array(raw.tl.length);
  for (let i = 0; i < raw.tl.length; i++) {
    const pt = raw.tl[i];
    telegraphs[i] = {
      id: pt[0],
      x: pt[1],
      y: pt[2],
      dir: DIRS[pt[3]] || 'RIGHT',
      color: resolveColorFromCode(pt[4]),
      name: pt[5],
      ticksLeft: pt[6],
      isBot: pt[7] === 1,
    };
  }

  const recentKills: KillEvent[] = new Array(raw.rk.length);
  for (let i = 0; i < raw.rk.length; i++) {
    const pk = raw.rk[i];
    recentKills[i] = {
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
      deathEffectId: pk[11] || undefined,
    };
  }

  const recentSlurps: SlurpEvent[] = new Array(raw.rs.length);
  for (let i = 0; i < raw.rs.length; i++) {
    const ps = raw.rs[i];
    recentSlurps[i] = {
      id: ps[0],
      tick: ps[1],
      snakeId: ps[2],
      fromX: ps[3],
      fromY: ps[4],
      toX: ps[5],
      toY: ps[6],
      color: ps[7],
      value: ps[8],
    };
  }

  const lootBoxes: LootBoxItem[] = Array.isArray(raw.lb) ? new Array(raw.lb.length) : [];
  if (Array.isArray(raw.lb)) {
    for (let i = 0; i < raw.lb.length; i++) {
      const pb = raw.lb[i];
      lootBoxes[i] = {
        id: pb[0],
        x: pb[1],
        y: pb[2],
        ability: LOOT_BOX_ABILITY_POOL[pb[3]] || 'EXTRA_LIFE',
        spawnTick: raw.t,
        ttlTicks: pb[4],
      };
    }
  }

  const recentLootPickups: LootBoxPickupEvent[] = Array.isArray(raw.rlp)
    ? new Array(raw.rlp.length)
    : [];
  if (Array.isArray(raw.rlp)) {
    for (let i = 0; i < raw.rlp.length; i++) {
      const pe = raw.rlp[i];
      recentLootPickups[i] = {
        id: pe[0],
        tick: pe[1],
        snakeId: pe[2],
        snakeName: pe[3],
        x: pe[4],
        y: pe[5],
        ability: LOOT_BOX_ABILITY_POOL[pe[6]] || 'EXTRA_LIFE',
      };
    }
  }

  const recentExtraLifeSaves: ExtraLifeSaveEvent[] = Array.isArray(raw.rels)
    ? new Array(raw.rels.length)
    : [];
  if (Array.isArray(raw.rels)) {
    for (let i = 0; i < raw.rels.length; i++) {
      const ps = raw.rels[i];
      recentExtraLifeSaves[i] = {
        id: ps[0],
        tick: ps[1],
        snakeId: ps[2],
        snakeName: ps[3],
        x: ps[4],
        y: ps[5],
      };
    }
  }

  return {
    tick: raw.t,
    gridSize: raw.gs,
    snakes,
    pellets,
    lootBoxes,
    telegraphs,
    recentKills,
    recentSlurps,
    recentLootPickups,
    recentExtraLifeSaves,
    onlinePlayers: raw.op,
  };
}
