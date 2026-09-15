# Roadmap

Where mk-drive is going, in order. The cards on the board are the working
list; this note is the shape behind them. `PLAN.md` has the full design and
the history of the milestones.

## Shipped

- **M0–M4 (2026-09-10)** — browse, preview, download; accounts, grants,
  sessions, audit; uploads, folders, trash, zip; grid + thumbnails, search,
  recent, starred, command palette; public links, snapshot versions; demo
  mode, README, blog post. Deployed.
- **Single sign-on (2026-09-10)** — any OIDC provider (e.g. Pocket ID with passkeys) through `@mk-kit/auth`.
- **Own door (2026-09-11)** — Cloudflare Access no longer needed, password login only
  from trusted networks (`DRIVE_PASSWORD_LOGIN=lan`), see `cloudflare-access.md`.
- **mk-kit 0.59 (2026-09-11)** — the workarounds the library made
  unnecessary are gone.

## Now: a drive for more than one person

Give people access to things without giving them a whole location.

1. **Share with a user** — a folder granted to a local account, read or
   write, capped by what the sharer may do; "Shared with me" in the sidebar.
2. **Per-app passwords** — revocable tokens for non-browser clients.
3. **WebDAV** — the same server and grants in Finder, Explorer and iOS Files.
4. **Video thumbnails** when ffmpeg is present.

## Later: reach

- Polish locale (app-level i18n, not just the component pack).
- In-place markdown editing with `mk-block-editor`.
- Connectors (SMB, S3, WebDAV) configured in the UI instead of host mounts.
- iOS app with a File Provider extension over the same API.

## Not planned

Nextcloud-style sync clients, quotas, organisations, a database index of the
files. The filesystem stays the truth.
