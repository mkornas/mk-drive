# mk-drive — Project Guide

## Think before coding

State assumptions; if two readings exist, name them. Prefer the simpler approach
and say so. Every changed line should trace to the request; do not refactor
neighbours. Match the existing style.

## What this is

A self-hosted web drive: point it at directories ("locations"), get a
Google-Drive-like UI. **The filesystem is the truth** — no database, no index,
no import. App-owned state (thumbnail cache, share links, trash index) lives in
`/data` and is disposable. Storage-agnostic on purpose: nothing may assume
TrueNAS, ZFS, NFS or any particular host. Single user. AGPL-3.0-only, a public
repo and the "built with @mk-kit/ui" showcase (checklist in
`notes/publishing.md`) — nothing about any deployment's network, hosts,
addresses or datasets goes into tracked files.
The full plan and milestones are in `PLAN.md`; the live backlog is `board.md`
(mk-board format, worked with the `mk-board` CLI, notes in `notes/`).

## NAS mode (see the mk-nas repo)

When `DRIVE_NAS_SOCKET` points at a mounted `/run/mk-nas.sock` (the root
agent from mk-nas), the server proxies an admin-only `/api/nas/*` to it and
the app shows a **Storage** section: health, disks, pools, datasets,
snapshots today; shares and replication with the next mk-nas phases. Without
the socket nothing changes (`Meta.nas` is unset, the routes do not exist).
The container stays unprivileged; the agent's allow-list of verbs is the
whole privilege boundary. `shared/nas.ts` is a verbatim copy of mk-nas's
`shared/types.ts` (copy, never edit here); `server/src/nas.ts` is the socket
client (one request per connection, the agent's error codes mapped to HTTP);
routes in `server/src/routes/nas.ts`; pages in `client/src/app/pages/storage/`
sharing `shell.ts` (tabs, refresh, loading and error states). None of it may
assume it is present.

## Layout

- `shared/types.ts` — the API contract (client, server and any future native client).
- `server/` — Fastify 5 on **Node 24 type-stripping**: no build, no decorators,
  no enums, no parameter properties, `import … from './x.ts'`, `import type` for
  types. `src/storage/provider.ts` is the one seam to where bytes live;
  `LocalProvider` is the only implementation. Routes in `src/routes.ts`, auth in
  `src/auth.ts` (Cloudflare Access JWT mapped to a local user → session cookie; the
  verifier comes from `@mk-kit/auth/server`). `src/sso.ts` adds `/auth/login` + `/auth/callback` (OIDC) when
  `DRIVE_OIDC_*` are set: `SsoProvider` discovers the issuer lazily (retried on every login until it answers);
  identities map to local users by email, never auto-created; sessions remember `via` so `/api/logout` can end
  the provider's session too (RP-initiated logout).
  `ops.ts` = folders/rename/move/copy/trash/zip with the conflict policy
  (`fail` | `replace` | `rename`); `routes/uploads.ts` = chunked resumable
  uploads (raw `application/octet-stream` pieces, `Upload-Offset` header).
  Per-location app state lives in `<location>/.mk-drive/{uploads,trash}`.
  `thumbs.ts` renders WebP thumbnails with sharp into `<data>/thumbs` (size-capped);
  `search.ts` is a bounded breadth-first name search; stars/recent are per-user tables.
  `routes/shares.ts` = public links (`/api/s/:id/*` needs no account; the owner's grant is
  re-checked on every hit; password unlock sets a per-share cookie); `routes/versions.ts`
  reads `<root>/.zfs/snapshot/<name>/<path>` through the provider.
  Accounts, sessions, grants and audit live in SQLite via `node:sqlite`
  (`db.ts`, `users.ts`); routes are split under `src/routes/`. Every path goes through `paths.ts` + `provider.resolve()`: the
  realpath must be exactly the typed path under the root, so symlinks inside a location are never followed (not listed,
  not opened, not written through); hidden names are refused, not just unlisted. Every response carrying file bytes
  gets its headers from `serve-headers.ts` (nosniff, and a sandbox + download for anything a browser could run).
- `client/` — Angular 22, standalone, zoneless, signals, `@mk-kit/ui` 0.60.
  Drive paths in URLs: `/d/<location>/<path>`. Pages in `src/app/pages`,
  reusable bits in `src/app/shared`, services in `src/app/core`.
- One image (`Dockerfile`), built by `.github/workflows/deploy.yml` to GHCR.

## Commands

Node must be ≥ 24.15: `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`.

```bash
npm install                      # installs server + client
npm run dev                      # server on :8810 (DRIVE_LOCATIONS_DIR=../data/locations) + ng serve on :4200
npm test && npm run typecheck    # server: node:test + tsc
npm run build                    # client → client/dist/client/browser (served by the server)
```

Local run with the built client: `cd server && DRIVE_LOCATIONS_DIR=../data/locations DRIVE_DATA_DIR=../data node src/index.ts`.
Sample locations for development live in `data/locations/` (git-ignored).

## Conventions

- Commits: plain `git commit -s` as Mateusz Kornaś, **no AI co-author trailers** (public repo).
- Tokens only in styles (`--mk-*`); no hardcoded colours.
- Server tests use `createApp()` + `app.inject()` against a temp directory; add one for every new route.
- Every route resolves the caller's grant for the location (`resolve(req, path, 'write')` in `routes/files.ts`); admins-only routes call `admin(req)`. Never rely on the UI hiding things.
- Design: the mk-kit **Momentum preset** (`client/src/styles/momentum-preset.css`, vendored from mk-kit's `styles/presets/momentum.css` until the package ships it; `data-mk-preset="momentum"` on `<html>`): Manrope, violet-grey surfaces, and the drive's own accent is
  Momentum's **Bumblebee** (yellow `#FFC400`, black on it; tokens in `client/src/styles.scss`,
  the icon in `client/public/icon.svg`). Tokens only, no hardcoded colours; the preview stage is the one bold element. Load the frontend-design skill before adding screens.
- Anything an operator sets is an env var documented in `README.md` and `docker-compose.yml`.
- Critical-CSS inlining stays **off** in `client/angular.json` (`inlineCritical: false`): the CSP has no `unsafe-inline`, so the `onload` trick Angular's inliner puts on the stylesheet link never fires and the page renders with the kit's base theme and the system font.
