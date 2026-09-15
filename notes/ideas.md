# Ideas

Features and ideas for mk-drive that are not on the board yet. Promote one with `mk-board add <column> "..."`.

- 2026-09-11 07:46 — mk-kit gaps left on purpose: mk-code languages, mkDrag + mkDropZone on one element (PLAN gap list)
- 2026-09-11 09:47 — mk-kit: MkTableColumn.compare (0.59) is negated for descending sort, so a folders-first comparator puts folders last on desc — give compare the direction (or only negate the built-in one); until then mk-drive keeps its own ordering (browse.ts)
- 2026-09-11 17:28 — Desktop: no custom client for now — GVFS davs:// (GNOME Files → Other Locations → davs://<email>@<drive>/dav/) works end to end (tested 2026-09-11: mount, list, read, write, delete, unmount); rclone mount --vfs-cache-mode full gives Nextcloud-like files-on-demand on Linux/macOS/Windows; macOS Finder has WebDAV built in. A 'Connect this computer' page in Settings with per-OS steps would be the cheap next step; a native client, if ever, is one Swift File Provider app for macOS + iOS, not a Linux add-on.
