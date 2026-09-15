# mk-drive — how it works and how to run it

A guide for the person who runs the drive and the people who use it. The
README is the short version; this is the long one.

## 1. The idea in one paragraph

mk-drive is a web front for directories you already have. You point it at one
or more folders, called **locations**, and it gives you a Google-Drive-like
app over them: browse, preview, upload, organise, share. **The filesystem is
the truth.** There is no database of your files, no import, no sync client.
Whatever the drive shows is what is on disk right now, and whatever you do in
the drive happens on disk right away. Everything the app itself owns (accounts,
sessions, share links, the trash index, thumbnails) lives in one small data
directory and can be thrown away without losing a single file.

## 2. The pieces

| Piece | What it is | Where it lives |
| --- | --- | --- |
| Location | A directory the drive exposes, read-write or read-only | a mount into the container, `/locations/<name>`, or a connector (WebDAV / S3) added under Settings → Locations |
| Account | A person: email, name, role `admin` or `member` | SQLite in the data dir |
| Grant | What an account may do in a location: nothing, view, edit | SQLite |
| Share with a user | One folder or file handed to another account, view or edit | SQLite |
| Public link | A URL to a file or folder for people without an account | SQLite |
| App password | A secret for programs (curl, WebDAV clients) | SQLite (hashed) |
| Trash | Deleted items, kept 30 days | `<location>/.mk-drive/trash` + an index in SQLite |
| Uploads in flight | Pieces of a chunked upload until it completes | `<location>/.mk-drive/uploads` |
| Thumbnails | WebP previews, size-capped cache | `<data>/thumbs` |
| Versions | Earlier copies of a file, when the location has ZFS snapshots | read from `<location>/.zfs/snapshot`, never written |

Admins see every location. Members see only the locations they were granted,
plus folders shared with them. The server checks this on every request; the
UI merely hides what you cannot open.

## 3. Setting it up

### 3.1 The one-line trial

```bash
docker run --rm -e DRIVE_DEMO=true -p 8810:8810 ghcr.io/mkornas/mk-drive
```

Open http://localhost:8810, sign in as `demo@example.com` / `demo-drive-2026`.
The sample data is recreated on every start. Never use demo mode with real
data.

### 3.2 A real install

1. **Mount your folders** under `/locations` (one subdirectory per location)
   and a data directory at `/data`. Read-only mounts become read-only
   locations automatically. Use `DRIVE_LOCATIONS` (a JSON array) when you want
   names, icons, a `hide` list or an explicit mode.
2. **Run the container as the user that owns the files** (`user: "1000:1000"`
   in compose, or whatever `id -u` says on the host). The drive writes with
   that identity; this is what makes uploads land with the right owner on a
   NAS export.
3. **Create the admin**: either open the app and use the set-up page, or set
   `DRIVE_ADMIN_EMAIL` and `DRIVE_ADMIN_PASSWORD` for a headless first start.
   They are read once, to create that first account; afterwards the password
   lives only in the app, and the env value can be removed. Keep it somewhere
   if you rely on the password door — or use the reset in section 5.
4. **Put it behind HTTPS.** A reverse proxy or a Cloudflare Tunnel in front;
   the app sets `Secure` cookies when it sees the connection is TLS
   (`X-Forwarded-Proto: https` or Cloudflare's headers). Requests through a
   Cloudflare Tunnel are capped at 100 MB, which is why uploads are chunked.
5. **Back up `/data`.** It is small: accounts, grants, shares, links, the trash
   index. The files themselves are the storage's job (snapshots, replication).
   The thumbnail cache is disposable.

A minimal `docker-compose.yml`:

```yaml
services:
  mk-drive:
    image: ghcr.io/mkornas/mk-drive
    user: "1000:1000"
    ports: ["8810:8810"]
    environment:
      DRIVE_ADMIN_EMAIL: you@example.com
      DRIVE_ADMIN_PASSWORD: change-me
      DRIVE_LOCATIONS: >
        [ { "name": "Drive", "path": "/locations/drive", "icon": "hard-drive" },
          { "name": "Docs",  "path": "/locations/docs",  "hide": [".ssh"] },
          { "name": "Media", "path": "/locations/media", "mode": "ro" } ]
    volumes:
      - /srv/drive:/locations/drive
      - /srv/docs:/locations/docs
      - /srv/media:/locations/media:ro
      - ./data:/data
```

Every setting is an environment variable; the README has the full table.

### 3.2b Locations without a mount: connectors

Under **Settings → Locations** an admin can add a WebDAV server (Nextcloud's
`remote.php/dav/files/<user>/`, another mk-drive's `/dav/<location>/`) or an
S3 bucket (AWS, MinIO, Backblaze B2, Cloudflare R2, with an optional prefix)
as a location. Give it a name, choose read-only or read-write, and it joins
the sidebar with the same grants, sharing and trash as a mount. The
connection is tested before it is saved. SMB shares are mounted on the host
instead (`cifs` in fstab, then bind-mounted into `/locations`).

### 3.3 Signing in

Three doors, all optional beyond the first:

- **Password** — always there. `DRIVE_PASSWORD_LOGIN` says where the form is
  offered: `on` everywhere (default), `lan` only from private addresses (the
  internet then sees single sign-on alone), `off` never.
- **Single sign-on** — any OpenID Connect provider (Pocket ID, Authelia,
  Keycloak, …). An admin sets it on **Settings → Sign-in**: register the
  client at the provider with the redirect URI and logout URL that page shows
  (`https://<drive>/auth/callback`, `https://<drive>/login`), then enter the
  button name, issuer, client ID and secret. The drive reads the provider's
  discovery document before saving, keeps the secret in its database and
  never shows it again; it takes effect without a restart. Or set
  `DRIVE_OIDC_ISSUER`, `DRIVE_OIDC_CLIENT_ID`, `DRIVE_OIDC_CLIENT_SECRET` and
  `DRIVE_OIDC_NAME` in the environment: those win and the page shows them
  read-only. With `DRIVE_PASSWORD_LOGIN=off` the page will not turn single
  sign-on off. The provider says
  who you are; the drive still only lets in emails that have an account here.
  Nobody is created automatically.
- **Cloudflare Access** — if the drive sits behind an Access application, set
  `DRIVE_ACCESS_TEAM` and `DRIVE_ACCESS_AUD` and an Access identity signs in
  as the local account with the same email.

Sessions are server-side and revocable (**Settings → Devices**). Sign-in
attempts are throttled per address and per account.

### 3.4 Recommended shape for a home server

An example setup: the container runs on a small Linux
box, the storage is a NAS dataset mounted over NFS on the host and bind-mounted
into the container, the public name goes through a Cloudflare Tunnel, sign-in
is a passkey through an OIDC provider, and the password stays as the LAN-only
fallback (`DRIVE_PASSWORD_LOGIN=lan`). Nothing in the app knows any of this;
it only ever sees a directory.

## 4. Using it

### Home

Opening the drive lands you on **Home**: a search box that looks across
every location you can open (by name, or inside files), the locations with
how full each one is, *New on the drive* (the latest uploads you may see, including what
visitors sent through your file-request links, with who and when), and the
files you opened or starred lately. It is read off the activity log and the
filesystem as you open it; nothing is indexed.

### Browsing and files

- **List or grid**; folders first; sort by name, size or date. Thumbnails for
  images, poster frames for videos and first pages for PDFs (the image ships
  ffmpeg and poppler; without them those files simply show an icon); a
  lightbox for photos; previews for PDF, video, audio, text, code, markdown
  and JSON in the side drawer.
- **Upload** with the button, by dropping files or whole folders on the page,
  or onto a folder row. Uploads go in 8 MB pieces and resume after a dropped
  connection. On a phone with the app installed (browser menu → *Add to
  Home Screen*), the share sheet of any app lists mk-drive: shared photos and
  files land on a *Save to the drive* page where you pick the folder.
- **Organise**: new folder, rename (F2), move and copy (drag rows onto folders
  or breadcrumbs, or use *Move to…*), multi-select, zip download. On a name
  clash you are asked: replace, keep both, or skip.
- **Details…** on a folder (right-click) counts what is under it: size, files,
  folders, the last change and the largest files. It walks the tree as you
  watch, and says so when a huge folder made it stop early.
- **Delete** moves to the trash; **Trash** (the bin icon in a location) lets you
  restore or delete for good; anything older than 30 days is purged.
- **Search** the current folder and below by name (bounded, so it never hangs
  on a huge tree). Switch on *inside files* to look through the contents of
  text files and PDFs instead: each hit shows the words around the match. It
  reads files as it goes rather than keeping an index, so it stops early on a
  huge tree and tells you so; search from a folder closer to what you want.
  PDFs need poppler in the image (it is there; `DRIVE_PDFTOTEXT` points
  elsewhere if needed). **Recent** and **Starred** in the sidebar. **Ctrl/⌘ K**
  opens the command palette.
- **Hidden files** (dotfiles) are hidden by default; the switch in the toolbar
  shows them. Names listed in a location's `hide` (and `.zfs`, `.mk-drive`,
  `.trash`) are never shown or served, to anyone.
- **Versions**: on a location backed by ZFS snapshots, a file's preview lists
  its earlier versions with a restore button.
- **Edit text in place**: markdown, JSON and plain-text files (up to 512 KB)
  have an *Edit* button in the preview; ⌘/Ctrl+S saves. A file that changed on
  disk since you opened it is not overwritten — you are asked to reload.

### Sharing

- **Public link** — select a file or folder, *Share*, *Create link*: a lifetime,
  an optional password, and for folders what the link allows: browse inside,
  download a single zip, or add files only. Links open at `/s/<id>` with no
  account. They die when removed (**Settings → Links**), when they expire, or
  when the owner loses access.
- **File request** — the *add files only* link. Visitors get a drop zone and
  nothing else: they cannot list, open or download anything, and a name that
  is already taken gets a numbered sibling rather than replacing the file.
  Use it to collect documents from clients or photos from guests. It needs
  edit access to the folder and stops working if you lose it; every file that
  arrives is in the activity log under your name with the link's id.
- **Share with a person** — in the same dialog, enter the email of an account on
  this drive and pick *can view* or *can edit*. They find the folder or file
  under **Shared with me** and reach only that. You can hand out at most what
  you have, and the share follows your access. Either side can end it.

### People (admins)

**Settings → People**: add accounts, set the role, disable or remove, and set
each account's grant per location. **Settings → Activity** is the audit log:
sign-ins, changes to people, and every file operation with who and when.

### Programs and other devices

- **App passwords** (**Settings → Devices**): a long random secret with your
  access, shown once, for programs that cannot sign in with a browser. It
  cannot change the account or make more app passwords.
- **The API** at `/api/…` takes them as `Authorization: Basic email:secret` or
  `Bearer secret`. `curl -u you:<secret> https://<drive>/api/ls?path=Docs`.
- **Settings → Connect** shows the steps for the computer or phone you are
  on, with the address filled in and a button that makes the app password.
- **WebDAV** at `https://<drive>/dav/`, with your email and an app password
  (the account password does not work here): mount the drive in Finder (*Go →
  Connect to Server*), Windows Explorer (*Map network drive*) or GNOME Files.
  Same grants, same trash. On iPhone and iPad the Files app itself only
  connects to SMB; install a WebDAV client (Documents by Readdle, FE File
  Explorer, Owlfiles), add the address there, and the drive appears in Files
  under Browse → Locations, including in every app's file picker.

## 5. When something is off

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| A location shows "not mounted" | The mount behind it is gone or unreadable | Fix the mount on the host; the drive re-checks by itself |
| Uploads fail at ~100 MB | A proxy caps request bodies | The app already chunks at 8 MB; check the proxy is not buffering |
| A sign-in button does nothing after an update | The browser holds the old app shell | Reload once; the "new version" prompt does the same |
| Brief 504s | The container is restarting (a deploy) | Wait a few seconds |
| "no account for …" after single sign-on | The provider knows you, the drive does not | An admin adds the account under People |
| A shared folder vanished for someone | The owner lost their grant or account | Re-share from an account that has access |
| Wrong owner on uploaded files | The container runs as the wrong uid | Set `user:` in compose to the owner of the files |
| Nobody remembers the admin password | It was set once, at the first start | An admin sets it under People (the key icon); with no admin able to sign in, `docker exec -it mk-drive node src/cli.ts password you@example.com` |

Logs: `docker logs mk-drive`. Health: `GET /api/health` returns the running
build. The audit log in the app answers "who did what".

## 6. What it is not

Not a sync client, not a photo manager, not multi-tenant, no quotas, no index.
If you need desktop sync, keep Nextcloud or Syncthing beside it; mk-drive is
for opening any directory in a browser or in Files, instantly.
