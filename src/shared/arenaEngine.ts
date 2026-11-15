import {
  ArenaSnapshot,
  BigPellet,
  Direction,
  GRID_SIZE,
  KillEvent,
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
  public telegraphs: SpawnTelegraph[] = [];
  public recentKills: KillEvent[] = [];
  public recentSlurps: SlurpEvent[] = [];
  private botCounter = 0;
  private pelletCounter = 0;
  private killCounter = 0;
  private slurpCounter = 0;
  private targetBotCount = 2;

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
    isBot: boolean
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

    return {
      id,
      name,
      color,
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
      botStyle: styles[Math.floor(Math.random() * styles.length)],
    };
  }

  public spawnPlayer(id: string, name: string, colorId: string): SnakeEntity {
    const cleanName = (name || 'PLAYER_1').trim().slice(0, 14).toUpperCase() || 'PLAYER_1';
    const color = this.getColorById(colorId);
    const spawn = this.findNearbySafeSpawn();
    const snake = this.createSnakeEntity(id, cleanName, color, spawn, false);
    this.snakes.set(id, snake);
    return snake;
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

  public setAutopilot(id: string, enabled: boolean) {
    const snake = this.snakes.get(id);
    if (!snake || !snake.alive) return;
    snake.autoPilot = enabled;
    if (enabled) {
      snake.nextDirs = [];
    }
  }

  public queueTurn(id: string, requestedDir: Direction) {
    const snake = this.snakes.get(id);
    if (!snake || !snake.alive) return;

    const lastScheduledDir =
      snake.nextDirs.length > 0 ? snake.nextDirs[snake.nextDirs.length - 1] : snake.dir;

    if (requestedDir === lastScheduledDir) {
      return;
    }

    if (snake.nextDirs.length < 2) {
      snake.nextDirs.push(requestedDir);
    } else {
      snake.nextDirs[1] = requestedDir;
    }
  }

  private dropBigFlashingPellets(victim: SnakeEntity) {
    // O(1) spatial map of existing pellets so even a 2,000-segment snake drops pellets in < 1ms
    const pelletByCell = new Map<number, BigPellet>();
    for (let i = 0; i < this.pellets.length; i++) {
      const p = this.pellets[i];
      pelletByCell.set((p.x << 8) | p.y, p);
    }

    const count = victim.segments.length;
    for (let i = 0; i < count; i++) {
      const seg = victim.segments[i];
      if (!isInsideGrid(seg, this.gridSize)) continue;

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
  }

  private computeBotDirection(bot: SnakeEntity): Direction {
    const head = bot.segments[0];
    const allDirs: Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
    const validDirs = allDirs.filter((d) => !isOppositeDirection(d, bot.dir));

    // Human-like reaction delay: if continuing straight stays inside the grid,
    // the bot often stays committed to its current heading instead of frame-perfectly dodging.
    const straightPt = stepPoint(head, bot.dir);
    const straightSafeFromWall =
      isInsideGrid(straightPt, this.gridSize) &&
      straightPt.x >= 1 &&
      straightPt.x < this.gridSize - 1 &&
      straightPt.y >= 1 &&
      straightPt.y < this.gridSize - 1;

    if (straightSafeFromWall && Math.random() < 0.62) {
      return bot.dir;
    }

    // Build fast integer hazard set only for the 3 candidate neighbor cells around the bot's head
    const otherTrailCells = new Set<number>();
    for (const other of this.snakes.values()) {
      if (!other.alive || other.id === bot.id) continue;
      // Ignore segments 0, 1, 2 (the head and front body of a snake cutting in front of the AI)
      for (let i = 3; i < other.segments.length - 1; i++) {
        const seg = other.segments[i];
        if (Math.abs(seg.x - head.x) <= 1 && Math.abs(seg.y - head.y) <= 1) {
          otherTrailCells.add((seg.x << 8) | seg.y);
        }
      }
    }

    // Score each candidate direction
    let bestDir = bot.dir;
    let bestScore = -999999;

    // Find closest human player or flashing pellet to gravitate toward
    let targetPoint: Point | null = null;
    let minTargetDist = 999;

    // 1. Prioritize nearby flashing big pellets if any exist within 12 tiles
    for (let i = 0; i < this.pellets.length; i++) {
      const p = this.pellets[i];
      const d = Math.abs(p.x - head.x) + Math.abs(p.y - head.y);
      if (d < minTargetDist && d <= 12) {
        minTargetDist = d;
        targetPoint = { x: p.x, y: p.y };
      }
    }

    // 2. Otherwise cruise near human players so players have plenty of opportunities to cut them off
    if (!targetPoint) {
      for (const s of this.snakes.values()) {
        if (!s.alive || s.id === bot.id) continue;
        const targetSeg = s.segments[0];
        const dist = Math.abs(targetSeg.x - head.x) + Math.abs(targetSeg.y - head.y);
        const weight = s.isBot ? dist * 1.35 : dist * 0.75;
        if (weight < minTargetDist) {
          minTargetDist = weight;
          targetPoint = targetSeg;
        }
      }
    }

    for (const dir of validDirs) {
      const nextPt = stepPoint(head, dir);

      // Immediate outer wall check
      if (!isInsideGrid(nextPt, this.gridSize)) {
        continue;
      }

      let score = 0;

      // Delayed reaction to another snake's older trail: 50% chance the AI notices it late
      if (otherTrailCells.has((nextPt.x << 8) | nextPt.y)) {
        if (Math.random() < 0.5) {
          score -= 140;
        }
      }

      // Keep buffer from the unforgiving outer wall so bots don't die to walls on their own
      const wallDist = Math.min(
        nextPt.x,
        this.gridSize - 1 - nextPt.x,
        nextPt.y,
        this.gridSize - 1 - nextPt.y
      );
      if (wallDist === 0) score -= 65;
      else if (wallDist === 1) score -= 18;

      // Move toward target (pellet or player area)
      if (targetPoint) {
        const currDist = Math.abs(targetPoint.x - head.x) + Math.abs(targetPoint.y - head.y);
        const nextDist = Math.abs(targetPoint.x - nextPt.x) + Math.abs(targetPoint.y - nextPt.y);
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

  public step(): ArenaSnapshot {
    this.tick++;

    // 1. Advance spawn telegraphs
    const remainingTelegraphs: SpawnTelegraph[] = [];
    for (const tele of this.telegraphs) {
      tele.ticksLeft--;
      if (tele.ticksLeft <= 0) {
        // Spawn the rival snake on the grid
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
        remainingTelegraphs.push(tele);
      }
    }
    this.telegraphs = remainingTelegraphs;

    // 2. Ensure exactly targetBotCount (2 on 32x32, 4 on 64x64) AI snakes are active or spawning on the server at all times
    const aliveSnakes = Array.from(this.snakes.values()).filter((s) => s.alive);
    const humanAnchors = aliveSnakes.filter((s) => !s.isBot).map((s) => s.segments[0]);
    const aliveBotsCount = aliveSnakes.filter((s) => s.isBot).length;

    while (
      aliveBotsCount + this.telegraphs.filter((t) => t.isBot).length <
      this.targetBotCount
    ) {
      this.queueNearbyBotSpawn(humanAnchors, 5);
    }

    // 3. Determine next direction & next head position for each alive snake
    const nextHeads = new Map<string, Point>();

    for (const snake of aliveSnakes) {
      // Only store previous head position for smooth sub-tick camera interpolation & head-swap checks
      snake.prevSegments = [{ ...snake.segments[0] }];

      if (snake.isBot) {
        const chosen = this.computeBotDirection(snake);
        if (!isOppositeDirection(chosen, snake.dir)) {
          snake.dir = chosen;
        }
      } else if (snake.autoPilot) {
        const chosen = this.computeAutopilotDirection(snake);
        if (!isOppositeDirection(chosen, snake.dir)) {
          snake.dir = chosen;
        }
      } else if (snake.nextDirs.length > 0) {
        const nextDir = snake.nextDirs.shift()!;
        snake.dir = nextDir;
      }

      const nextHead = stepPoint(snake.segments[0], snake.dir);
      nextHeads.set(snake.id, nextHead);
    }

    // 4. Advance snake segments provisionally & check pellet slurping in O(1) per snake via spatial cell map
    const pendingGrowth = new Map<string, number>();

    if (this.pellets.length > 0) {
      const pelletAtCell = new Map<number, BigPellet>();
      for (let i = 0; i < this.pellets.length; i++) {
        const p = this.pellets[i];
        pelletAtCell.set((p.x << 8) | p.y, p);
      }

      const eatenPellets = new Set<BigPellet>();
      const slurpOffsets = [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];

      for (const snake of aliveSnakes) {
        const nextHead = nextHeads.get(snake.id)!;
        let growAmount = 0;

        for (let o = 0; o < 5; o++) {
          const px = nextHead.x + slurpOffsets[o][0];
          const py = nextHead.y + slurpOffsets[o][1];
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
        this.pellets = this.pellets.filter((p) => !eatenPellets.has(p));
      }
    } else {
      for (const snake of aliveSnakes) {
        pendingGrowth.set(snake.id, 0);
      }
    }

    // Move segments forward
    for (const snake of aliveSnakes) {
      const nextHead = nextHeads.get(snake.id)!;
      const grow = pendingGrowth.get(snake.id) || 0;
      snake.segments.unshift(nextHead);
      if (grow === 0) {
        snake.segments.pop();
      } else {
        // Keep the tail segment to grow by 1 (and if grow > 1, duplicate tail tip)
        const tailTip = snake.segments[snake.segments.length - 1];
        for (let g = 1; g < grow; g++) {
          snake.segments.push({ x: tailTip.x, y: tailTip.y });
        }
      }
    }

    // 5. Evaluate unforgiving collisions in O(totalSegments) using spatial lookup maps:
    // - Out of bounds (off the grid)
    // - Running into another snake's body (Snake.io cut-off!)
    // - Head-to-head collision
    const doomed = new Map<
      string,
      {
        reason: 'WALL_CRASH' | 'SELF_CRASH' | 'KILLED_BY_SNAKE' | 'HEAD_COLLISION';
        killer?: SnakeEntity;
      }
    >();

    // Build spatial occupancy maps once for all unshielded snakes
    const bodyOwners = new Map<number, SnakeEntity | SnakeEntity[]>();
    const unshieldedSnakes: SnakeEntity[] = [];

    for (const other of aliveSnakes) {
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

    for (const snake of aliveSnakes) {
      const head = snake.segments[0];

      // A. Unforgiving Grid Boundary Check
      if (!isInsideGrid(head, this.gridSize)) {
        doomed.set(snake.id, { reason: 'WALL_CRASH' });
        continue;
      }

      // B. Self-overlap is allowed! Snakes can freely pass over their own tail/body.

      // C. Other snakes check (Fail-safe spawn timer: shielded snakes cannot be killed by or kill other snakes on overlap)
      if (snake.shieldTicks > 0) {
        continue;
      }

      const myPrevHead = snake.prevSegments[0] || head;

      // Check head-to-head collisions with other unshielded snakes (small set of heads)
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
            doomed.set(snake.id, { reason: 'HEAD_COLLISION', killer: other });
          }
          break;
        }
      }

      if (doomed.has(snake.id)) continue;

      // O(1) body trail collision check
      const hitOwner = bodyOwners.get((head.x << 8) | head.y);
      if (hitOwner) {
        if (Array.isArray(hitOwner)) {
          for (let h = 0; h < hitOwner.length; h++) {
            if (hitOwner[h].id !== snake.id) {
              doomed.set(snake.id, { reason: 'KILLED_BY_SNAKE', killer: hitOwner[h] });
              break;
            }
          }
        } else if (hitOwner.id !== snake.id) {
          doomed.set(snake.id, { reason: 'KILLED_BY_SNAKE', killer: hitOwner });
        }
      }
    }

    // Decrement fail-safe spawn protection timer for all surviving snakes
    for (const snake of aliveSnakes) {
      if (snake.shieldTicks > 0) {
        snake.shieldTicks = Math.max(0, snake.shieldTicks - 1);
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
      // Use fallbackHead if head went off-grid so pellets drop right along the grid edge
      const dropSource: SnakeEntity = {
        ...victim,
        segments: victim.segments.map((seg) =>
          isInsideGrid(seg, this.gridSize) ? seg : fallbackHead
        ),
      };
      this.dropBigFlashingPellets(dropSource);

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
      });

      // Remove dead bots from map after death; replacement up to targetBotCount is queued automatically
      if (victim.isBot) {
        this.snakes.delete(victimId);
        const currentBots = Array.from(this.snakes.values()).filter((s) => s.alive && s.isBot).length;
        const queuedBots = this.telegraphs.filter((t) => t.isBot).length;
        if (currentBots + queuedBots < this.targetBotCount) {
          this.queueNearbyBotSpawn(humanAnchors, 5);
        }
      }
    }

    // 7. Age pellets and prune old events (short window minimizes repeated payload bytes)
    this.pellets = this.pellets.filter((p) => {
      p.ttlTicks--;
      return p.ttlTicks > 0;
    });

    this.recentKills = this.recentKills.filter((k) => this.tick - k.tick <= 18);
    this.recentSlurps = this.recentSlurps.filter((s) => this.tick - s.tick <= 4);

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
        segments: s.segments.map((pt) => ({ x: pt.x, y: pt.y })),
        prevSegments: prevHead ? [{ x: prevHead.x, y: prevHead.y }] : [],
        nextDirs: [...(s.nextDirs || [])],
      });
    }
    this.pellets = snap.pellets.map((p) => ({ ...p }));
    this.telegraphs = snap.telegraphs.map((t) => ({ ...t }));
    this.recentKills = snap.recentKills.map((k) => ({ ...k }));
    this.recentSlurps = snap.recentSlurps.map((s) => ({ ...s }));
  }

  public getSnapshot(): ArenaSnapshot {
    const snakesList = Array.from(this.snakes.values());
    const humanCount = snakesList.filter((s) => !s.isBot).length;
    return {
      tick: this.tick,
      gridSize: this.gridSize,
      snakes: snakesList,
      pellets: this.pellets,
      telegraphs: this.telegraphs,
      recentKills: this.recentKills,
      recentSlurps: this.recentSlurps,
      onlinePlayers: Math.max(1, humanCount),
    };
  }
}
