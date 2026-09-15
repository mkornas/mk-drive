# mk-drive — plan

A self-hosted web drive: point it at storage, get a Google-Drive-like UI to
browse, upload, preview, organise and share what is there. No database, no
import, no app-owned format — the filesystem is the truth, and removing the
container loses nothing. Built on Angular 22 + `@mk-kit/ui` as the public
"built with mk-kit" showcase app. A typical deployment: a container behind a
reverse proxy or Cloudflare Tunnel, with storage mounted in from a NAS.

Status 2026-09-10: **M0 shipped** — repo on GitHub, image on GHCR, running
behind a tunnel and Cloudflare Access, with one local location. **M1 is complete** (accounts, sessions, grants, admin pages, audit, security
headers, the design tokens; chunked resumable uploads with folder drops, new
folder, rename, move, copy, trash with restore/undo/purge, multi-select,
context menu, hotkeys, drag-and-drop moves, zip download, conflict prompts,
location health with a timeout). **M2 is complete** (grid view with
sharp-made WebP thumbnails in a capped cache, lightbox for photos, bounded
filename search, recent and starred, command palette, phone-width toolbar and
grid). **M3 is complete** (public share links with expiry, password, browse or
zip-only folders and a bare `/s/<id>` page; snapshot versions with restore;
file changes in the activity log; an in-app "new version" prompt for the
installed PWA). Deferred on purpose: the Polish locale — mk-kit ships a `pl`
pack, but switching only the components while the app's own copy stays
English gives a mixed-language UI, which is worse than English throughout;
app-level i18n is its own task if users ask for it. **M4 is complete**: README with screenshots and a one-line demo run,
`DRIVE_DEMO=true` (sample tree + demo admin, reset on start), the blog post
and FAQ entry on mk-kit.dev, and the mk-kit fixes below shipped as
[mk-kit PR #106](https://github.com/mk-kit/mk-kit/pull/106) "0.59.0" (table `compare`,
tree `iconName`, dialog focus timing, hotkeys inputs, dialog overflow).
If an access proxy sits in front, share links need a bypass on `/s/*` and
`/api/s/*`. Since 2026-09-11 Access is not needed in front at all: single
sign-on is the internet login, `DRIVE_PASSWORD_LOGIN=lan` keeps the password
on the LAN (`notes/cloudflare-access.md`). Remaining from the gap
list: `mk-code` languages and drag+drop-zone on one element — deliberately
not changed. A deployment can start with **one** location and add more once
the drive proves itself (decision 2026-09-10).

Gaps in mk-kit found on the way (to file as issues in M4):
- `mk-table` has no per-column comparator, so "folders first" cannot be
  expressed; the browse page bypasses its sort (see `browse.ts`).
- `mk-tree` renders `icon` as a text glyph only — no `mk-icon` in tree nodes.
- `mk-code` highlights only `json` / `plaintext`.
- `MkPromptDialog` shows a stray horizontal scrollbar inside its panel.
- Dialogs restore focus to the trigger before the closing key press has fully
  ended, so Enter that confirms a prompt also re-activates the button under it
  (the app guards against re-entry; the fix belongs in the overlay).
- `MkHotkeysService` treats every `<input>` as a text field, so shortcuts do
  not fire while a checkbox has focus (the app passes `allowInInput` and checks
  the input type itself).
- `mkDrag` and `mkDropZone` are both components, so one element cannot be
  draggable and a drop target at once (needs a wrapper element).

What comes next is on the board: `board.md` (Now / Next / Later, mk-board
format) with the reasoning in `notes/`; this file keeps the shape and the
milestone history.

## 1. What it is, and is not

**Is:** one container that mounts one or more directories ("locations") and
serves a fast, keyboard-friendly, installable web UI over them. Storage-agnostic:
a local disk, an NFS/SMB mount from a NAS, a USB drive — anything the host can
mount. Later: connectors the app talks to directly (SMB, S3, WebDAV) without a
host mount, and a native iOS app that exposes mk-drive in the Files app the way
the Nextcloud app does.

**Is not:** a Nextcloud replacement. Desktop sync and groupware accounts stay
with Nextcloud or similar. mk-drive is the thing Nextcloud is bad
at — opening *any* directory in a browser, instantly, with nothing to index.

Second purpose: a real, daily-used app that exercises the parts of mk-kit a
component gallery cannot — drag & drop, context menus, virtual tables,
galleries, command palette, hotkeys, drawers, uploads — in one coherent UI.

## 2. Shape

Mirror of `mk-dashboard` (known to work, same deploy pipeline):

```
mk-drive/
  client/    Angular 22, zoneless, standalone, @mk-kit/ui 0.58.x, PWA
  server/    Fastify 5 on Node 24 (type-stripping, no build step); sharp is the only native dep
  shared/    types.ts — API contract shared by both (and by a future iOS client)
  Dockerfile one image: built client served by the API
  docker-compose.yml, .github/workflows/deploy.yml (→ ghcr.io/mkornas/mk-drive)
  PLAN.md, README.md, CLAUDE.md
```

Repo `github.com/mkornas/mk-drive`, AGPL-3.0-only (the publishing checklist is
`notes/publishing.md`). Public-repo commit rules apply (plain `git commit -s`,
no AI trailers).

### Storage model

The server sees **locations**. A location has a name, an icon, a mode and a
provider. The only provider in v1 is `local` (a directory inside the
container); everything else is the operator's `-v` mount:

```yaml
volumes:
  - /mnt/nas/drive:/locations/drive
  - /mnt/nas/docs:/locations/docs
  - /mnt/nas/backups:/locations/backups:ro
  - /mnt/nas/media:/locations/media:ro
environment:
  DRIVE_LOCATIONS: >
    [ { "name": "Drive",   "path": "/locations/drive" },
      { "name": "Docs",    "path": "/locations/docs",    "hide": [".ssh"] },
      { "name": "Backups", "path": "/locations/backups", "mode": "ro" },
      { "name": "Media",   "path": "/locations/media",   "mode": "ro" } ]
```

Unset `DRIVE_LOCATIONS` = every directory under `/locations` is a location
(mode from whether the mount is writable). That is the whole zero-config story:
`docker run -v /some/dir:/locations/files ghcr.io/mkornas/mk-drive`.

Inside the server every filesystem call goes through one small
`StorageProvider` interface (`list`, `stat`, `read` stream with range, `write`
stream, `mkdir`, `rename`, `copy`, `remove`). v1 implements `LocalProvider` only.
The interface exists so that `SmbProvider` / `S3Provider` / `WebDavProvider`
can be added without touching routes or the UI — it is *not* an excuse to build
them now.

Anything the app owns lives under `/data` and is disposable: `thumbs/` (WebP
cache, size-capped), `shares.json` (public links), `stars.json`, `recent.json`,
and a hidden `.trash/` per writable location (original path kept in an index,
purged after 30 days).

### Deployment

A typical deployment is a normal compose stack: image from GHCR, an optional
auto-deploy on push to `main` (e.g. watchtower), a reverse proxy or Cloudflare
Tunnel in front, the app's small state dir in the backups, and the storage
mounted on the host and bind-mounted in as locations (for example a NAS export
over NFS, read-only where another app owns the files). Hosts, addresses,
exports and dataset names belong to the deployment, not to this repo.

Nothing in the app knows it is on TrueNAS or on NFS. The snapshot-based
"versions" feature from the first draft becomes an optional capability: if a
location has a `.zfs/snapshot` directory (it does, even over NFS), the details
drawer shows earlier versions; otherwise the tab is simply absent.

### Accounts — confirmed and built 2026-09-10

The first draft said "single user, one password". That is too little for what
the drive should become — a place to *give people access to things* (a folder
for the family, a client's project, a shared media library) and to hand out
links. So, real accounts, but the smallest real version:

- **Users**: email, display name, role `admin` | `member`, password hashed with
  `scrypt` from `node:crypto`, `disabled` flag. **First run** shows a setup page
  that creates the admin (or `DRIVE_ADMIN_EMAIL` + `DRIVE_ADMIN_PASSWORD` for a
  headless start). `DRIVE_PASSWORD` goes away.
- **Sessions**: server-side and revocable — "your devices" with a sign-out-everywhere
  button — 30 days, rotated on login, cookie `HttpOnly; SameSite=Lax; Secure`.
  Login throttling per address and per account; every mutation needs a JSON body
  (no form posts), which with `SameSite=Lax` closes CSRF without a token dance.
- **Grants**: per user, per location: `none` / `read` / `write`. Admins see
  everything. Locations still come from the operator's mounts; admins decide who
  sees which. The server enforces grants on every route — the UI only hides.
- **Cloudflare Access** stays as the outer lock on the internet path. An Access
  identity whose email matches a local user is signed in automatically; unknown
  emails are refused (no auto-provisioning). On the LAN, the normal login.
- **Sharing**: public links (token, expiry, optional password, file or folder,
  browse or download-only) with their own page; later "share with a user".
- **Audit log**: who did what to which path, visible to admins, in the same store.
- **Store**: `node:sqlite` (built into Node 24 — still no native module) in
  `/data/mk-drive.db`: users, sessions, grants, shares, audit. Files stay on the
  filesystem, untouched and unindexed; the app owns only its own metadata.
- Later, on the same base: passkeys / TOTP, WebDAV with per-app passwords, the
  iOS client. Nothing multi-tenant; no quotas; no "organisations".

What this costs: roughly one extra milestone (M1 becomes "accounts + manage").
What it buys: the "add users, share things" half of the idea, and a security
story that does not depend on Cloudflare being in front.

### Look and feel

"Nice and modern" is a requirement, not a polish step. Every screen goes
through a design pass (calm, spacious, distinctive rather than templated; grid
and list views; thumbnails; subtle motion; a command palette; keyboard first).
Anything that mk-kit cannot express gets built **in mk-kit** and released —
that is the point of owning the component library. Gaps found so far and their
mk-kit fixes: a per-column `compare` on `MkTableColumn` (folders-first), real
icons in `mk-tree` nodes, more languages in `mk-code`.

## 3. Backend API (Fastify)

Designed as the contract a future native client would use too: stable JSON,
ETags / mtimes on everything, chunked resumable uploads, range reads.

| Endpoint | Notes |
| --- | --- |
| `GET /api/locations` | locations + free/used space (`fs.statfs`) + capabilities (`writable`, `versions`) |
| `GET /api/ls?path=` | entries: name, kind, size, mtime, mime, etag; full listing, the client virtualises |
| `GET /api/file?path=` | stream with Range support (video seeking, resumable downloads), ETag / If-None-Match |
| `GET /api/thumb?path=&w=` | WebP thumbnail via sharp, cached; video thumbs later (ffmpeg) |
| `GET /api/zip?paths=` | streaming zip (store mode) of a folder / selection |
| `POST /api/mkdir`, `/rename`, `/move`, `/copy`, `/delete`, `/restore` | JSON bodies; delete = move to `.trash` |
| `POST /api/upload` + `PATCH /api/upload/:id` | **chunked** (8 MB, offset-based, tus-like). Mandatory: Cloudflare caps a request body at 100 MB, so a 40 GB MP4 must go in pieces. Resumable after a dropped connection. |
| `GET /api/search?location=&q=` | filename search, bounded walk (time + entry cap), streamed results |
| `GET /api/versions?path=` / `POST /api/versions/restore` | only when the location reports the `versions` capability |
| `GET/POST/DELETE /api/shares` + `GET /s/:token` | public links: expiry, optional password, folder or file |
| `GET /api/health` | `{ ok, build }` for the deploy job |

Every path is resolved with `realpath` and must stay inside its location — no
symlink escapes, no `..`. Writes are refused on `ro` locations at the API
level, not just hidden in the UI.

## 4. Frontend, and what it shows off

| Feature | mk-kit pieces |
| --- | --- |
| Shell: sidebar with locations, Recent, Starred, Trash, usage meter | `mk-app-shell`, `mk-nav-list`, `mk-progress-bar`, `mk-stat-card` |
| Three panes: folder tree · file list · details/preview | `mk-splitter`, `mk-tree`, `mk-drawer` |
| List view: sortable, multi-select, thousands of rows | `mk-table` (sort, selection, virtual rows) |
| Grid view with thumbnails | `mk-grid`, `mk-card`, `mk-image`, `mk-skeleton` |
| Path navigation | `mk-breadcrumb`, `mk-page-header`, `mk-toolbar` |
| Right-click / long-press actions | `mkContextMenuTrigger` + `mk-menu` |
| Move by dragging, upload by dropping onto a folder | `@mk-kit/ui/dnd` (`mkDrag`, `mkDropList`, `mkDropZone`) |
| Upload queue with progress, cancel, retry | `mk-file-upload`, `mk-progress-ring`, `mk-notification-center` |
| Ctrl+K jump to folder / action | `mk-command-palette`, `mkHotkeys` |
| Photos: lightbox, arrows, zoom; folder as gallery | `mk-lightbox`, `mk-image-gallery`, `mk-media-gallery` |
| Text, code, markdown, JSON, PDF, video, audio previews | `mk-code`, `mk-markdown`, `mk-json-viewer`, native `<video>`/`<audio>`/`<iframe>` |
| Details: size, dates, mime, path, versions | `mk-description-list`, `mk-timeline`, `mk-tabs` |
| Rename / new folder / move-to / share dialogs | `mk-dialog`, `mk-input`, `mk-tree-select`, `mk-datetime` |
| Feedback | `mk-toast` with undo, `mk-empty-state`, `mk-result`, `mk-loading-bar` |
| First-run tour, light/dark, Polish locale, installable | `mk-tour`, `MkThemeService`, `@mk-kit/ui/locales/pl`, PWA |

Keyboard model like a desktop file manager: arrows, Enter, Backspace,
Delete, F2, Ctrl+A/C/X/V, Space for preview, `/` for search. Phone layout:
single pane, bottom sheet for actions (`mk-bottom-sheet`), long-press = context menu.

## 5. Milestones

Each milestone ends deployed. M0 alone is already useful.

| # | Name | Delivers | Size |
| --- | --- | --- | --- |
| M0 | Browse | Scaffold (client/server/shared/Dockerfile/CI/CLAUDE.md), `StorageProvider` + `LocalProvider`, locations + `ls`, table with sort, breadcrumb + tree, download with Range, inline image/PDF/text preview, auth (Access + password), a deployment stack, an NFS-mounted `docs` location (ro for now), a public hostname. *"Open a PDF from docs on my phone."* | 1–2 d |
| M1 | Accounts + manage | SQLite store, first-run setup, users/roles/grants, revocable sessions, Access ↔ user mapping, admin pages (users, locations, devices, audit); chunked upload (drag-drop, folder upload, resume), new folder, rename, move (dnd + dialog), copy, delete → trash, restore/purge, multi-select, context menu, hotkeys, zip download, conflict prompts; per-location health (stat with timeout, "not mounted" state). | 4–5 d |
| M2 | Look | Grid view + thumbnails, lightbox/gallery, video & audio playback, code/markdown/json viewers, details drawer, search, Recent + Starred, command palette, phone layout. | 2–3 d |
| M3 | Share & keep | Public share links (`/s/<token>` page, also mk-kit), PWA, pl locale, activity timeline, usage cards, optional snapshot versions when a location has them. | 2–3 d |
| M4 | Showcase | README with screenshots and the one-line `docker run`, `DRIVE_DEMO=true` (seeds a sample tree in tmp, read-only) for a public demo, blog post on mk-kit.dev, "built with" entry in the docs, mk-kit issues for every gap found on the way. | 1 d |

### Beyond (not scheduled)

- **WebDAV endpoint** on the same server: instantly usable from macOS Finder,
  Windows Explorer, Linux file managers and iOS apps that speak WebDAV, with the
  same auth. Cheap (one library, the provider interface already fits) and the
  natural stepping stone to mobile.
- **iOS app** with a File Provider extension so mk-drive shows up in Files and
  in every "attach a file" sheet, like the Nextcloud app. Talks to the same
  `/api` (that is why the API gets ETags, chunked uploads and stable ids from
  day one). Swift, separate repo, after the web app is stable.
- **Connectors** (`SmbProvider`, `S3Provider`, `WebDavProvider`) configured in
  the UI instead of host mounts — makes the "connect your storage" promise true
  for people who cannot mount things on the host.
- Video thumbnails (ffmpeg), in-place markdown editing (`mk-block-editor`),
  a second host, multi-user.

## 6. Risks and how the plan handles them

- **100 MB request cap on the Cloudflare tunnel** → chunked, resumable uploads from M1; downloads are streamed responses (not capped).
- **NFS quirks** — no inotify, uid mapping, stale handles on NAS reboot → the app never watches directories (it re-lists), `mapall` on the export, `soft,nofail` mounts, and a location that is unreachable shows as such instead of hanging the UI (stat with a timeout).
- **Huge directories** (10k+ entries) → one JSON listing per folder is fine; the table virtualises rows; search walks are capped and streamed.
- **Path traversal / symlinks** → `realpath` inside the location on every request, tested first.
- **Thumbnail cost** → sharp with an input-pixel limit, a size-capped cache dir, lazy generation, never for `ro` media libraries above a threshold.
- **Feature creep** (it is a Google Drive clone, after all) → every milestone ships; anything not in the tables is a new card, not a detour.

## 7. Decisions to confirm before M0

1. ~~Run on the NAS vs on the app server~~ → **app server, NFS mounts, storage-agnostic app** (settled 2026-09-10).
2. Initial locations: one for uploads (rw), documents (rw, `.ssh` hidden), read-only media and backups; libraries owned by other apps excluded or read-only.
3. LAN needs the password too (recommended) vs dashboard-style trusted LAN.
4. Public repo from the first commit (recommended for a showcase) vs private until M2.

## Single sign-on (added 2026-09-10)

Sign-in through any OpenID Connect provider (Pocket ID with passkeys,
Authelia, Keycloak, …) via the shared `@mk-kit/auth` package, which every mk
app uses as its OIDC client; an access proxy in front can log in through the
same provider. mk-drive is the first client: `DRIVE_OIDC_*` enables a "Sign in with …"
button; `/auth/login` and `/auth/callback` come from `@mk-kit/auth/server`,
which also replaced the app's own Cloudflare Access verifier.

## NAS console (added 2026-09-12)

mk-drive is the UI of mk-nas (its own repo: a root agent over Ubuntu Server
and OpenZFS, an installer, a bootable image). Mounted with the agent's
socket, the drive gains an admin-only Storage section — disks, pools,
datasets, snapshots, shares, replication, health — proxied to the agent's
allow-listed verbs; everywhere else it is the plain drive. Identity stays
the drive's own accounts, so a NAS without single sign-on still works. The
pages arrive phase by phase with the agent; the mk-nas board is the list.
