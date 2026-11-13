import type { IncomingMessage, ServerResponse } from 'http';
import { ArenaEngine } from '../src/shared/arenaEngine';

// Global singleton arena instance for Vercel warm serverless functions
const globalArena: ArenaEngine =
  (globalThis as unknown as { __gridslurpArena?: ArenaEngine }).__gridslurpArena ||
  new ArenaEngine(2);

(globalThis as unknown as { __gridslurpArena?: ArenaEngine }).__gridslurpArena = globalArena;

export default function handler(
  req: IncomingMessage & { body?: unknown; method?: string },
  res: ServerResponse & {
    status?: (code: number) => { json: (data: unknown) => void };
    json?: (data: unknown) => void;
  }
) {
  const snapshot = globalArena.step();
  const payload = {
    status: 'ok',
    deployment: 'vercel-serverless',
    snapshot,
  };

  if (typeof res.status === 'function') {
    res.status(200).json(payload);
  } else {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  }
}
