# Admin Presence Audio Folder (`src/audio/admin/`)

Any `.mp3` (or `.wav`, `.ogg`, `.m4a`) files placed inside this `src/audio/admin/` folder are reserved exclusively for **Admin Presence Music**:

- **Automatic Trigger**: Whenever a player named **`ADMIN`** joins the server, music from `src/audio/admin/` automatically starts playing (shuffled).
- **10-Second Leave Timer**: When the `ADMIN` player leaves the server, the admin music continues for **10 seconds** and then stops, returning to the default music state.
- **Hidden from Default Playlist**: Tracks inside `src/audio/admin/` are excluded from the default music playlist.
