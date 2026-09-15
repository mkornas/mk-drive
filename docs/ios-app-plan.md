# mk-drive for iOS — the plan

A native iPhone and iPad app for mk-drive, the way Nextcloud Files is for
Nextcloud: sign in to your drive, browse and open files, upload, share a
link, and have the drive appear inside the Files app for every other app on
the phone. In NAS mode, a read-only Storage tab. Written for a session on a
Mac; every milestone ends in something that runs.

## Decisions taken here (change them in the first session if they are wrong)

- **Its own repo, `mk-drive-ios`**, next to mk-drive. Swift only — the Files
  adapter has to be native, and one language keeps the app and the extension
  sharing code. No cross-platform kit.
- **Swift 6, SwiftUI, iOS 17 and up**, strict concurrency, `async/await`
  URLSession, no third-party packages unless a milestone below names one.
- **XcodeGen** (`project.yml` in git) generates the Xcode project, so the
  project file is never hand-edited and never merges badly. Build and test
  from the terminal: `xcodegen`, `xcodebuild -scheme mk-drive -destination
  'platform=iOS Simulator,name=iPhone 16' build test`, `xcrun simctl` to
  drive the simulator. A `Makefile` with `gen`, `build`, `test`, `run`.
- **Transport: the JSON API, not WebDAV.** It has what a client wants —
  entries with an etag and mtime, thumbnails, chunked resumable uploads, the
  trash, share links — and WebDAV stays for Finder. Auth is an **app
  password as a Bearer token** (`Authorization: Bearer <secret>`), stored
  in the Keychain and shared with the extension through an access group.
- **Three targets**: `App` (SwiftUI), `FileProvider` (the Files adapter,
  `NSFileProviderReplicatedExtension`), `Shared` (a Swift package with the
  API client, models, keychain, the local index) used by both.
- **Identifiers in the Files adapter are the drive paths.** The server has
  no stable file ids, so a rename or move shows in Files as remove + add.
  Acceptable for v1; a server-side id (device + inode) is the upgrade path,
  noted under "later".
- **Changes are polled.** The server has no change feed; the adapter
  re-lists a folder when Files asks, on app foreground, and every few
  minutes in the background. A `changes since cursor` endpoint is the
  upgrade path, also under "later".
- Bundle ids `com.mateuszkornas.mkdrive`, `.mkdrive.files` for the
  extension, app group `group.com.mateuszkornas.mkdrive`, keychain access
  group the same. A paid developer account is needed for TestFlight; a free
  personal team is enough to run on a test phone during development
  (re-signed every 7 days). Check in milestone 0 that the personal team
  allows the app group and the extension; if not, the account comes first.

## Before the app: two small things on the server (mk-drive, any machine)

1. **App passwords may read the Storage section.** `/api/nas/*` is admin-only
   and refuses app passwords (`sessionOnly`). Add a `nasReadOnly` guard used by
   the GET routes only (`version`, `health`, `system`, `network`, `disks`,
   `pools`, `pool`, `datasets`, `snapshots`, `scrubs`, `jobs`, `events`,
   `scrub-policies`, `backup`, `shares`, `replications`): admin role still
   required, app passwords allowed. Every write stays session-only. One test
   in `server/test/nas.test.ts`: a member's app password 403s, an admin's
   app password reads `/api/nas/health`, and cannot PUT `/api/nas/network`.
2. **`GET /api/me` answers a Bearer request** already; confirm, and make
   sure a wrong token gets a JSON 401 (`{ message }`) and not the Basic
   challenge that WebDAV clients need — key on `Authorization: Bearer`.

Both go into mk-drive with tests before the Mac session starts, so the
phone can be tested against a real server from day one.

## The API the app uses (as it is today)

| Need | Call | Notes |
| --- | --- | --- |
| Who am I, is this a drive, NAS mode | `GET /api/meta` (public), `GET /api/me` | `Meta.nas`, `Meta.name`, `me.role` |
| Sign in to mint an app password | `POST /api/login {email,password}` → `mkdrive_session` cookie; `POST /api/app-passwords {name}` → `{ secret }` once; then drop the session | Single sign-on: open `/auth/login` in `ASWebAuthenticationSession`, land on a page that creates the app password — needs a small server page, see M1 |
| Locations | `GET /api/locations` | name, mode (`rw`/`ro`), access, space |
| List a folder | `GET /api/ls?path=<location>/<dir>&hidden=0` | `Listing.entries[]`: `path`, `kind`, `size`, `mtime` (ms), `mime`, `etag`, `thumb`, `taken` |
| Download | `GET /api/file?path=…` (`download=1` for attachment) | streams; `ETag`; supports `Range` for resume — verify |
| Thumbnail | `GET /api/thumb?path=…&w=256` | only when `entry.thumb` |
| Upload (any size) | `POST /api/uploads {dir,name,size,mtime}` → `{id,offset,…}`; `PATCH /api/uploads/:id` with header `Upload-Offset: <n>` and a raw body ≤ 64 MB; `GET /api/uploads/:id` to resume; `POST /api/uploads/:id/complete {onConflict: 'rename'|'replace'|'skip'}`; `DELETE` to abandon | pieces at increasing offsets; 409 on offset mismatch says how many bytes arrived |
| Small write | `PUT /api/file?path=…` with the body | fine under a few MB |
| Folder, rename, move, copy, delete | `POST /api/mkdir`, `/api/rename`, `/api/move`, `/api/copy`, `/api/delete` | delete goes to the trash |
| Trash | `GET /api/trash`, `POST /api/trash/:id/restore` | |
| Share links | `GET/POST /api/shares`, `GET /api/shares/for?path=`, `DELETE /api/shares/:id` | |
| Search, stars, recent, photos | `/api/search?q=`, `/api/stars`, `/api/recent`, `/api/photos?location=&before=` | nice-to-have screens |
| Storage (NAS mode, admin) | `/api/nas/health`, `system`, `pools`, `pools/:name`, `disks`, `events`, `jobs?pool=`, `scrub-policies`, `network`, `backup` | read only; types in `shared/nas.ts` |

Errors are JSON `{ message }` with the HTTP status; 401 means the token is
gone, 403 means not allowed, 409 a conflict the user must resolve.

## Milestones

Each one is a session or two. Finish with the acceptance checks green, a
commit, and a line in `board.md`. Do not start the next one with the
previous one red.

### M0 — Skeleton (half a day)

- `mk-drive-ios` repo: `project.yml`, `Makefile`, `Shared/` package, `App/`,
  `FileProvider/`, `Tests/`, `README.md`, a `CLAUDE.md` in the style of
  mk-drive's (think first, no private hosts in tracked files, plain
  `git commit -s`).
- Targets build for the simulator from the terminal; the app shows a
  placeholder; the extension is registered (an empty domain appears under
  Files → Browse → Locations once the app adds it).
- App group and keychain sharing configured and verified on a device with
  the personal team.
- Accept: `make build` and `make test` pass on a clean checkout.

### M1 — Connect (one to two days)

- A "Connect to your drive" screen: server URL (with `https://` assumed),
  then either **email + password** (the app calls `/api/login`, mints an app
  password named after the device, forgets the session) or **Sign in with
  …** when `Meta.sso` is set (`ASWebAuthenticationSession` to
  `/auth/login?next=/connect/app` — a small new page in the web app that
  creates the app password and hands it back on a custom scheme
  `mkdrive://connected?secret=…`; add that page to mk-drive in the same
  milestone).
- Keychain: account = server URL + email, secret = app password, shared
  access group. Several accounts are allowed; one is current.
- `Shared/APIClient`: one `URLSession`, Bearer header, typed `Meta`, `Me`,
  `Entry`, `Listing`, JSON errors mapped to a `DriveError` enum, a
  401 handler that marks the account as signed out.
- Accept: connect to a local demo drive (`DRIVE_DEMO=true node src/index.ts`
  in mk-drive; demo login `demo@example.com` / `demo-drive-2026`), see the
  drive's name from `Meta.name` in the toolbar; kill the server, get a
  readable error; wrong password, readable error. Unit tests for the client
  against recorded JSON.

### M2 — Browse and open (two to three days)

- Locations list → folder view (list and grid), sorted by name with folders
  first, pull to refresh, thumbnails through `/api/thumb` with an in-memory
  and on-disk cache keyed by `path + etag`.
- Open a file: download to the caches directory, `QuickLook` for
  everything it can show, share sheet for the rest. Progress for big files.
- Search (`/api/search`), Recent and Starred as simple lists.
- A local index (`SQLite` through `GRDB` or plain `SQLite3`; pick GRDB only
  if the amount of code it saves is obvious) of listings seen, so folders
  open instantly and offline shows what was there.
- Accept: browse the demo drive's tree, open a PDF and a photo, search for a
  file name, go offline and still see the last listing with an "offline"
  note.

### M3 — Upload and manage (two to three days)

- Upload from the share sheet, from Photos (`PhotosPicker`) and from Files:
  the chunked protocol with 8 MB pieces, resume after a network loss, a
  queue that survives app restarts, background `URLSession` for pieces.
- New folder, rename, move (folder picker), delete (to trash, with the
  trash screen and restore), share link (create, copy, revoke).
- Accept: upload a 200 MB video over Wi-Fi with airplane mode toggled midway
  and see it finish; rename and move a file and see it in the web app;
  delete and restore from the trash.

### M4 — The Files app adapter (one to two weeks; the hard part)

- `NSFileProviderReplicatedExtension` with one domain per account, added
  and removed by the app on connect and disconnect.
- Enumerators: the root lists locations as folders; a folder enumerator
  calls `/api/ls` and yields `NSFileProviderItem`s (identifier = drive
  path, parent = its folder, `contentModificationDate` = mtime, `itemVersion`
  from `etag`, `documentSize`, `contentType` from `mime`, capabilities from
  the location's mode and access). The working set enumerator replays the
  local index. Sync anchor = a counter bumped whenever a listing changed.
- Change signalling: the app calls `signalEnumerator` for a folder after
  any write it made; the extension re-lists on `enumerateChanges`; a
  `BGAppRefreshTask` every 15 minutes re-lists recently used folders.
- `fetchContents` downloads through `/api/file` with `Range` resume;
  `createItem` / `modifyItem` upload through the chunked protocol (small
  files through `PUT /api/file`); rename and move become `/api/rename` and
  `/api/move` (identifier changes: report the old one deleted and the new
  one created); `deleteItem` → `/api/delete`; `fetchThumbnails` → `/api/thumb`.
- Conflicts: when the server's etag is not the one we uploaded from, keep
  both (`onConflict: rename`) and tell Files the item changed. Never lose a
  local edit silently.
- Read-only locations report no write capabilities.
- Accept: the drive appears in Files; open a document from another app,
  edit and save it, see the new etag in the web app; copy a folder in from
  iCloud; rename in Files, see it in the web app; go offline, edit, come
  back, see it upload. Log through `OSLog` with a `files` category and a
  `make logs` target that runs `log stream`.

### M5 — Storage tab, read only (three to four days)

- Shown when `Meta.nas` and the account is an admin (needs the server
  change above). Screens: **Overview** (the health alert, the day's events,
  the vitals tiles with Swift Charts sparklines from `history`, pools with
  their bars, disks as bays), **Pools** (status tree, the running scan from
  `jobs?pool=`, the scan history), **Disks** (SMART summary, self-test
  status), **Network** (name, addresses). Nothing that changes anything;
  the web app is where that lives, and a "Manage in the browser" link opens
  it.
- Push nothing yet; the app polls every 10 s while a Storage screen is open.
- Accept: against the fake agent (`node tools/fake-nas-agent.mjs
  /tmp/nas.sock` in mk-drive with `DRIVE_NAS_SOCKET=/tmp/nas.sock`), the
  degraded pool and the pending-sectors disk show as such; against the real
  NAS, the same pages match the web app.

### M6 — Photo backup (one week, optional for v1)

- Opt in per account: back up new photos and videos to a chosen folder.
  PhotoKit fetch of assets newer than the last marker, original files,
  filename `IMG_<asset id prefix>` to dedupe, uploads through the queue
  from M3 with `BGProcessingTask` at night and on power.
- Accept: 300 photos back up overnight with the app closed; a photo taken
  after that appears the next time the app opens.

### M7 — Ship

- App icon (the drive's folder mark), launch screen, empty states, error
  copy in the app's voice (sentence case, plain verbs, what happened and
  what to do), VoiceOver labels on every control, Dynamic Type checked.
- Privacy manifest, TestFlight build, `README.md` with a screenshot and the
  connect steps, `docs/` in mk-drive linking here.

## Later (not in v1)

- A stable file id from the server (device + inode in `Entry.id`) so
  renames stay renames in Files.
- `GET /api/changes?since=<cursor>` fed by a change journal, so the adapter
  stops polling.
- Push notifications for the Storage problems, once the NAS has a way to
  send them (see the mk-nas board: notifications).
- Widgets: free space and the health dot on the home screen.
- Mac Catalyst or a Mac build of the same targets.

## How to work it in Claude Code on the Mac

- One milestone per session; start with `make gen build test`; end with the
  acceptance list checked by hand on the simulator, a commit, the board.
- The simulator can reach a drive on the same Mac at `http://localhost:8810`;
  a device needs the Mac's LAN address or the real NAS. App Transport
  Security allows `http` only for local addresses — keep an ATS exception
  for `localhost` in debug builds and nothing else.
- Tests: `Shared` has unit tests with recorded JSON; the app has a few UI
  tests for connect and browse against the demo drive started by the test
  runner (`make demo` in mk-drive runs the server on 8810 in demo mode).
- Every screenshot in the README is from the simulator via
  `xcrun simctl io booted screenshot`.
- Nothing about anyone's network, hosts or addresses in tracked files; the
  demo drive and `example.com` names in tests and docs.

## Open before starting

- Team and bundle id prefix (the ones above are a guess).
- Minimum iOS: 17 (Swift Charts, `PhotosPicker`, replicated extension are
  all there); 16 would cost the sparklines little else.
- Is M6 (photo backup) wanted in v1, or does the Photos → share sheet →
  upload path do for now?
