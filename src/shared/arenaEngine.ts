import {
  ArenaSnapshot,
  BigPellet,
  Direction,
  ExtraLifeSaveEvent,
  GRID_SIZE,
  KillEvent,
  LifeTradeOffer,
  LOOT_BOX_ABILITY_POOL,
  LootBoxAbility,
  LootBoxItem,
  LootBoxPickupEvent,
  Point,
  SlurpEvent,
  SNAKE_PALETTES,
  SnakeColor,
  SnakeEntity,
  SPAWN_PROTECTION_TICKS,
  SpawnTelegraph,
} from './gameTypes';

const BOT_CALLSIGNS = [
  'VORTEX_08',
  'KRAIT_X',
  'VIPER_32',
  'COBALT_9',
  'MAMBA_HEX',
  'SIDEWINDER',
  'ADDER_77',
  'TAIPAN_IO',
  'PYRO_BIT',
  'FLUX_04',
  'NEON_FANG',
  'GRID_REAPER',
];

export function isOppositeDirection(a: Direction, b: Direction): boolean {
  if (a === 'UP' && b === 'DOWN') return true;
  if (a === 'DOWN' && b === 'UP') return true;
  if (a === 'LEFT' && b === 'RIGHT') return true;
  if (a === 'RIGHT' && b === 'LEFT') return true;
  return false;
}

export function stepPoint(pt: Point, dir: Direction): Point {
  switch (dir) {
    case 'UP':
      return { x: pt.x, y: pt.y - 1 };
    case 'DOWN':
      return { x: pt.x, y: pt.y + 1 };
    case 'LEFT':
      return { x: pt.x - 1, y: pt.y };
    case 'RIGHT':
      return { x: pt.x + 1, y: pt.y };
  }
}

export function isInsideGrid(pt: Point, gridSize: number = GRID_SIZE): boolean {
  return pt.x >= 0 && pt.x < gridSize && pt.y >= 0 && pt.y < gridSize;
}

export class ArenaEngine {
  public tick = 0;
  public readonly gridSize: number;
  public snakes: Map<string, SnakeEntity> = new Map();
  public pellets: BigPellet[] = [];
  public lootBoxes: LootBoxItem[] = [];
  public telegraphs: SpawnTelegraph[] = [];
  public recentKills: KillEvent[] = [];
  public recentSlurps: SlurpEvent[] = [];
  public recentLootPickups: LootBoxPickupEvent[] = [];
  public recentExtraLifeSaves: ExtraLifeSaveEvent[] = [];
  private botCounter = 0;
  private pelletCounter = 0;
  private lootBoxCounter = 0;
  private killCounter = 0;
  private slurpCounter = 0;
  private lootPickupCounter = 0;
  private extraLifeSaveCounter = 0;
  private nextLootBoxSpawnTick = 65 + Math.floor(Math.random() * 55);
  private targetBotCount = 2;
  private readonly bfsVisited = new Uint8Array(64 * 64);
  private readonly bfsQueue = new Int16Array(64 * 64);
  private readonly botHazardGrid = new Uint8Array(64 * 64);
  private readonly aliveSnakesScratch: SnakeEntity[] = [];
  private readonly humanAnchorsScratch: Point[] = [];
  private readonly nextHeadsScratch: Map<string, Point> = new Map();
  private readonly pendingGrowthScratch: Map<string, number> = new Map();
  private readonly pelletAtCellScratch: Map<number, BigPellet> = new Map();
  private readonly eatenPelletsScratch: Set<BigPellet> = new Set();
  private readonly bodyOwnersScratch: Map<number, SnakeEntity | SnakeEntity[]> = new Map();
  private readonly unshieldedScratch: SnakeEntity[] = [];
  private readonly doomedScratch: Map<
    string,
    {
      reason: 'WALL_CRASH' | 'SELF_CRASH' | 'KILLED_BY_SNAKE' | 'HEAD_COLLISION';
      killer?: SnakeEntity;
    }
  > = new Map();
  private readonly savedByExtraLifeScratch: Set<string> = new Set();
  private readonly collectedBoxIdsScratch: Set<string> = new Set();

  constructor(targetBotCount = 2, gridSize = GRID_SIZE) {
    this.targetBotCount = targetBotCount;
    this.gridSize = gridSize;
    this.seedInitialArena();
  }

  private seedInitialArena() {
    // Keep exactly 2 initial AI snakes on the matrix at all times
    for (let i = 0; i < this.targetBotCount; i++) {
      this.spawnBotImmediate();
    }
  }

  public getColorById(colorId?: string): SnakeColor {
    const found = SNAKE_PALETTES.find((p) => p.id === colorId);
    if (found) return found;
    return SNAKE_PALETTES[Math.floor(Math.random() * SNAKE_PALETTES.length)];
  }

  private getOccupiedSet(): Set<number> {
    const occupied = new Set<number>();
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      for (let i = 0; i < s.segments.length; i++) {
        const seg = s.segments[i];
        occupied.add((seg.x << 8) | seg.y);
      }
    }
    for (let i = 0; i < this.telegraphs.length; i++) {
      const t = this.telegraphs[i];
      occupied.add((t.x << 8) | t.y);
    }
    return occupied;
  }

  /**
   * Finds a safe spawn point on the 32x32 grid.
   * If anchorPoints (like human players) exist, spawns NEARBY (5 to 11 tiles away)
   * so players always have nearby rivals to hunt, cut off, and slurp!
   */
  public findNearbySafeSpawn(preferredAnchors?: Point[]): { x: number; y: number; dir: Direction } {
    const occupied = this.getOccupiedSet();
    const directions: Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

    const anchors =
      preferredAnchors && preferredAnchors.length > 0
        ? preferredAnchors
        : Array.from(this.snakes.values())
            .filter((s) => s.alive && !s.isBot)
            .map((s) => s.segments[0]);

    for (let attempt = 0; attempt < 90; attempt++) {
      let x: number;
      let y: number;

      if (anchors.length > 0 && attempt < 65) {
        const anchor = anchors[attempt % anchors.length];
        const dist = 5 + Math.floor(Math.random() * 7); // 5..11 tiles away from player!
        const angle = Math.random() * Math.PI * 2;
        x = Math.round(anchor.x + Math.cos(angle) * dist);
        y = Math.round(anchor.y + Math.sin(angle) * dist);
        // Clamp within safe interior margin so newborn snakes don't immediately hit the wall
        x = Math.max(4, Math.min(this.gridSize - 5, x));
        y = Math.max(4, Math.min(this.gridSize - 5, y));
      } else {
        x = 4 + Math.floor(Math.random() * (this.gridSize - 8));
        y = 4 + Math.floor(Math.random() * (this.gridSize - 8));
      }

      const dir = directions[Math.floor(Math.random() * directions.length)];
      const oppDir: Direction =
        dir === 'UP' ? 'DOWN' : dir === 'DOWN' ? 'UP' : dir === 'LEFT' ? 'RIGHT' : 'LEFT';

      // Verify head + 3 body segments behind + 3 forward runway tiles are free
      let clear = true;
      let testPt = { x, y };
      for (let i = 0; i < 4; i++) {
        if (!isInsideGrid(testPt, this.gridSize) || occupied.has((testPt.x << 8) | testPt.y)) {
          clear = false;
          break;
        }
        testPt = stepPoint(testPt, oppDir);
      }

      if (!clear) continue;

      let forwardPt = { x, y };
      for (let f = 1; f <= 3; f++) {
        forwardPt = stepPoint(forwardPt, dir);
        if (
          forwardPt.x <= 1 ||
          forwardPt.x >= this.gridSize - 2 ||
          forwardPt.y <= 1 ||
          forwardPt.y >= this.gridSize - 2 ||
          occupied.has((forwardPt.x << 8) | forwardPt.y)
        ) {
          clear = false;
          break;
        }
      }

      if (clear) {
        return { x, y, dir };
      }
    }

    // Fallback safe center-ish coordinate
    return {
      x: Math.max(5, Math.min(this.gridSize - 6, 10 + Math.floor(Math.random() * (this.gridSize - 20)))),
      y: Math.max(5, Math.min(this.gridSize - 6, 10 + Math.floor(Math.random() * (this.gridSize - 20)))),
      dir: 'RIGHT',
    };
  }

  public createSnakeEntity(
    id: string,
    name: string,
    color: SnakeColor,
    spawn: { x: number; y: number; dir: Direction },
    isBot: boolean,
    faceId?: string,
    deathEffectId?: string
  ): SnakeEntity {
    const oppDir: Direction =
      spawn.dir === 'UP'
        ? 'DOWN'
        : spawn.dir === 'DOWN'
          ? 'UP'
          : spawn.dir === 'LEFT'
            ? 'RIGHT'
            : 'LEFT';

    const segments: Point[] = [];
    let curr = { x: spawn.x, y: spawn.y };
    const initialLength = 4;
    for (let i = 0; i < initialLength; i++) {
      segments.push({ ...curr });
      curr = stepPoint(curr, oppDir);
    }

    const styles: Array<'HUNTER' | 'SCAVENGER' | 'INTERCEPTOR' | 'FLANKER'> = [
      'HUNTER',
      'SCAVENGER',
      'INTERCEPTOR',
      'FLANKER',
    ];

    const cleanFaceId =
      typeof faceId === 'string' && faceId.trim() && faceId !== 'default'
        ? faceId.trim().slice(0, 64)
        : undefined;

    const cleanDeathEffectId =
      typeof deathEffectId === 'string' && deathEffectId.trim() && deathEffectId !== 'none'
        ? deathEffectId.trim().slice(0, 80)
        : undefined;

    return {
      id,
      name,
      color,
      faceId: cleanFaceId,
      deathEffectId: cleanDeathEffectId,
      segments,
      prevSegments: [{ ...segments[0] }],
      dir: spawn.dir,
      nextDirs: [],
      score: 0,
      kills: 0,
      pelletsSlurped: 0,
      alive: true,
      isBot,
      spawnTick: this.tick,
      shieldTicks: SPAWN_PROTECTION_TICKS,
      extraLives: 0,
      botStyle: styles[Math.floor(Math.random() * styles.length)],
    };
  }

  public spawnPlayer(
    id: string,
    name: string,
    colorId: string,
    autoPilot?: boolean,
    autoPilotTier?: 'STANDARD' | 'ADMINRY',
    faceId?: string,
    deathEffectId?: string
  ): SnakeEntity {
    const cleanName = (name || 'PLAYER_1').trim().slice(0, 24).toUpperCase() || 'PLAYER_1';
    const color = this.getColorById(colorId);
    const spawn = this.findNearbySafeSpawn();
    const snake = this.createSnakeEntity(id, cleanName, color, spawn, false, faceId, deathEffectId);
    if (autoPilot) {
      snake.autoPilot = true;
      snake.autoPilotTier =
        autoPilotTier || (cleanName.startsWith('ADMINRY') ? 'ADMINRY' : 'STANDARD');
    }
    this.snakes.set(id, snake);
    return snake;
  }

  public setPlayerFace(id: string, faceId?: string) {
    const snake = this.snakes.get(id);
    if (!snake) return;
    snake.faceId =
      typeof faceId === 'string' && faceId.trim() && faceId !== 'default'
        ? faceId.trim().slice(0, 64)
        : undefined;
  }

  public setPlayerDeathEffect(id: string, deathEffectId?: string) {
    const snake = this.snakes.get(id);
    if (!snake) return;
    snake.deathEffectId =
      typeof deathEffectId === 'string' && deathEffectId.trim() && deathEffectId !== 'none'
        ? deathEffectId.trim().slice(0, 80)
        : undefined;
  }

  public spawnBotImmediate(anchors?: Point[]): SnakeEntity {
    this.botCounter++;
    const id = `bot_${this.botCounter}_${Date.now()}`;
    const name = BOT_CALLSIGNS[this.botCounter % BOT_CALLSIGNS.length];
    const palette = SNAKE_PALETTES[(this.botCounter + 1) % SNAKE_PALETTES.length];
    const spawn = this.findNearbySafeSpawn(anchors);
    const bot = this.createSnakeEntity(id, name, palette, spawn, true);
    this.snakes.set(id, bot);
    return bot;
  }

  public queueNearbyBotSpawn(anchors?: Point[], ticksDelay = 5): SpawnTelegraph {
    this.botCounter++;
    const id = `tele_${this.botCounter}_${this.tick}`;
    const name = BOT_CALLSIGNS[this.botCounter % BOT_CALLSIGNS.length];
    const palette = SNAKE_PALETTES[(this.botCounter + 2) % SNAKE_PALETTES.length];
    const spawn = this.findNearbySafeSpawn(anchors);
    const telegraph: SpawnTelegraph = {
      id,
      x: spawn.x,
      y: spawn.y,
      dir: spawn.dir,
      color: palette,
      name,
      ticksLeft: ticksDelay,
      isBot: true,
    };
    this.telegraphs.push(telegraph);
    return telegraph;
  }

  public removePlayer(id: string) {
    this.snakes.delete(id);
  }

  private rollLootBoxAbility(): LootBoxAbility {
    return LOOT_BOX_ABILITY_POOL[Math.floor(Math.random() * LOOT_BOX_ABILITY_POOL.length)];
  }

  private applyLootBoxAbility(snake: SnakeEntity, ability: LootBoxAbility) {
    switch (ability) {
      case 'EXTRA_LIFE':
        snake.extraLives = (snake.extraLives || 0) + 1;
        break;
    }
  }

  private findSafeLootBoxCell(): Point | null {
    const occupied = this.getOccupiedSet();
    for (let i = 0; i < this.pellets.length; i++) {
      const p = this.pellets[i];
      occupied.add((p.x << 8) | p.y);
    }
    for (let i = 0; i < this.lootBoxes.length; i++) {
      const b = this.lootBoxes[i];
      occupied.add((b.x << 8) | b.y);
    }
    const margin = 2;
    const span = Math.max(1, this.gridSize - margin * 2);
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = margin + Math.floor(Math.random() * span);
      const y = margin + Math.floor(Math.random() * span);
      if (!occupied.has((x << 8) | y)) {
        return { x, y };
      }
    }
    return null;
  }

  public giveExtraLife(fromId: string, toId: string): { ok: boolean; reason?: string } {
    const from = this.snakes.get(fromId);
    const to = this.snakes.get(toId);
    if (!from || !from.alive) return { ok: false, reason: 'Your snake must be alive.' };
    if (!to || !to.alive) return { ok: false, reason: 'Target player is not alive.' };
    if (from.id === to.id) return { ok: false, reason: 'Cannot trade with yourself.' };
    if ((from.extraLives || 0) < 1) return { ok: false, reason: 'No extra life available to give.' };

    from.extraLives -= 1;
    to.extraLives = (to.extraLives || 0) + 1;
    return { ok: true };
  }

  public executeLifeTrade(offer: LifeTradeOffer): { ok: boolean; reason?: string } {
    const from = this.snakes.get(offer.fromId);
    const to = this.snakes.get(offer.toId);
    if (!from || !from.alive || !to || !to.alive) {
      return { ok: false, reason: 'Both players must be alive in the arena.' };
    }
    if (from.id === to.id) return { ok: false, reason: 'Cannot trade with yourself.' };
    const giveAmt = Math.max(0, Math.floor(offer.giveAmount));
    const wantAmt = Math.max(0, Math.floor(offer.wantAmount));
    if (giveAmt <= 0 || wantAmt <= 0) {
      return { ok: false, reason: 'Invalid trade amounts.' };
    }

    if (offer.giveType === 'LIFE' && (from.extraLives || 0) < giveAmt) {
      return { ok: false, reason: `${from.name} no longer has ${giveAmt} extra life.` };
    }
    if (offer.giveType === 'SCORE' && from.score < giveAmt) {
      return { ok: false, reason: `${from.name} no longer has ${giveAmt} score.` };
    }
    if (offer.wantType === 'LIFE' && (to.extraLives || 0) < wantAmt) {
      return { ok: false, reason: `${to.name} no longer has ${wantAmt} extra life.` };
    }
    if (offer.wantType === 'SCORE' && to.score < wantAmt) {
      return { ok: false, reason: `${to.name} no longer has ${wantAmt} score.` };
    }

    if (offer.giveType === 'LIFE') {
      from.extraLives -= giveAmt;
      to.extraLives = (to.extraLives || 0) + giveAmt;
    } else {
      from.score -= giveAmt;
      to.score += giveAmt;
    }

    if (offer.wantType === 'LIFE') {
      to.extraLives -= wantAmt;
      from.extraLives = (from.extraLives || 0) + wantAmt;
    } else {
      to.score -= wantAmt;
      from.score += wantAmt;
    }

    return { ok: true };
  }

  public floodScreenWithPellets(): number {
    const gs = this.gridSize;
    const occupied = new Uint8Array(gs * gs);

    for (const snake of this.snakes.values()) {
      if (!snake.alive) continue;
      for (let i = 0; i < snake.segments.length; i++) {
        const seg = snake.segments[i];
        if (seg.x >= 0 && seg.x < gs && seg.y >= 0 && seg.y < gs) {
          occupied[seg.y * gs + seg.x] = 1;
        }
      }
    }

    for (let i = 0; i < this.pellets.length; i++) {
      const p = this.pellets[i];
      if (p.x >= 0 && p.x < gs && p.y >= 0 && p.y < gs) {
        occupied[p.y * gs + p.x] = 1;
      }
    }

    for (let i = 0; i < this.lootBoxes.length; i++) {
      const b = this.lootBoxes[i];
      if (b.x >= 0 && b.x < gs && b.y >= 0 && b.y < gs) {
        occupied[b.y * gs + b.x] = 1;
      }
    }

    let spawned = 0;
    const paletteCount = SNAKE_PALETTES.length;
    for (let y = 0; y < gs; y++) {
      const rowOffset = y * gs;
      for (let x = 0; x < gs; x++) {
        if (occupied[rowOffset + x]) continue;
        this.pelletCounter++;
        spawned++;
        const palette = SNAKE_PALETTES[(x + y) % paletteCount];
        this.pellets.push({
          id: `f${this.pelletCounter}`,
          x,
          y,
          value: 100,
          growth: 1,
          color: palette.head,
          spawnTick: this.tick,
          ttlTicks: 165,
          fromSnakeName: 'ADMINRY',
        });
      }
    }

    return spawned;
  }

  public clearAllPellets(): number {
    const removed = this.pellets.length;
    this.pellets = [];
    return removed;
  }

  public adminGiveExtraLives(
    targetPlayerId: string,
    delta: number
  ): { ok: boolean; updatedCount: number; targetName?: string; newLives?: number } {
    const cleanDelta = Math.trunc(delta);
    if (!Number.isFinite(cleanDelta) || cleanDelta === 0) {
      return { ok: false, updatedCount: 0 };
    }

    if (targetPlayerId === '*') {
      let updatedCount = 0;
      for (const s of this.snakes.values()) {
        if (!s.alive || s.isBot) continue;
        s.extraLives = Math.max(0, Math.min(999, (s.extraLives || 0) + cleanDelta));
        updatedCount++;
      }
      return { ok: updatedCount > 0, updatedCount, targetName: 'ALL PLAYERS' };
    }

    const snake = this.snakes.get(targetPlayerId);
    if (!snake || !snake.alive) {
      return { ok: false, updatedCount: 0 };
    }
    snake.extraLives = Math.max(0, Math.min(999, (snake.extraLives || 0) + cleanDelta));
    return {
      ok: true,
      updatedCount: 1,
      targetName: snake.name,
      newLives: snake.extraLives,
    };
  }

  public setAutopilot(id: string, enabled: boolean, tier?: 'STANDARD' | 'ADMINRY') {
    const snake = this.snakes.get(id);
    if (!snake || !snake.alive) return;
    snake.autoPilot = enabled;
    snake.autoPilotTier = enabled
      ? tier || (snake.name.trim().toUpperCase().startsWith('ADMINRY') ? 'ADMINRY' : 'STANDARD')
      : undefined;
    if (enabled) {
      snake.nextDirs = [];
    }
  }

  public queueTurn(id: string, requestedDir: Direction, seq?: number) {
    const snake = this.snakes.get(id);
    if (!snake || !snake.alive) return;

    if (typeof seq === 'number') {
      snake.lastTurnSeq = seq;
    }

    if (snake.autoPilot) {
      snake.autoPilot = false;
      snake.autoPilotTier = undefined;
      snake.nextDirs = [];
    }

    const lastScheduledDir =
      snake.nextDirs.length > 0 ? snake.nextDirs[snake.nextDirs.length - 1] : snake.dir;

    if (requestedDir === lastScheduledDir) {
      return;
    }

    if (snake.nextDirs.length < 4) {
      snake.nextDirs.push(requestedDir);
    }
  }

  private dropBigFlashingPellets(victim: SnakeEntity, fallbackHead?: Point) {
    // O(1) spatial map of existing pellets so even a long snake drops pellets cleanly
    const pelletByCell = this.pelletAtCellScratch;
    pelletByCell.clear();
    for (let i = 0; i < this.pellets.length; i++) {
      const p = this.pellets[i];
      pelletByCell.set((p.x << 8) | p.y, p);
    }

    const count = victim.segments.length;
    for (let i = 0; i < count; i++) {
      const rawSeg = victim.segments[i];
      const seg = isInsideGrid(rawSeg, this.gridSize) ? rawSeg : fallbackHead;
      if (!seg || !isInsideGrid(seg, this.gridSize)) continue;

      const key = (seg.x << 8) | seg.y;
      const existing = pelletByCell.get(key);
      if (existing) {
        existing.value += 120;
        existing.growth = Math.min(3, existing.growth + 1);
        existing.ttlTicks = 130;
        continue;
      }

      this.pelletCounter++;
      const isHeadTrophy = i === 0;
      const created: BigPellet = {
        id: `pellet_${this.pelletCounter}_${this.tick}`,
        x: seg.x,
        y: seg.y,
        value: isHeadTrophy ? 250 : 125,
        growth: 1,
        color: victim.color.head,
        spawnTick: this.tick,
        ttlTicks: 135, // ~15.5 seconds of flashing before expiring
        fromSnakeName: victim.name,
      };
      this.pellets.push(created);
      pelletByCell.set(key, created);
    }
    pelletByCell.clear();
  }

  private computeBotDirection(bot: SnakeEntity): Direction {
    const gs = this.gridSize;
    const head = bot.segments[0];
    const allDirs: Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

    // Human-like reaction delay: if continuing straight stays inside the grid,
    // the bot often stays committed to its current heading instead of frame-perfectly dodging.
    let straightX = head.x;
    let straightY = head.y;
    if (bot.dir === 'UP') straightY--;
    else if (bot.dir === 'DOWN') straightY++;
    else if (bot.dir === 'LEFT') straightX--;
    else straightX++;

    if (
      straightX >= 1 &&
      straightX < gs - 1 &&
      straightY >= 1 &&
      straightY < gs - 1 &&
      Math.random() < 0.62
    ) {
      return bot.dir;
    }

    // Reuse bitmap for the 3 candidate neighbor cells around the bot's head (zero Set/Point allocations)
    const hazardGrid = this.botHazardGrid;
    hazardGrid.fill(0, 0, gs * gs);
    for (const other of this.snakes.values()) {
      if (!other.alive || other.id === bot.id) continue;
      // Ignore segments 0, 1, 2 (the head and front body of a snake cutting in front of the AI)
      const segs = other.segments;
      for (let i = 3, len = segs.length - 1; i < len; i++) {
        const seg = segs[i];
        if (Math.abs(seg.x - head.x) <= 1 && Math.abs(seg.y - head.y) <= 1) {
          hazardGrid[seg.y * gs + seg.x] = 1;
        }
      }
    }

    // Score each candidate direction
    let bestDir = bot.dir;
    let bestScore = -999999;

    // Find closest human player or flashing pellet to gravitate toward
    let targetX = -1;
    let targetY = -1;
    let minTargetDist = 999;

    // 1. Prioritize nearby flashing big pellets if any exist within 12 tiles
    for (let i = 0; i < this.pellets.length; i++) {
      const p = this.pellets[i];
      const d = Math.abs(p.x - head.x) + Math.abs(p.y - head.y);
      if (d < minTargetDist && d <= 12) {
        minTargetDist = d;
        targetX = p.x;
        targetY = p.y;
      }
    }

    // 2. Otherwise cruise near human players so players have plenty of opportunities to cut them off
    if (targetX < 0) {
      for (const s of this.snakes.values()) {
        if (!s.alive || s.id === bot.id) continue;
        const targetSeg = s.segments[0];
        const dist = Math.abs(targetSeg.x - head.x) + Math.abs(targetSeg.y - head.y);
        const weight = s.isBot ? dist * 1.35 : dist * 0.75;
        if (weight < minTargetDist) {
          minTargetDist = weight;
          targetX = targetSeg.x;
          targetY = targetSeg.y;
        }
      }
    }

    const hasTarget = targetX >= 0;
    const currDist = hasTarget ? Math.abs(targetX - head.x) + Math.abs(targetY - head.y) : 0;

    for (let dIdx = 0; dIdx < 4; dIdx++) {
      const dir = allDirs[dIdx];
      if (isOppositeDirection(dir, bot.dir)) continue;

      let nx = head.x;
      let ny = head.y;
      if (dir === 'UP') ny--;
      else if (dir === 'DOWN') ny++;
      else if (dir === 'LEFT') nx--;
      else nx++;

      // Immediate outer wall check
      if (nx < 0 || nx >= gs || ny < 0 || ny >= gs) {
        continue;
      }

      let score = 0;

      // Delayed reaction to another snake's older trail: 50% chance the AI notices it late
      if (hazardGrid[ny * gs + nx] === 1) {
        if (Math.random() < 0.5) {
          score -= 140;
        }
      }

      // Keep buffer from the unforgiving outer wall so bots don't die to walls on their own
      const wallDist = Math.min(nx, gs - 1 - nx, ny, gs - 1 - ny);
      if (wallDist === 0) score -= 65;
      else if (wallDist === 1) score -= 18;

      // Move toward target (pellet or player area)
      if (hasTarget) {
        const nextDist = Math.abs(targetX - nx) + Math.abs(targetY - ny);
        if (nextDist < currDist) {
          score += 26;
        } else {
          score -= 8;
        }
      }

      // Strong straight-line momentum so bots don't twitch-dodge every tick
      if (dir === bot.dir) {
        score += 32;
      }

      // Add organic variance
      score += (Math.random() - 0.5) * 16;

      if (score > bestScore) {
        bestScore = score;
        bestDir = dir;
      }
    }

    return bestDir;
  }

  /**
   * Smart survival AI for Admin Menu Autopilot: strictly avoids outer walls, rival trails,
   * dead-end pockets, and rival head collisions while cruising safely for pellets.
   */
  private computeAutopilotDirection(snake: SnakeEntity): Direction {
    const head = snake.segments[0];
    const allDirs: Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
    const validDirs = allDirs.filter((d) => !isOppositeDirection(d, snake.dir));

    // Exact hazard lookup of unshielded rival snake segments & predicted head danger zones
    const rivalCells = new Set<number>();
    const rivalHeadDanger = new Set<number>();
    const isSelfShielded = snake.shieldTicks > 0;

    if (!isSelfShielded) {
      for (const other of this.snakes.values()) {
        if (!other.alive || other.id === snake.id || other.shieldTicks > 0) continue;
        const segs = other.segments;
        for (let i = 0; i < segs.length; i++) {
          rivalCells.add((segs[i].x << 8) | segs[i].y);
        }
        // Mark the cell directly in front of a rival head as risky
        if (segs[0]) {
          const rivalNext = stepPoint(segs[0], other.dir);
          if (isInsideGrid(rivalNext, this.gridSize)) {
            rivalHeadDanger.add((rivalNext.x << 8) | rivalNext.y);
          }
        }
      }
    }

    // Closest safe pellet within 10 tiles for gentle cruising attraction
    let nearestPellet: Point | null = null;
    let minPelletDist = 11;
    for (let i = 0; i < this.pellets.length; i++) {
      const p = this.pellets[i];
      if (rivalCells.has((p.x << 8) | p.y)) continue;
      const dist = Math.abs(p.x - head.x) + Math.abs(p.y - head.y);
      if (dist < minPelletDist) {
        minPelletDist = dist;
        nearestPellet = p;
      }
    }

    let bestDir = validDirs[0] || snake.dir;
    let bestScore = -9999999;

    for (const dir of validDirs) {
      const nextPt = stepPoint(head, dir);
      if (!isInsideGrid(nextPt, this.gridSize)) {
        continue; // Never walk off the outer wall
      }

      const key = (nextPt.x << 8) | nextPt.y;
      let score = 0;

      if (rivalCells.has(key)) {
        score -= 50000;
      } else if (rivalHeadDanger.has(key)) {
        score -= 450;
      }

      // 2-step lookahead so autopilot never boxes itself into a dead-end corner
      let safeExits = 0;
      for (const d2 of allDirs) {
        if (isOppositeDirection(d2, dir)) continue;
        const step2 = stepPoint(nextPt, d2);
        if (!isInsideGrid(step2, this.gridSize)) continue;
        if (!rivalCells.has((step2.x << 8) | step2.y)) {
          safeExits++;
        }
      }
      if (safeExits === 0) score -= 5000;
      else if (safeExits === 1) score -= 140;
      else score += safeExits * 25;

      // Strong outer-wall cushion so it smoothly turns inward well before the edge
      const wallDist = Math.min(
        nextPt.x,
        this.gridSize - 1 - nextPt.x,
        nextPt.y,
        this.gridSize - 1 - nextPt.y
      );
      if (wallDist === 0) score -= 350;
      else if (wallDist === 1) score -= 90;
      else if (wallDist >= 3) score += 45;

      // Safe pellet cruising bonus
      if (nearestPellet) {
        const currDist = Math.abs(nearestPellet.x - head.x) + Math.abs(nearestPellet.y - head.y);
        const nextDist =
          Math.abs(nearestPellet.x - nextPt.x) + Math.abs(nearestPellet.y - nextPt.y);
        if (nextDist < currDist) score += 28;
      }

      // Slight momentum preference so movement feels smooth rather than jittering
      if (dir === snake.dir) {
        score += 14;
      }

      score += (Math.random() - 0.5) * 4;

      if (score > bestScore) {
        bestScore = score;
        bestDir = dir;
      }
    }

      return bestDir;
    }

  /**
   * Fast zero-allocation BFS flood fill counting reachable safe cells from `start`.
   */
  private countReachableSpace(
    start: Point,
    blockedGrid: Uint8Array,
    maxCells: number
  ): number {
    const gs = this.gridSize;
    if (start.x < 0 || start.x >= gs || start.y < 0 || start.y >= gs) return 0;
    const startIdx = start.y * gs + start.x;
    if (blockedGrid[startIdx] === 1) return 0;

    this.bfsVisited.fill(0, 0, gs * gs);
    let headIdx = 0;
    let tailIdx = 0;
    this.bfsVisited[startIdx] = 1;
    this.bfsQueue[tailIdx++] = startIdx;

    while (headIdx < tailIdx && tailIdx < maxCells) {
      const curr = this.bfsQueue[headIdx++];
      const cx = curr % gs;
      const cy = (curr - cx) / gs;

      if (cx > 0) {
        const n = curr - 1;
        if (this.bfsVisited[n] === 0 && blockedGrid[n] === 0) {
          this.bfsVisited[n] = 1;
          this.bfsQueue[tailIdx++] = n;
          if (tailIdx >= maxCells) break;
        }
      }
      if (cx + 1 < gs) {
        const n = curr + 1;
        if (this.bfsVisited[n] === 0 && blockedGrid[n] === 0) {
          this.bfsVisited[n] = 1;
          this.bfsQueue[tailIdx++] = n;
          if (tailIdx >= maxCells) break;
        }
      }
      if (cy > 0) {
        const n = curr - gs;
        if (this.bfsVisited[n] === 0 && blockedGrid[n] === 0) {
          this.bfsVisited[n] = 1;
          this.bfsQueue[tailIdx++] = n;
          if (tailIdx >= maxCells) break;
        }
      }
      if (cy + 1 < gs) {
        const n = curr + gs;
        if (this.bfsVisited[n] === 0 && blockedGrid[n] === 0) {
          this.bfsVisited[n] = 1;
          this.bfsQueue[tailIdx++] = n;
          if (tailIdx >= maxCells) break;
        }
      }
    }

    return tailIdx;
  }

  /**
   * Extra-powerful ADMINRY Apex Predator AI:
   * - Full BFS flood-fill territory check to avoid enclosed dead-end loops
   * - Exploits head-on length advantage (+500 takedowns on shorter rivals)
   * - Predicts & intercepts rival paths to force cut-off eliminations
   * - Sweeps high-value flashing pellet clusters & exploits spawn shield safely
   */
  private computeAdminRyAutopilotDirection(snake: SnakeEntity): Direction {
    const gs = this.gridSize;
    const head = snake.segments[0];
    const allDirs: Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
    const validDirs = allDirs.filter((d) => !isOppositeDirection(d, snake.dir));
    const myLen = snake.segments.length;
    const isShieldInvulnerable = snake.shieldTicks > 2;

    const blockedGrid = new Uint8Array(gs * gs);
    const riskyHeadCells = new Set<number>();
    const killHeadCells = new Set<number>();
    const rivalTargets: Array<{ pt: Point; dist: number; canKillHeadOn: boolean }> = [];

    for (const other of this.snakes.values()) {
      if (!other.alive || other.id === snake.id) continue;
      const otherSegs = other.segments;
      const otherHead = otherSegs[0];
      const otherShielded = other.shieldTicks > 0;

      if (!isShieldInvulnerable && !otherShielded) {
        for (let i = 0; i < otherSegs.length; i++) {
          const seg = otherSegs[i];
          if (seg.x >= 0 && seg.x < gs && seg.y >= 0 && seg.y < gs) {
            blockedGrid[seg.y * gs + seg.x] = 1;
          }
        }

        if (otherHead) {
          const canWinHeadOn = myLen > otherSegs.length;
          for (const d of allDirs) {
            if (isOppositeDirection(d, other.dir)) continue;
            const nh = stepPoint(otherHead, d);
            if (!isInsideGrid(nh, gs)) continue;
            const nKey = (nh.x << 8) | nh.y;
            if (canWinHeadOn && d === other.dir) {
              killHeadCells.add(nKey);
            } else if (!canWinHeadOn) {
              riskyHeadCells.add(nKey);
            }
          }
        }
      }

      // Compute aggressive cut-off intercept point 2-3 steps ahead of rival snake
      if (otherHead && (!otherShielded || other.shieldTicks <= 3)) {
        const dist = Math.abs(otherHead.x - head.x) + Math.abs(otherHead.y - head.y);
        let intercept = { x: otherHead.x, y: otherHead.y };
        const leadSteps = dist <= 5 ? 2 : 3;
        for (let s = 0; s < leadSteps; s++) {
          const stepped = stepPoint(intercept, other.dir);
          if (isInsideGrid(stepped, gs)) {
            intercept = stepped;
          } else {
            break;
          }
        }
        rivalTargets.push({
          pt: intercept,
          dist,
          canKillHeadOn: !otherShielded && myLen > otherSegs.length,
        });
      }
    }

    // Build O(1) pellet map for instant slurp-radius scoring and find highest-value safe pellet target
    const pelletCellValues = new Map<number, number>();
    let bestPelletTarget: Point | null = null;
    let bestPelletScore = -999999;

    for (let i = 0; i < this.pellets.length; i++) {
      const p = this.pellets[i];
      if (p.x < 0 || p.x >= gs || p.y < 0 || p.y >= gs) continue;
      const idx = p.y * gs + p.x;
      if (blockedGrid[idx] === 1) continue;
      pelletCellValues.set((p.x << 8) | p.y, p.value);

      const dist = Math.abs(p.x - head.x) + Math.abs(p.y - head.y);
      const edgePenalty =
        p.x === 0 || p.x === gs - 1 || p.y === 0 || p.y === gs - 1 ? 0.55 : 1;
      const pScore = ((p.value * edgePenalty) / (dist + 1.5)) * (1 + p.growth * 0.25);
      if (pScore > bestPelletScore) {
        bestPelletScore = pScore;
        bestPelletTarget = p;
      }
    }

    // Choose nearest strong cut-off prey
    rivalTargets.sort((a, b) => a.dist - b.dist);
    const primaryPrey = rivalTargets[0] || null;

    const desiredSpace = Math.min(Math.max(36, myLen * 2), 140);
    let bestDir = validDirs[0] || snake.dir;
    let bestScore = -99999999;

    for (const dir of validDirs) {
      const nextPt = stepPoint(head, dir);
      if (!isInsideGrid(nextPt, gs)) {
        continue; // Never step off outer boundary
      }

      const nextIdx = nextPt.y * gs + nextPt.x;
      const nextKey = (nextPt.x << 8) | nextPt.y;
      let score = 0;

      // 1. Absolute lethality & head-on contest evaluation
      if (blockedGrid[nextIdx] === 1) {
        score -= 1_000_000;
      } else if (riskyHeadCells.has(nextKey)) {
        score -= 18_000;
      } else if (killHeadCells.has(nextKey)) {
        score += 420; // Actively crush shorter rival head-on for +500 takedown!
      }

      // 2. Flood-fill territory reachability (prevents traps & enclosed loops)
      const reachable = this.countReachableSpace(nextPt, blockedGrid, desiredSpace);
      if (reachable < 8) {
        score -= 90_000 + (8 - reachable) * 4000;
      } else if (reachable < Math.min(28, myLen + 8)) {
        score -= 6500 + (32 - reachable) * 180;
      } else {
        score += Math.min(desiredSpace, reachable) * 4.5;
      }

      // 3. 2-step & adjacent escape corridor count
      let safeExits = 0;
      for (const d2 of allDirs) {
        if (isOppositeDirection(d2, dir)) continue;
        const step2 = stepPoint(nextPt, d2);
        if (!isInsideGrid(step2, gs)) continue;
        if (blockedGrid[step2.y * gs + step2.x] === 0) {
          safeExits++;
        }
      }
      if (safeExits === 0) score -= 55_000;
      else if (safeExits === 1) score -= 220;
      else score += safeExits * 35;

      // 4. Instant slurp-radius pellet vacuuming (head + 4 cardinal neighbors)
      let instantPelletGain = 0;
      const slurpCheck = [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      for (let o = 0; o < 5; o++) {
        const px = nextPt.x + slurpCheck[o][0];
        const py = nextPt.y + slurpCheck[o][1];
        if (px < 0 || px >= gs || py < 0 || py >= gs) continue;
        const val = pelletCellValues.get((px << 8) | py);
        if (val) instantPelletGain += val;
      }
      if (instantPelletGain > 0 && reachable >= 14) {
        score += Math.min(360, instantPelletGain * 0.9);
      }

      // 5. High-value pellet homing vs aggressive rival cut-off hunting
      if (bestPelletTarget) {
        const currDist = Math.abs(bestPelletTarget.x - head.x) + Math.abs(bestPelletTarget.y - head.y);
        const nextDist =
          Math.abs(bestPelletTarget.x - nextPt.x) + Math.abs(bestPelletTarget.y - nextPt.y);
        const pelletUrgency = bestPelletScore > 25 ? 78 : 48;
        if (nextDist < currDist) score += pelletUrgency;
        else score -= 12;
      }

      if (primaryPrey && primaryPrey.dist <= 16) {
        const currPreyDist =
          Math.abs(primaryPrey.pt.x - head.x) + Math.abs(primaryPrey.pt.y - head.y);
        const nextPreyDist =
          Math.abs(primaryPrey.pt.x - nextPt.x) + Math.abs(primaryPrey.pt.y - nextPt.y);
        const huntWeight =
          isShieldInvulnerable || primaryPrey.canKillHeadOn
            ? 88
            : bestPelletTarget && bestPelletScore > 40
              ? 28
              : 54;
        if (nextPreyDist < currPreyDist) score += huntWeight;
      }

      // 6. Outer-wall cushion & center-arena dominance when cruising
      const wallDist = Math.min(nextPt.x, gs - 1 - nextPt.x, nextPt.y, gs - 1 - nextPt.y);
      if (wallDist === 0) score -= 420;
      else if (wallDist === 1) score -= 95;
      else if (wallDist >= 3) score += 35;

      // Smooth straight-line momentum to prevent erratic twitching
      if (dir === snake.dir) {
        score += 16;
      }

      if (score > bestScore) {
        bestScore = score;
        bestDir = dir;
      }
    }

    return bestDir;
  }

  public step(): ArenaSnapshot {
    this.tick++;

    // 1. Advance spawn telegraphs in-place
    let writeTele = 0;
    let queuedBotTelegraphs = 0;
    for (let i = 0; i < this.telegraphs.length; i++) {
      const tele = this.telegraphs[i];
      tele.ticksLeft--;
      if (tele.ticksLeft <= 0) {
        const id = `bot_${++this.botCounter}_${this.tick}`;
        const bot = this.createSnakeEntity(
          id,
          tele.name,
          tele.color,
          { x: tele.x, y: tele.y, dir: tele.dir },
          true
        );
        this.snakes.set(id, bot);
      } else {
        this.telegraphs[writeTele++] = tele;
        if (tele.isBot) queuedBotTelegraphs++;
      }
    }
    this.telegraphs.length = writeTele;

    // 2. Collect alive snakes, human anchors, and bot counts in a single pass
    const aliveSnakes = this.aliveSnakesScratch;
    const humanAnchors = this.humanAnchorsScratch;
    aliveSnakes.length = 0;
    humanAnchors.length = 0;
    let aliveBotsCount = 0;

    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      aliveSnakes.push(s);
      if (s.isBot) {
        aliveBotsCount++;
      } else if (s.segments[0]) {
        humanAnchors.push(s.segments[0]);
      }
    }

    while (aliveBotsCount + queuedBotTelegraphs < this.targetBotCount) {
      this.queueNearbyBotSpawn(humanAnchors, 5);
      queuedBotTelegraphs++;
    }

    // 2b. Occasionally spawn a collectible Loot Box on a safe interior cell
    if (this.tick >= this.nextLootBoxSpawnTick) {
      const maxBoxes = this.gridSize >= 64 ? 2 : 1;
      if (this.lootBoxes.length < maxBoxes) {
        const cell = this.findSafeLootBoxCell();
        if (cell) {
          this.lootBoxCounter++;
          this.lootBoxes.push({
            id: `loot_${this.lootBoxCounter}_${this.tick}`,
            x: cell.x,
            y: cell.y,
            ability: this.rollLootBoxAbility(),
            spawnTick: this.tick,
            ttlTicks: 220,
          });
        }
      }
      this.nextLootBoxSpawnTick = this.tick + 115 + Math.floor(Math.random() * 80);
    }

    // 3. Determine next direction & next head position for each alive snake
    const nextHeads = this.nextHeadsScratch;
    nextHeads.clear();

    for (let sIdx = 0; sIdx < aliveSnakes.length; sIdx++) {
      const snake = aliveSnakes[sIdx];
      const currHead = snake.segments[0];
      if (snake.prevSegments.length > 0 && snake.prevSegments[0]) {
        snake.prevSegments[0].x = currHead.x;
        snake.prevSegments[0].y = currHead.y;
        snake.prevSegments.length = 1;
      } else {
        snake.prevSegments = [{ x: currHead.x, y: currHead.y }];
      }

      if (snake.isBot) {
        const chosen = this.computeBotDirection(snake);
        if (!isOppositeDirection(chosen, snake.dir)) {
          snake.dir = chosen;
        }
      } else if (snake.autoPilot) {
        const isApexAdminRy =
          snake.autoPilotTier === 'ADMINRY' ||
          snake.name.trim().toUpperCase().startsWith('ADMINRY');
        const chosen = isApexAdminRy
          ? this.computeAdminRyAutopilotDirection(snake)
          : this.computeAutopilotDirection(snake);
        if (!isOppositeDirection(chosen, snake.dir)) {
          snake.dir = chosen;
        }
      } else if (snake.nextDirs.length > 0) {
        snake.dir = snake.nextDirs.shift()!;
      }

      nextHeads.set(snake.id, stepPoint(currHead, snake.dir));
    }

    // 4. Advance snake segments provisionally & check pellet slurping in O(1) per snake via spatial cell map
    const pendingGrowth = this.pendingGrowthScratch;
    pendingGrowth.clear();

    if (this.pellets.length > 0) {
      const pelletAtCell = this.pelletAtCellScratch;
      pelletAtCell.clear();
      for (let i = 0; i < this.pellets.length; i++) {
        const p = this.pellets[i];
        pelletAtCell.set((p.x << 8) | p.y, p);
      }

      const eatenPellets = this.eatenPelletsScratch;
      eatenPellets.clear();

      for (let sIdx = 0; sIdx < aliveSnakes.length; sIdx++) {
        const snake = aliveSnakes[sIdx];
        const nextHead = nextHeads.get(snake.id)!;
        let growAmount = 0;

        for (let o = 0; o < 5; o++) {
          const px =
            o === 1 ? nextHead.x + 1 : o === 2 ? nextHead.x - 1 : nextHead.x;
          const py =
            o === 3 ? nextHead.y + 1 : o === 4 ? nextHead.y - 1 : nextHead.y;
          if (px < 0 || px >= this.gridSize || py < 0 || py >= this.gridSize) continue;
          const pellet = pelletAtCell.get((px << 8) | py);
          if (pellet && !eatenPellets.has(pellet)) {
            eatenPellets.add(pellet);
            pelletAtCell.delete((px << 8) | py);

            snake.score += pellet.value;
            snake.pelletsSlurped += 1;
            growAmount += pellet.growth;

            this.slurpCounter++;
            this.recentSlurps.push({
              id: `slurp_${this.slurpCounter}_${this.tick}`,
              tick: this.tick,
              snakeId: snake.id,
              fromX: pellet.x,
              fromY: pellet.y,
              toX: nextHead.x,
              toY: nextHead.y,
              color: pellet.color,
              value: pellet.value,
            });
          }
        }
        pendingGrowth.set(snake.id, growAmount);
      }

      if (eatenPellets.size > 0) {
        let writePellet = 0;
        for (let i = 0; i < this.pellets.length; i++) {
          const p = this.pellets[i];
          if (!eatenPellets.has(p)) {
            this.pellets[writePellet++] = p;
          }
        }
        this.pellets.length = writePellet;
        eatenPellets.clear();
      }
      pelletAtCell.clear();
    } else {
      for (let sIdx = 0; sIdx < aliveSnakes.length; sIdx++) {
        pendingGrowth.set(aliveSnakes[sIdx].id, 0);
      }
    }

    // 4b. Collect Loot Boxes when a snake's head lands on a crate cell
    if (this.lootBoxes.length > 0) {
      const collectedBoxIds = this.collectedBoxIdsScratch;
      collectedBoxIds.clear();
      for (let sIdx = 0; sIdx < aliveSnakes.length; sIdx++) {
        const snake = aliveSnakes[sIdx];
        const nextHead = nextHeads.get(snake.id)!;
        for (let b = 0; b < this.lootBoxes.length; b++) {
          const box = this.lootBoxes[b];
          if (collectedBoxIds.has(box.id)) continue;
          if (nextHead.x === box.x && nextHead.y === box.y) {
            collectedBoxIds.add(box.id);
            this.applyLootBoxAbility(snake, box.ability);
            this.lootPickupCounter++;
            this.recentLootPickups.push({
              id: `lpick_${this.lootPickupCounter}_${this.tick}`,
              tick: this.tick,
              snakeId: snake.id,
              snakeName: snake.name,
              x: box.x,
              y: box.y,
              ability: box.ability,
            });
          }
        }
      }
      if (collectedBoxIds.size > 0) {
        let writeBox = 0;
        for (let i = 0; i < this.lootBoxes.length; i++) {
          const b = this.lootBoxes[i];
          if (!collectedBoxIds.has(b.id)) {
            this.lootBoxes[writeBox++] = b;
          }
        }
        this.lootBoxes.length = writeBox;
        collectedBoxIds.clear();
      }
    }

    // Move segments forward
    for (let sIdx = 0; sIdx < aliveSnakes.length; sIdx++) {
      const snake = aliveSnakes[sIdx];
      const nextHead = nextHeads.get(snake.id)!;
      const grow = pendingGrowth.get(snake.id) || 0;
      snake.segments.unshift(nextHead);
      if (grow === 0) {
        snake.segments.pop();
      } else {
        const tailTip = snake.segments[snake.segments.length - 1];
        for (let g = 1; g < grow; g++) {
          snake.segments.push({ x: tailTip.x, y: tailTip.y });
        }
      }
    }

    // 5. Evaluate unforgiving collisions in O(totalSegments) using reusable spatial lookup maps
    const doomed = this.doomedScratch;
    doomed.clear();

    const bodyOwners = this.bodyOwnersScratch;
    bodyOwners.clear();
    const unshieldedSnakes = this.unshieldedScratch;
    unshieldedSnakes.length = 0;

    for (let sIdx = 0; sIdx < aliveSnakes.length; sIdx++) {
      const other = aliveSnakes[sIdx];
      if (other.shieldTicks > 0) continue;
      unshieldedSnakes.push(other);
      const otherSegs = other.segments;
      for (let i = 1, len = otherSegs.length; i < len; i++) {
        const seg = otherSegs[i];
        const key = (seg.x << 8) | seg.y;
        const existing = bodyOwners.get(key);
        if (!existing) {
          bodyOwners.set(key, other);
        } else if (Array.isArray(existing)) {
          if (!existing.includes(other)) existing.push(other);
        } else if (existing !== other) {
          bodyOwners.set(key, [existing, other]);
        }
      }
    }

    const savedByExtraLife = this.savedByExtraLifeScratch;
    savedByExtraLife.clear();

    for (let sIdx = 0; sIdx < aliveSnakes.length; sIdx++) {
      const snake = aliveSnakes[sIdx];
      const head = snake.segments[0];

      // A. Unforgiving Grid Boundary Check
      if (!isInsideGrid(head, this.gridSize)) {
        doomed.set(snake.id, { reason: 'WALL_CRASH' });
        continue;
      }

      // B. Self-overlap is allowed! Snakes can freely pass over their own tail/body.

      // C. Other snakes check
      if (snake.shieldTicks > 0) {
        continue;
      }

      const myPrevHead = snake.prevSegments[0] || head;

      for (let u = 0; u < unshieldedSnakes.length; u++) {
        const other = unshieldedSnakes[u];
        if (other.id === snake.id) continue;
        const otherHead = other.segments[0];
        const otherPrevHead = other.prevSegments[0] || otherHead;

        const sameHeadCell = head.x === otherHead.x && head.y === otherHead.y;
        const swappedHeads =
          head.x === otherPrevHead.x &&
          head.y === otherPrevHead.y &&
          otherHead.x === myPrevHead.x &&
          otherHead.y === myPrevHead.y;

        if (sameHeadCell || swappedHeads) {
          if (snake.segments.length <= other.segments.length) {
            if (snake.extraLives > 0) {
              savedByExtraLife.add(snake.id);
            } else {
              doomed.set(snake.id, { reason: 'HEAD_COLLISION', killer: other });
            }
          }
          break;
        }
      }

      if (doomed.has(snake.id) || savedByExtraLife.has(snake.id)) continue;

      const hitOwner = bodyOwners.get((head.x << 8) | head.y);
      if (hitOwner) {
        if (Array.isArray(hitOwner)) {
          for (let h = 0; h < hitOwner.length; h++) {
            if (hitOwner[h].id !== snake.id) {
              if (snake.extraLives > 0) {
                savedByExtraLife.add(snake.id);
              } else {
                doomed.set(snake.id, { reason: 'KILLED_BY_SNAKE', killer: hitOwner[h] });
              }
              break;
            }
          }
        } else if (hitOwner.id !== snake.id) {
          if (snake.extraLives > 0) {
            savedByExtraLife.add(snake.id);
          } else {
            doomed.set(snake.id, { reason: 'KILLED_BY_SNAKE', killer: hitOwner });
          }
        }
      }
    }

    // Consume Extra Life when phasing over another snake and grant default invincibility duration
    for (const savedId of savedByExtraLife) {
      const savedSnake = this.snakes.get(savedId);
      if (!savedSnake || !savedSnake.alive || savedSnake.extraLives <= 0) continue;
      savedSnake.extraLives -= 1;
      savedSnake.shieldTicks = SPAWN_PROTECTION_TICKS + 1;
      this.extraLifeSaveCounter++;
      this.recentExtraLifeSaves.push({
        id: `exlife_${this.extraLifeSaveCounter}_${this.tick}`,
        tick: this.tick,
        snakeId: savedSnake.id,
        snakeName: savedSnake.name,
        x: savedSnake.segments[0].x,
        y: savedSnake.segments[0].y,
      });
    }

    // Decrement fail-safe spawn protection timer for all surviving snakes
    for (let sIdx = 0; sIdx < aliveSnakes.length; sIdx++) {
      const snake = aliveSnakes[sIdx];
      if (snake.shieldTicks > 0) {
        snake.shieldTicks = snake.shieldTicks - 1;
      }
    }

    // 6. Process deaths, award kill bonuses, and burst dead snakes into flashing big pellets!
    for (const [victimId, outcome] of doomed.entries()) {
      const victim = this.snakes.get(victimId);
      if (!victim || !victim.alive) continue;

      victim.alive = false;
      victim.deathReason = outcome.reason;
      if (outcome.killer) {
        victim.killedByName = outcome.killer.name;
        if (!doomed.has(outcome.killer.id)) {
          outcome.killer.kills += 1;
          outcome.killer.score += 500; // Tactical takedown bonus!
        }
      }

      const fallbackHead = victim.prevSegments[0] || victim.segments[1] || victim.segments[0];
      this.dropBigFlashingPellets(victim, fallbackHead);

      const crashPt = isInsideGrid(victim.segments[0], this.gridSize)
        ? victim.segments[0]
        : fallbackHead;

      this.killCounter++;
      this.recentKills.push({
        id: `kill_${this.killCounter}_${this.tick}`,
        tick: this.tick,
        victimId: victim.id,
        victimName: victim.name,
        killerId: outcome.killer?.id,
        killerName: outcome.killer?.name,
        reason: outcome.reason,
        x: crashPt.x,
        y: crashPt.y,
        pelletsDropped: victim.segments.length,
        victimColor: victim.color.head,
        deathEffectId: victim.deathEffectId,
      });

      // Remove dead bots from map after death; replacement up to targetBotCount is queued automatically
      if (victim.isBot) {
        this.snakes.delete(victimId);
        let currentBots = 0;
        for (const s of this.snakes.values()) {
          if (s.alive && s.isBot) currentBots++;
        }
        let queuedBots = 0;
        for (let t = 0; t < this.telegraphs.length; t++) {
          if (this.telegraphs[t].isBot) queuedBots++;
        }
        if (currentBots + queuedBots < this.targetBotCount) {
          this.queueNearbyBotSpawn(humanAnchors, 5);
        }
      }
    }

    bodyOwners.clear();
    doomed.clear();
    savedByExtraLife.clear();
    unshieldedSnakes.length = 0;
    aliveSnakes.length = 0;

    // 7. Age pellets & loot boxes and prune old events in-place (zero array allocations per tick)
    let writePellets = 0;
    for (let i = 0; i < this.pellets.length; i++) {
      const p = this.pellets[i];
      p.ttlTicks--;
      if (p.ttlTicks > 0) {
        this.pellets[writePellets++] = p;
      }
    }
    this.pellets.length = writePellets;

    let writeBoxes = 0;
    for (let i = 0; i < this.lootBoxes.length; i++) {
      const box = this.lootBoxes[i];
      box.ttlTicks--;
      if (box.ttlTicks > 0) {
        this.lootBoxes[writeBoxes++] = box;
      }
    }
    this.lootBoxes.length = writeBoxes;

    let writeKills = 0;
    for (let i = 0; i < this.recentKills.length; i++) {
      const k = this.recentKills[i];
      if (this.tick - k.tick <= 18) this.recentKills[writeKills++] = k;
    }
    this.recentKills.length = writeKills;

    let writeSlurps = 0;
    for (let i = 0; i < this.recentSlurps.length; i++) {
      const s = this.recentSlurps[i];
      if (this.tick - s.tick <= 4) this.recentSlurps[writeSlurps++] = s;
    }
    this.recentSlurps.length = writeSlurps;

    let writePickups = 0;
    for (let i = 0; i < this.recentLootPickups.length; i++) {
      const e = this.recentLootPickups[i];
      if (this.tick - e.tick <= 4) this.recentLootPickups[writePickups++] = e;
    }
    this.recentLootPickups.length = writePickups;

    let writeSaves = 0;
    for (let i = 0; i < this.recentExtraLifeSaves.length; i++) {
      const e = this.recentExtraLifeSaves[i];
      if (this.tick - e.tick <= 4) this.recentExtraLifeSaves[writeSaves++] = e;
    }
    this.recentExtraLifeSaves.length = writeSaves;

    return this.getSnapshot();
  }

  public hydrateFromSnapshot(snap: ArenaSnapshot) {
    this.tick = snap.tick;
    this.snakes.clear();
    for (const s of snap.snakes) {
      const prevHead =
        s.prevSegments && s.prevSegments[0] ? s.prevSegments[0] : s.segments[0];
      this.snakes.set(s.id, {
        ...s,
        extraLives: s.extraLives || 0,
        segments: s.segments.map((pt) => ({ x: pt.x, y: pt.y })),
        prevSegments: prevHead ? [{ x: prevHead.x, y: prevHead.y }] : [],
        nextDirs: [...(s.nextDirs || [])],
      });
    }
    this.pellets = snap.pellets.map((p) => ({ ...p }));
    this.lootBoxes = (snap.lootBoxes || []).map((b) => ({ ...b }));
    this.telegraphs = snap.telegraphs.map((t) => ({ ...t }));
    this.recentKills = snap.recentKills.map((k) => ({ ...k }));
    this.recentSlurps = snap.recentSlurps.map((s) => ({ ...s }));
    this.recentLootPickups = (snap.recentLootPickups || []).map((e) => ({ ...e }));
    this.recentExtraLifeSaves = (snap.recentExtraLifeSaves || []).map((e) => ({ ...e }));
  }

  public getSnapshot(): ArenaSnapshot {
    const snakesList = Array.from(this.snakes.values());
    let humanCount = 0;
    for (let i = 0; i < snakesList.length; i++) {
      if (!snakesList[i].isBot) humanCount++;
    }
    return {
      tick: this.tick,
      gridSize: this.gridSize,
      snakes: snakesList,
      pellets: this.pellets,
      lootBoxes: this.lootBoxes,
      telegraphs: this.telegraphs,
      recentKills: this.recentKills,
      recentSlurps: this.recentSlurps,
      recentLootPickups: this.recentLootPickups,
      recentExtraLifeSaves: this.recentExtraLifeSaves,
      onlinePlayers: Math.max(1, humanCount),
    };
  }
}
