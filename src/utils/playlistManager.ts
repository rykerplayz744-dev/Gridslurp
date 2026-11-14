export interface AudioTrackItem {
  id: string;
  filename: string;
  title: string;
  folder: string;
  url: string;
}

export interface AudioPlaylist {
  id: string;
  name: string;
  trackIds: string[];
  isBuiltIn?: boolean;
}

export interface PlaylistStoreState {
  playlists: AudioPlaylist[];
  activePlaylistId: string;
  shuffle: boolean;
  volume: number;
  musicEnabled: boolean;
}

const STORAGE_KEY = 'gridslurp_admin_playlists_v2';

// Automatically bundle and discover all audio files placed in /src/audio/ when building on Vercel
const rawAudioModules = import.meta.glob(
  '/src/audio/**/*.{mp3,MP3,wav,WAV,ogg,OGG,m4a,M4A,aac,AAC,flac,FLAC}',
  {
    eager: true,
    query: '?url',
    import: 'default',
  }
) as Record<string, string>;

function formatTrackTitle(filename: string): string {
  const withoutExt = filename.replace(/\.[^/.]+$/, '');
  return withoutExt
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function isAdminFolder(folder: string): boolean {
  const lower = folder.toLowerCase();
  return lower === 'admin' || lower.startsWith('admin/');
}

const ALL_BUNDLED_TRACKS: AudioTrackItem[] = Object.entries(rawAudioModules)
  .map(([fullPath, url]) => {
    const normalized = fullPath.replace(/^\/src\/audio\//, '');
    const parts = normalized.split('/');
    const filename = parts[parts.length - 1] || normalized;
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
    return {
      id: normalized,
      filename,
      title: formatTrackTitle(filename),
      folder,
      url,
    };
  })
  .sort((a, b) => a.filename.localeCompare(b.filename));

// Default music tracks (strictly excludes the extra src/audio/admin/ folder)
export const DISCOVERED_AUDIO_TRACKS: AudioTrackItem[] = ALL_BUNDLED_TRACKS.filter(
  (t) => !isAdminFolder(t.folder)
);

// Extra folder tracks (src/audio/admin/) that automatically start playing whenever a player named ADMIN is in the server
export const ADMIN_AUDIO_TRACKS: AudioTrackItem[] = ALL_BUNDLED_TRACKS.filter((t) =>
  isAdminFolder(t.folder)
);

function buildDefaultState(): PlaylistStoreState {
  const allTrackIds = DISCOVERED_AUDIO_TRACKS.map((t) => t.id);

  const playlists: AudioPlaylist[] = [
    {
      id: 'all_tracks',
      name: 'DEFAULT MUSIC PLAYLIST',
      trackIds: [...allTrackIds],
      isBuiltIn: true,
    },
  ];

  // If the user organized MP3s into non-admin subfolders inside src/audio/<Subfolder>/*.mp3, auto-create a playlist per subfolder
  const folderMap = new Map<string, string[]>();
  for (const track of DISCOVERED_AUDIO_TRACKS) {
    if (track.folder !== 'root' && !isAdminFolder(track.folder)) {
      const list = folderMap.get(track.folder) || [];
      list.push(track.id);
      folderMap.set(track.folder, list);
    }
  }
  for (const [folderName, ids] of folderMap.entries()) {
    playlists.push({
      id: `folder_${folderName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      name: `${folderName.toUpperCase()}`,
      trackIds: ids,
      isBuiltIn: true,
    });
  }

  return {
    playlists,
    activePlaylistId: 'all_tracks',
    shuffle: true,
    volume: 0.45,
    musicEnabled: true,
  };
}

export function loadPlaylistStore(): PlaylistStoreState {
  const defaults = buildDefaultState();
  const validTrackIds = new Set(DISCOVERED_AUDIO_TRACKS.map((t) => t.id));

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PlaylistStoreState>;

    const savedPlaylists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
    const customPlaylists: AudioPlaylist[] = [];

    for (const pl of savedPlaylists) {
      if (!pl || typeof pl.id !== 'string' || typeof pl.name !== 'string') continue;
      if (pl.id === 'all_tracks' || pl.id.startsWith('folder_')) continue;
      // Ensure admin tracks never leak into default or custom playlists
      const filteredIds = Array.isArray(pl.trackIds)
        ? pl.trackIds.filter((id) => validTrackIds.has(id))
        : [];
      customPlaylists.push({
        id: pl.id,
        name: pl.name,
        trackIds: filteredIds,
      });
    }

    const builtInPlaylists = defaults.playlists.filter((p) => p.isBuiltIn);
    const mergedPlaylists = [
      ...builtInPlaylists,
      ...(customPlaylists.length > 0
        ? customPlaylists
        : defaults.playlists.filter((p) => !p.isBuiltIn)),
    ];

    const activeExists = mergedPlaylists.some((p) => p.id === parsed.activePlaylistId);

    return {
      playlists: mergedPlaylists,
      activePlaylistId: activeExists ? parsed.activePlaylistId! : 'all_tracks',
      shuffle: typeof parsed.shuffle === 'boolean' ? parsed.shuffle : true,
      volume:
        typeof parsed.volume === 'number'
          ? Math.max(0, Math.min(1, parsed.volume))
          : defaults.volume,
      musicEnabled:
        typeof parsed.musicEnabled === 'boolean' ? parsed.musicEnabled : true,
    };
  } catch {
    return defaults;
  }
}

export function savePlaylistStore(state: PlaylistStoreState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}
