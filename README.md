# mk-drive

[![Licence: AGPL-3.0-only](https://img.shields.io/badge/licence-AGPL--3.0--only-blue)](LICENSE)
[![Build](https://github.com/mkornas/mk-drive/actions/workflows/deploy.yml/badge.svg)](https://github.com/mkornas/mk-drive/actions/workflows/deploy.yml)

A self-hosted web drive for one household or one small team. Point it at the
directories you care about — a disk, an NFS or SMB mount from a NAS, a USB
stick, a WebDAV server, an S3 bucket — and get a fast, keyboard-friendly,
installable web UI to browse, preview, upload and share what is there.

There is no import step, no catalogue of your files and no search index: **the
filesystem is the truth**, so nothing is locked in and the files stay usable by
everything else on the box. The drive keeps only what a filesystem cannot —
accounts, grants, share links — in one SQLite file. One container, an Angular
22 client on [@mk-kit/ui](https://mk-kit.dev), a Fastify API on Node 24.

Version 0.9.0. Part of [mkapps.dev](https://mkapps.dev); on a machine running
[mk-nas](https://github.com/mkornas/mk-nas) the same app is also the NAS
console.

![Grid view with thumbnails](docs/screenshots/grid.jpg)

| Preview drawer with earlier versions | People and their access |
| --- | --- |
| ![Preview](docs/screenshots/preview.jpg) | ![People](docs/screenshots/people.jpg) |

## Try it

Sample data and a demo account, both recreated on every start:

```bash
docker run --rm -e DRIVE_DEMO=true -p 8810:8810 ghcr.io/mkornas/mk-drive
```

Open <http://localhost:8810> and sign in as `demo@example.com` with
`demo-drive-2026`. The demo account is a member rather than an admin, and it is
shared, so a demo drive refuses what would hit the next visitor: changing the
account or its password, other sessions, revoking app passwords. Files,
folders, share links and sharing with the second account (`guest@example.com`,
read-only) all work. Never point demo mode at real data — it resets itself.

## What it does

**Files.** List and grid views with thumbnails, a lightbox for photos, and
previews for video, audio, PDF, markdown, JSON and text. A photos view puts
every picture and video in a location on one timeline, newest first, dated by
EXIF where the file has one. Chunked, resumable uploads (drop files or whole
folders), new folder, rename, move, copy, zip download. A trash with restore
and undo. Markdown, JSON and plain text up to 512 KB have an in-place editor
that carries the file's ETag, so two people cannot overwrite each other
blindly. Search by name, or inside text files and PDFs — bounded walks, no
index. A home page with what arrived lately, recent and starred, keyboard
shortcuts, a command palette (Ctrl/⌘ K) and drag-and-drop.

**Versions.** Where a location keeps filesystem snapshots (ZFS with a visible
`.zfs/snapshot`), the preview lists a file's earlier versions with download and
"restore as a copy". Nothing is configured for it; the drive notices the
snapshot directory itself.

**Sharing.** Public links with a lifetime and an optional password; for folders
the link can browse, download one zip, or **add files only** — a file request,
where visitors drop files in without seeing what is there. Links open at
`/s/<id>` without an account, and stop the moment they are removed, expire, or
their owner loses access. A folder or a single file can also be shared with
another account on the drive, *can view* or *can edit*; it turns up under
**Shared with me** and reaches nothing else in the location.

**Who gets in.** Accounts with per-location grants (view, or view and change),
enforced on the server for every request — the UI only hides what you cannot
open. Single sign-on through any OpenID Connect provider (Pocket ID, Authentik,
Keycloak, …), set up on **Settings → Sign-in** and checked against the provider
before it is saved. Password sign-in is *everywhere*, *local network only*, or
*off* on the same page, so the internet path can show single sign-on alone
while the password stays the fallback at home. Cloudflare Access works as an
alternative front door. Either way the provider only says who you are: the
drive lets in emails that already have an account here. Sessions are
server-side and revocable, sign-ins are throttled, and every account change
lands in **Settings → Activity**.

**Other programs and devices.** App passwords for anything that cannot sign in
with a browser, with the same access as the account but none of its
administration. The same files over **WebDAV** at `/dav/`, one collection per
location, same grants and same trash; **Settings → Connect** has copy-paste
steps for Finder, Explorer, GNOME Files, rclone, curl and phones. Installed
from the browser menu the drive is a PWA and appears in a phone's share sheet.
**Connectors** let a location be a WebDAV server or an S3 bucket (MinIO,
Backblaze B2, Cloudflare R2, …) instead of a host mount — grants, sharing,
trash, search and thumbnails all work the same.

**Notifications.** **Settings → Notifications** subscribes this browser to web
push — one subscription per browser per account — and sets how loud something
has to be before it is sent. Today the drive has one thing to say: the storage
box's alerts, to admins. A pool degraded, a disk failing, a job that did not
finish; the same alert is never sent twice, and a quiet "Over: …" follows when
the box says it is fine again. A bell in the header is the same list without a
phone.

**Storage (NAS mode).** With `DRIVE_NAS_SOCKET` pointing at an
[mk-nas](https://github.com/mkornas/mk-nas) agent's socket, admins get a
Storage section: an overview with the box's health, alerts and vitals, disks
and their SMART, pools, datasets and quotas, snapshots and snapshot policies,
SMB shares with a per-person access list (and NFS shares with a host list),
copies to another machine, the network settings, power, Cloudflare Tunnel
set-up, and the updates the box has found for itself. Everyone with an account
then gets an SMB password field on their own account page. These pages live
here; they light up only when the socket is there.

## Run it

```yaml
services:
  mk-drive:
    image: ghcr.io/mkornas/mk-drive:latest
    container_name: mk-drive
    restart: unless-stopped
    user: "1000:1000"                 # the uid that owns your files
    ports: ["8810:8810"]
    environment:
      DRIVE_ADMIN_EMAIL: you@example.com   # or leave both out and use the set-up page
      DRIVE_ADMIN_PASSWORD: change-me
    volumes:
      - /srv/files:/locations/Files
      - /mnt/nas/photos:/locations/Photos:ro
      - ./data:/data
```

Open `http://<host>:8810`. The first visit shows a set-up page that creates the
admin account; after that an admin adds people in **Settings → People** and
decides, per person and per location, what they may do. See
[`docker-compose.yml`](docker-compose.yml) for a fuller file.

### Locations

Every directory directly under `/locations` becomes a location, read-only when
the mount is. Instead of that discovery you can describe them — names, icons,
top-level names to hide:

```
DRIVE_LOCATIONS=[{"name":"Docs","path":"/locations/docs","hide":[".ssh"]},{"name":"Backups","path":"/locations/backups","mode":"ro","icon":"archive"}]
```

Dotfiles are hidden by default (a switch shows them); names in `hide` — and
`.zfs`, `.mk-drive` everywhere — are never listed nor served. The app keeps its
own things (upload parts, the trash) in `<location>/.mk-drive/`, so a move to
the trash and the last step of an upload are plain renames on the same
filesystem. Uploads travel in 8 MB pieces and resume after a dropped
connection, which also keeps them under the 100 MB request cap of a Cloudflare
Tunnel.

SMB is the one thing that stays a host mount (`//nas/share` under
`/locations/…`): Node has no maintained SMB client, and a mount is the better
tool anyway.

### Configuration

| Variable | Default | What |
| --- | --- | --- |
| `PORT` / `HOST` | `8810` / `0.0.0.0` | Where the server listens |
| `DRIVE_LOCATIONS` | — | JSON array of `{ name, path, mode?, icon?, hide? }`; empty = discover |
| `DRIVE_LOCATIONS_DIR` | `/locations` | Where discovery looks |
| `DRIVE_DATA_DIR` | `/data` | App state (thumbnails, the database, upload parts) |
| `DRIVE_DB` | `<data dir>/mk-drive.db` | The SQLite file (users, sessions, grants, shares, audit) |
| `DRIVE_ADMIN_EMAIL` / `DRIVE_ADMIN_PASSWORD` | — | Create the admin on first start instead of the set-up page |
| `DRIVE_SETUP_TOKEN` | — | A code the set-up page asks for before it creates the first admin, so a fresh drive on the network does not belong to whoever opens it first (mk-nas generates one and shows it on the box). Wrong codes are throttled. Empty = no code asked |
| `DRIVE_SESSION_DAYS` | `30` | Session lifetime |
| `DRIVE_PASSWORD_LOGIN` | — | Where password sign-in works: `on` (everywhere), `local` (loopback and private addresses only, never through Cloudflare; `lan` is the old name), `off` (single sign-on must be set up first). Unset = chosen on Settings → Sign-in (`on` until then); set here it wins and the page shows it read-only |
| `DRIVE_OIDC_ISSUER` / `DRIVE_OIDC_CLIENT_ID` / `DRIVE_OIDC_CLIENT_SECRET` | — | OpenID Connect single sign-on; all three enable it and take over from Settings → Sign-in |
| `DRIVE_OIDC_NAME` | `Single sign-on` | What the sign-in button says |
| `DRIVE_COOKIE_SECRET` | random per start | Signs the ten-minute login cookie used during SSO; at least 16 characters, a shorter one stops the start |
| `DRIVE_ACCESS_TEAM` / `DRIVE_ACCESS_AUD` | — | Cloudflare Access team and application audience |
| `DRIVE_TRUSTED_PROXIES` | `127.0.0.0/8,::1/128` | Proxies whose `X-Forwarded-For` and `CF-Connecting-IP` are believed (throttling, audit). With a tunnel, include where `cloudflared` connects from, or every visitor through it shares one address |
| `DRIVE_HIDE` | `.zfs,.mk-drive,.trash` | Names never shown anywhere |
| `DRIVE_TRASH_DAYS` | `30` | How long deleted items stay in the trash |
| `DRIVE_STAT_CONCURRENCY` | `32` | Parallel `stat()` calls per listing (network filesystems like this bounded) |
| `DRIVE_THUMB_DIR` / `DRIVE_THUMB_CACHE_MB` | `<data dir>/thumbs` / `512` | Thumbnail cache location and size cap |
| `DRIVE_FFMPEG` | `ffmpeg` | Video poster frames; missing = no video thumbnails (the image ships it) |
| `DRIVE_PDFTOCAIRO` | `pdftocairo` | PDF first-page thumbnails; missing = no PDF thumbnails (the image ships it) |
| `DRIVE_PDFTOTEXT` | `pdftotext` | So "search inside files" reads PDFs too; missing = text files only (the image ships it) |
| `DRIVE_VAPID_SUBJECT` | — | Web push: how a push service can reach you about this drive's requests (a `mailto:` or a URL) |
| `DRIVE_VAPID_PUBLIC` / `DRIVE_VAPID_PRIVATE` | made once | Web push signing keys. Unset, the drive makes a pair on first use and keeps it in its database; changing them makes every existing subscription useless |
| `DRIVE_NAS_SOCKET` | — | NAS mode: the [mk-nas](https://github.com/mkornas/mk-nas) agent's socket mounted in; admins get the Storage section |
| `DRIVE_NAS_MONITOR_TOKEN` | — | NAS mode: a token of 32+ characters that lets a monitor read `GET /api/nas/monitor` with `Authorization: Bearer <token>` — the pools', disks' and agent's health, nothing else. Empty = no such route |
| `DRIVE_DEMO` | `false` | Sample location + demo admin, recreated on every start (never for real data) |
| `DRIVE_DEMO_PASSWORD` | — | Demo mode: the demo account's password. Set one and it is never printed on the sign-in page, so only whoever you told can open the demo. Unset, every visitor is shown `demo-drive-2026` |
| `DRIVE_DEMO_SEED` | — | Demo mode: a directory copied into the demo location on every start. `tools/demo-seed/build.mjs` builds one from public-domain sources |
| `DRIVE_STATIC_DIR` | the built client | Where the SPA is served from; empty = API only |

Locked out? An admin can set anyone's password in **Settings → People**. With
nobody able to sign in at all, reset one from inside the container:
`docker exec -it mk-drive node src/cli.ts password you@example.com` (`… users`
lists the accounts). `DRIVE_ADMIN_PASSWORD` only ever creates the first
account. If a provider breaks and password sign-in is off, `DRIVE_PASSWORD_LOGIN=on`
in the environment wins over the page.

## mk-drive and mk-nas

mk-drive runs anywhere on its own: a laptop, a VPS, a NAS you do not control.
[mk-nas](https://github.com/mkornas/mk-nas) is the other half — a root agent
over Ubuntu Server and OpenZFS that turns an old PC into a NAS, with an
installer and a bootable stick. It has no UI of its own; it mounts its socket
into this container and the Storage section appears.

```
browser ──HTTPS──▶ mk-drive (container, unprivileged: accounts, SSO, files,
                      │       and the Storage section when the socket is in)
                      │ JSON over /run/mk-nas.sock
                   mk-nasd  (root service on the box: an allow-list of verbs)
                   Ubuntu Server LTS + OpenZFS + Samba + NFS
```

The two are released as a pair; an mk-nas release names the mk-drive version it
ships with, and the drive asks for an upgrade when the agent it finds is older
than the contract it speaks.

## On iPhone and iPad

**MK Drive** is a separate native app that puts the drive under *Locations* in
the Files app, so any app on the phone can open and save to it, plus a small
app of its own for browsing, previewing and uploading. It signs in with an app
password and syncs nothing ahead of time. It is a paid app, one price, no
subscription. 1.0 is built and on TestFlight, on its way to App Store review;
no date is promised. The plan is in
[`docs/ios-app-plan.md`](docs/ios-app-plan.md); the app has its own repository.

## Requirements

A host with Docker; the image is `node:24-alpine` with ffmpeg and
poppler-utils, runs as a non-root user and fits inside 256 MB. The server has
no build step — Node 24 runs the TypeScript sources directly. Nothing else: no
external database, no cache, no message queue. Put the drive behind a reverse
proxy or a Cloudflare Tunnel for HTTPS — the session cookie
becomes a `__Host-` cookie there, which no sibling subdomain can plant or
overwrite.

## Security

Grants are checked on the server for every request, not in the browser.
Passwords are hashed with scrypt; sign-in attempts are throttled per address
and per account; sessions are server-side and can be revoked one by one or all
at once. Symlinks inside a location are never followed — they are left out of
listings and cannot be opened, written through or deleted — so a link can never
reach a folder someone has no grant on, a hidden name, or anything outside the
location. File responses are never content-sniffed, and anything a browser
could render actively (HTML, SVG, XML) is served with `Content-Security-Policy:
default-src 'none'; sandbox` and as a download unless it is the app's own
preview. Cross-site requests are refused: a mutating request must come from
`Sec-Fetch-Site: same-origin` (or carry a matching `Origin`), and its body must
be JSON or an upload chunk, which an HTML form cannot send. The app itself
ships a strict CSP with no inline scripts. App passwords cannot manage the
account — no password change, no sessions, no minting more — so a leaked one
cannot widen itself. Everything the app owns,
credentials for connectors included, lives in the SQLite file in the data
directory; treat `/data` accordingly.

## Develop

`npm install` installs both halves. `npm run dev` starts the API on :8810 and
`ng serve` on :4200 (proxied); put some directories under `data/locations/` to
have something to browse. `npm test` runs the server tests, `npm run build`
builds the client the server serves.

To look at the Storage pages without a NAS,
`node tools/fake-nas-agent.mjs /tmp/nas.sock` answers every agent verb with a
two-pool box's worth of data (a degraded pool mid-rebuild, a disk with pending
sectors, events, vitals, a network); `--empty` gives a box fresh from the
installer, which is what the set-up wizard wants. Point the server at it with
`DRIVE_NAS_SOCKET=/tmp/nas.sock` and an admin account — Storage is admin-only.

Releases: `tools/release.sh X.Y.Z` tags a version; the Release workflow
publishes `ghcr.io/mkornas/mk-drive:X.Y.Z` and a GitHub Release with the image
as a tarball, without touching `:latest`
([`docs/releasing.md`](docs/releasing.md)).

## Documentation

- [`docs/GUIDE.md`](docs/GUIDE.md) — the long version: the pieces, setting it
  up properly, using it, what to do when something is off.
- [`docs/releasing.md`](docs/releasing.md) — cutting a release.
- [`docs/ios-app-plan.md`](docs/ios-app-plan.md) — the iOS app.
- [`PLAN.md`](PLAN.md) — the design and what is next.

## Licence

AGPL-3.0-only — see [LICENSE](LICENSE). © 2026 Mateusz Kornaś. A commercial
licence (use without the AGPL's obligations) is available: hi@mateuszkornas.com.
