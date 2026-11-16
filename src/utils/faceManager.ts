export interface SnakeFaceItem {
  id: string;
  filename: string;
  label: string;
  url: string;
}

const FACE_STORAGE_KEY = 'gridslurp_snake_face_v1';

// Automatically discover and bundle every .png placed inside /src/faces/
const rawFaceModules = import.meta.glob('/src/faces/**/*.{png,PNG}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function formatFaceLabel(filename: string): string {
  const withoutExt = filename.replace(/\.[^/.]+$/, '').replace(/^\d+[-_.\s]+/, '');
  const clean = withoutExt
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return clean || filename;
}

export const DISCOVERED_SNAKE_FACES: SnakeFaceItem[] = Object.entries(rawFaceModules)
  .map(([fullPath, url]) => {
    const normalized = fullPath.replace(/^\/src\/faces\//, '');
    const parts = normalized.split('/');
    const filename = parts[parts.length - 1] || normalized;
    return {
      id: normalized,
      filename,
      label: formatFaceLabel(filename),
      url,
    };
  })
  .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));

const FACE_BY_ID = new Map<string, SnakeFaceItem>(
  DISCOVERED_SNAKE_FACES.map((face) => [face.id, face])
);

const faceImageCache = new Map<string, HTMLImageElement>();

// Eagerly warm image cache so canvas renders faces cleanly without frame flicker
for (const face of DISCOVERED_SNAKE_FACES) {
  if (typeof Image !== 'undefined') {
    const img = new Image();
    img.src = face.url;
    faceImageCache.set(face.id, img);
  }
}

export function getFaceById(faceId?: string | null): SnakeFaceItem | undefined {
  if (!faceId || faceId === 'default') return undefined;
  return FACE_BY_ID.get(faceId);
}

export function getFaceImage(faceId?: string | null): HTMLImageElement | null {
  if (!faceId || faceId === 'default') return null;
  const cached = faceImageCache.get(faceId);
  if (cached) {
    return cached.complete && cached.naturalWidth > 0 ? cached : null;
  }
  const face = FACE_BY_ID.get(faceId);
  if (!face || typeof Image === 'undefined') return null;
  const img = new Image();
  img.src = face.url;
  faceImageCache.set(faceId, img);
  return img.complete && img.naturalWidth > 0 ? img : null;
}

export function loadSelectedFaceId(): string {
  try {
    const saved = localStorage.getItem(FACE_STORAGE_KEY);
    if (saved && (saved === 'default' || FACE_BY_ID.has(saved))) {
      return saved;
    }
  } catch {
    // ignore storage errors
  }
  return 'default';
}

export function saveSelectedFaceId(faceId: string): void {
  try {
    localStorage.setItem(FACE_STORAGE_KEY, faceId);
  } catch {
    // ignore storage errors
  }
}
