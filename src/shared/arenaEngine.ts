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

export function isInsideGrid(pt: Point): boolean {
  return pt.x >= 0 && pt.x < GRID_SIZE && pt.y >= 0 && pt.y < GRID_SIZE;
}

export class ArenaEngine {
  public tick = 0;
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

  constructor(targetBotCount = 2) {
    this.targetBotCount = targetBotCount;
    this.seedInitialArena();
  }

  private seedInitialArena() {
    // Keep exactly 2 initial AI snakes on the 32x32 matrix at all times
    for (let i = 0; i < this.targetBotCount; i++) {
      this.spawnBotImmediate();
    }
  }

  public getColorById(colorId?: string): SnakeColor {
    const found = SNAKE_PALETTES.find((p) => p.id === colorId);
    if (found) return found;
    return SNAKE_PALETTES[Math.floor(Math.random() * SNAKE_PALETTES.length)];
  }

  private getOccupiedSet(): Set<string> {
    const occupied = new Set<string>();
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      for (const seg of s.segments) {
        occupied.add(`${seg.x},${seg.y}`);
      }
    }
    for (const t of this.telegraphs) {
      occupied.add(`${t.x},${t.y}`);
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
        // Clamp within safe interior margin (4..27) so newborn snakes don't immediately hit the wall
        x = Math.max(4, Math.min(GRID_SIZE - 5, x));
        y = Math.max(4, Math.min(GRID_SIZE - 5, y));
      } else {
        x = 4 + Math.floor(Math.random() * (GRID_SIZE - 8));
        y = 4 + Math.floor(Math.random() * (GRID_SIZE - 8));
      }

      const dir = directions[Math.floor(Math.random() * directions.length)];
      const oppDir: Direction =
        dir === 'UP' ? 'DOWN' : dir === 'DOWN' ? 'UP' : dir === 'LEFT' ? 'RIGHT' : 'LEFT';

      // Verify head + 3 body segments behind + 3 forward runway tiles are free
      let clear = true;
      let testPt = { x, y };
      for (let i = 0; i < 4; i++) {
        if (!isInsideGrid(testPt) || occupied.has(`${testPt.x},${testPt.y}`)) {
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
          forwardPt.x >= GRID_SIZE - 2 ||
          forwardPt.y <= 1 ||
          forwardPt.y >= GRID_SIZE - 2 ||
          occupied.has(`${forwardPt.x},${forwardPt.y}`)
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
      x: Math.max(5, Math.min(GRID_SIZE - 6, 10 + Math.floor(Math.random() * 12))),
      y: Math.max(5, Math.min(GRID_SIZE - 6, 10 + Math.floor(Math.random() * 12))),
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
      prevSegments: segments.map((s) => ({ ...s })),
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

  public queueTurn(id: string, requestedDir: Direction) {
    const snake = this.snakes.get(id);
    if (!snake || !snake.alive) return;

    const lastScheduledDir =
      snake.nextDirs.length > 0 ? snake.nextDirs[snake.nextDirs.length - 1] : snake.dir;

    if (requestedDir === lastScheduledDir || isOppositeDirection(requestedDir, lastScheduledDir)) {
      return;
    }

    if (snake.nextDirs.length < 2) {
      snake.nextDirs.push(requestedDir);
    } else {
      snake.nextDirs[1] = requestedDir;
    }
  }

  private dropBigFlashingPellets(victim: SnakeEntity) {
    // Every segment of the killed snake drops a big, high-value flashing pellet!
    // Even a 4-segment starter snake drops 4 juicy flashing trophy pellets so hunting is immediately rewarding.
    const count = victim.segments.length;
    for (let i = 0; i < count; i++) {
      const seg = victim.segments[i];
      if (!isInsideGrid(seg)) continue;

      // Avoid stacking multiple pellets on the exact same cell
      const existing = this.pellets.find((p) => p.x === seg.x && p.y === seg.y);
      if (existing) {
        existing.value += 120;
        existing.growth = Math.min(3, existing.growth + 1);
        existing.ttlTicks = 130;
        continue;
      }

      this.pelletCounter++;
      const isHeadTrophy = i === 0;
      this.pellets.push({
        id: `pellet_${this.pelletCounter}_${this.tick}`,
        x: seg.x,
        y: seg.y,
        value: isHeadTrophy ? 250 : 125,
        growth: 1,
        color: victim.color.head,
        spawnTick: this.tick,
        ttlTicks: 135, // ~15.5 seconds of flashing before expiring
        fromSnakeName: victim.name,
      });
    }
  }

  private computeBotDirection(bot: SnakeEntity): Direction {
    const head = bot.segments[0];
    const allDirs: Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
    const validDirs = allDirs.filter((d) => !isOppositeDirection(d, bot.dir));

    // Build hazard map:
    // Snakes can freely cross over their own tail/body.
    // For OTHER snakes passing by, the AI has delayed reaction time: it does NOT register
    // their front 3 segments (head + neck that just moved by in the last ~0.5s) as hazards,
    // and only partially notices older trail segments!
    const otherTrailCells = new Set<string>();
    for (const other of this.snakes.values()) {
      if (!other.alive || other.id === bot.id) continue;
      // Ignore segments 0, 1, 2 (the head and front body of a snake cutting in front of the AI)
      for (let i = 3; i < other.segments.length - 1; i++) {
        otherTrailCells.add(`${other.segments[i].x},${other.segments[i].y}`);
      }
    }

    // Human-like reaction delay: if continuing straight stays inside the 32x32 grid,
    // the bot often stays committed to its current heading instead of frame-perfectly dodging.
    const straightPt = stepPoint(head, bot.dir);
    const straightSafeFromWall =
      isInsideGrid(straightPt) &&
      straightPt.x >= 1 &&
      straightPt.x < GRID_SIZE - 1 &&
      straightPt.y >= 1 &&
      straightPt.y < GRID_SIZE - 1;

    if (straightSafeFromWall && Math.random() < 0.62) {
      return bot.dir;
    }

    // Score each candidate direction
    let bestDir = bot.dir;
    let bestScore = -999999;

    // Find closest human player or flashing pellet to gravitate toward
    let targetPoint: Point | null = null;
    let minTargetDist = 999;

    // 1. Prioritize nearby flashing big pellets if any exist within 12 tiles
    for (const p of this.pellets) {
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

      // Immediate outer 32x32 wall check
      if (!isInsideGrid(nextPt)) {
        continue;
      }

      let score = 0;

      // Delayed reaction to another snake's older trail: 50% chance the AI notices it late
      if (otherTrailCells.has(`${nextPt.x},${nextPt.y}`)) {
        if (Math.random() < 0.5) {
          score -= 140;
        }
      }

      // Keep buffer from the unforgiving 32x32 outer wall so bots don't die to walls on their own
      const wallDist = Math.min(
        nextPt.x,
        GRID_SIZE - 1 - nextPt.x,
        nextPt.y,
        GRID_SIZE - 1 - nextPt.y
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

    // 2. Ensure exactly targetBotCount (2) AI snakes are active or spawning on the server at all times
    const aliveSnakes = Array.from(this.snakes.values()).filter((s) => s.alive);
    const humanAnchors = aliveSnakes.filter((s) => !s.isBot).map((s) => s.segments[0]);
    const aliveBotsCount = aliveSnakes.filter((s) => s.isBot).length;
    const spawningBotsCount = this.telegraphs.filter((t) => t.isBot).length;

    while (aliveBotsCount + this.telegraphs.filter((t) => t.isBot).length < this.targetBotCount && spawningBotsCount < this.targetBotCount) {
      this.queueNearbyBotSpawn(humanAnchors, 5);
      break;
    }

    // 3. Determine next direction & next head position for each alive snake
    const nextHeads = new Map<string, Point>();

    for (const snake of aliveSnakes) {
      snake.prevSegments = snake.segments.map((seg) => ({ ...seg }));

      if (snake.isBot) {
        const chosen = this.computeBotDirection(snake);
        if (!isOppositeDirection(chosen, snake.dir)) {
          snake.dir = chosen;
        }
      } else if (snake.nextDirs.length > 0) {
        const nextDir = snake.nextDirs.shift()!;
        if (!isOppositeDirection(nextDir, snake.dir)) {
          snake.dir = nextDir;
        }
      }

      const nextHead = stepPoint(snake.segments[0], snake.dir);
      nextHeads.set(snake.id, nextHead);
    }

    // 4. Advance snake segments provisionally & check pellet slurping
    const pendingGrowth = new Map<string, number>();

    for (const snake of aliveSnakes) {
      const nextHead = nextHeads.get(snake.id)!;
      let growAmount = 0;

      // Check if snake head steps onto or within 1-tile slurp radius of any Big Flashing Pellet!
      const remainingPellets: BigPellet[] = [];
      for (const pellet of this.pellets) {
        const dx = Math.abs(pellet.x - nextHead.x);
        const dy = Math.abs(pellet.y - nextHead.y);
        // Direct hit or tight magnetic slurp (Manhattan distance <= 1)
        if (dx + dy <= 1) {
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
        } else {
          remainingPellets.push(pellet);
        }
      }
      this.pellets = remainingPellets;
      pendingGrowth.set(snake.id, growAmount);
    }

    // Move segments forward
    for (const snake of aliveSnakes) {
      const nextHead = nextHeads.get(snake.id)!;
      const grow = pendingGrowth.get(snake.id) || 0;
      const newSegments = [nextHead, ...snake.segments];
      if (grow === 0) {
        newSegments.pop();
      } else {
        // Keep the tail segment to grow by 1 (and if grow > 1, duplicate tail tip)
        for (let g = 1; g < grow; g++) {
          newSegments.push({ ...newSegments[newSegments.length - 1] });
        }
      }
      snake.segments = newSegments;
    }

    // 5. Evaluate unforgiving collisions:
    // - Out of bounds (off the 32x32 grid)
    // - Self-collision (running over top of yourself)
    // - Running into another snake's body (Snake.io cut-off!)
    // - Head-to-head collision
    const doomed = new Map<
      string,
      {
        reason: 'WALL_CRASH' | 'SELF_CRASH' | 'KILLED_BY_SNAKE' | 'HEAD_COLLISION';
        killer?: SnakeEntity;
      }
    >();

    for (const snake of aliveSnakes) {
      const head = snake.segments[0];

      // A. Unforgiving 32x32 Grid Boundary Check
      if (!isInsideGrid(head)) {
        doomed.set(snake.id, { reason: 'WALL_CRASH' });
        continue;
      }

      // B. Self-overlap is allowed! Snakes can freely pass over their own tail/body.

      // C. Other snakes check (Fail-safe spawn timer: shielded snakes cannot be killed by or kill other snakes on overlap)
      if (snake.shieldTicks > 0) {
        continue;
      }

      for (const other of aliveSnakes) {
        if (other.id === snake.id) continue;
        // If the other snake is still within its fail-safe spawn timer, it is phased/non-lethal
        if (other.shieldTicks > 0) continue;

        const otherHead = other.segments[0];

        // Did we collide head-to-head on the exact same cell, or swap heads?
        const sameHeadCell = head.x === otherHead.x && head.y === otherHead.y;
        const swappedHeads =
          head.x === other.prevSegments[0].x &&
          head.y === other.prevSegments[0].y &&
          otherHead.x === snake.prevSegments[0].x &&
          otherHead.y === snake.prevSegments[0].y;

        if (sameHeadCell || swappedHeads) {
          if (snake.segments.length < other.segments.length) {
            doomed.set(snake.id, { reason: 'HEAD_COLLISION', killer: other });
          } else if (snake.segments.length === other.segments.length) {
            doomed.set(snake.id, { reason: 'HEAD_COLLISION', killer: other });
          }
          continue;
        }

        // Did snake's head run into any body segment (index >= 1) of `other`?
        for (let i = 1; i < other.segments.length; i++) {
          if (other.segments[i].x === head.x && other.segments[i].y === head.y) {
            doomed.set(snake.id, { reason: 'KILLED_BY_SNAKE', killer: other });
            break;
          }
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

      // Use prevSegments if head went off-grid so pellets drop right along the grid edge
      const dropSource: SnakeEntity = {
        ...victim,
        segments: victim.segments.map((seg, idx) =>
          isInsideGrid(seg) ? seg : victim.prevSegments[idx] || victim.prevSegments[0]
        ),
      };
      this.dropBigFlashingPellets(dropSource);

      const crashPt = isInsideGrid(victim.segments[0])
        ? victim.segments[0]
        : victim.prevSegments[0];

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

      // Remove dead bots from map after death; replacement up to 2 bots is queued automatically
      if (victim.isBot) {
        this.snakes.delete(victimId);
        const currentBots = Array.from(this.snakes.values()).filter((s) => s.alive && s.isBot).length;
        const queuedBots = this.telegraphs.filter((t) => t.isBot).length;
        if (currentBots + queuedBots < this.targetBotCount) {
          this.queueNearbyBotSpawn(humanAnchors, 5);
        }
      }
    }

    // 7. Age pellets and prune old events
    this.pellets = this.pellets.filter((p) => {
      p.ttlTicks--;
      return p.ttlTicks > 0;
    });

    this.recentKills = this.recentKills.filter((k) => this.tick - k.tick <= 45);
    this.recentSlurps = this.recentSlurps.filter((s) => this.tick - s.tick <= 8);

    return this.getSnapshot();
  }

  public getSnapshot(): ArenaSnapshot {
    const snakesList = Array.from(this.snakes.values());
    const humanCount = snakesList.filter((s) => !s.isBot).length;
    return {
      tick: this.tick,
      gridSize: GRID_SIZE,
      snakes: snakesList,
      pellets: this.pellets,
      telegraphs: this.telegraphs,
      recentKills: this.recentKills,
      recentSlurps: this.recentSlurps,
      onlinePlayers: Math.max(1, humanCount),
    };
  }
}
