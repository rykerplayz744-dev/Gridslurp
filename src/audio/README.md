# GRIDSLURP Audio Tracks Folder (`src/audio/`)

Drop any `.mp3` (or `.wav`, `.ogg`, `.m4a`) files into this `src/audio/` folder before pushing to GitHub / building on Vercel.

- **Default Music Folder (`src/audio/`)**: Files directly inside `src/audio/` belong to the default music playlist. Nothing starts playing automatically on game launch except for the Admin Presence music.
- **Admin Presence Folder (`src/audio/admin/`)**: Files inside `src/audio/admin/` do **not** appear in the default music playlist. Instead, music from `src/audio/admin/` automatically starts playing whenever a player named **`ADMIN`** is in the server, and stops **10 seconds** after the `ADMIN` leaves the server (returning to default music).
- **Admin Menu**: Type `ADMIN` into the `NAME` field on the main menu to open the **Admin Menu**, where you can organize default playlists, toggle shuffle, and manually start/stop default music.
