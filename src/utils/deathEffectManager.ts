export interface DeathEffectItem {
  id: string;
  filename: string;
  label: string;
  url: string;
  kind: 'gif' | 'png';
}

const DEATH_EFFECT_STORAGE_KEY = 'gridslurp_death_effect_v1';

// Automatically discover and bundle every transparent .gif or still .png placed inside /src/death-effects/
const rawDeathEffectModules = import.meta.glob(
  '/src/death-effects/**/*.{gif,GIF,png,PNG}',
  {
    eager: true,
    query: '?url',
    import: 'default',
  }
) as Record<string, string>;

function formatEffectLabel(filename: string): string {
  const withoutExt = filename.replace(/\.[^/.]+$/, '').replace(/^\d+[-_.\s]+/, '');
  const clean = withoutExt
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return clean || filename;
}

export const DISCOVERED_DEATH_EFFECTS: DeathEffectItem[] = Object.entries(rawDeathEffectModules)
  .map(([fullPath, url]) => {
    const normalized = fullPath.replace(/^\/src\/death-effects\//, '');
    const parts = normalized.split('/');
    const filename = parts[parts.length - 1] || normalized;
    const kind: 'gif' | 'png' = filename.toLowerCase().endsWith('.png') ? 'png' : 'gif';
    return {
      id: normalized,
      filename,
      label: formatEffectLabel(filename),
      url,
      kind,
    };
  })
  .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));

const DEATH_EFFECT_BY_ID = new Map<string, DeathEffectItem>(
  DISCOVERED_DEATH_EFFECTS.map((item) => [item.id, item])
);

const deathEffectBlobCache = new Map<string, Blob>();
const pendingBlobFetches = new Map<string, Promise<Blob | null>>();

export function getDeathEffectById(effectId?: string | null): DeathEffectItem | undefined {
  if (!effectId || effectId === 'none') return undefined;
  return DEATH_EFFECT_BY_ID.get(effectId);
}

export function preloadDeathEffectBlob(effectId?: string | null): void {
  const item = getDeathEffectById(effectId);
  if (!item || typeof window === 'undefined' || typeof fetch === 'undefined') return;
  if (deathEffectBlobCache.has(item.id) || pendingBlobFetches.has(item.id)) return;

  const task = fetch(item.url)
    .then((res) => (res.ok ? res.blob() : null))
    .then((blob) => {
      if (blob) {
        deathEffectBlobCache.set(item.id, blob);
      }
      pendingBlobFetches.delete(item.id);
      return blob;
    })
    .catch(() => {
      pendingBlobFetches.delete(item.id);
      return null;
    });

  pendingBlobFetches.set(item.id, task);
}

// Warm preloaded blobs so animated GIFs restart cleanly from frame 0 on death without network stalls
if (typeof window !== 'undefined') {
  for (const item of DISCOVERED_DEATH_EFFECTS) {
    preloadDeathEffectBlob(item.id);
  }
}

export function createDeathEffectPlaybackUrl(
  effectId?: string | null
): { url: string; objectUrlToRevoke: string | null } | null {
  const item = getDeathEffectById(effectId);
  if (!item) return null;

  const cachedBlob = deathEffectBlobCache.get(item.id);
  if (cachedBlob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const blobUrl = URL.createObjectURL(cachedBlob);
    return { url: blobUrl, objectUrlToRevoke: blobUrl };
  }

  preloadDeathEffectBlob(item.id);
  return { url: item.url, objectUrlToRevoke: null };
}

export function loadSelectedDeathEffectId(): string {
  try {
    const saved = localStorage.getItem(DEATH_EFFECT_STORAGE_KEY);
    if (saved && (saved === 'none' || DEATH_EFFECT_BY_ID.has(saved))) {
      return saved;
    }
  } catch {
    // ignore storage errors
  }
  return 'none';
}

export function saveSelectedDeathEffectId(effectId: string): void {
  try {
    localStorage.setItem(DEATH_EFFECT_STORAGE_KEY, effectId);
  } catch {
    // ignore storage errors
  }
}
