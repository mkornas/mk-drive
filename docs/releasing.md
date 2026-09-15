# Releasing

Two ways the drive leaves this repo:

- **Every push to `main`** builds `ghcr.io/mkornas/mk-drive:latest` (and
  `:<sha>`) and calls an optional deploy hook (`DEPLOY_HOOK_URL`, e.g.
  watchtower's HTTP API) so a server pulls it (`deploy.yml`). That is the
  continuously deployed instance.
- **A version tag** `vX.Y.Z` builds `ghcr.io/mkornas/mk-drive:X.Y.Z` and a
  GitHub Release with the image as `mk-drive-X.Y.Z.tgz` and its checksum
  (`release.yml`). It never touches `:latest`. This is what an mk-nas box
  runs: mk-nas pins one drive version per mk-nas release, so a NAS only
  ever gets a pair that was released together.

To cut one, from a clean, pushed `main`:

```
tools/release.sh 0.2.0
```

It writes the version into `package.json` and `server/package.json` (the
version `/api/meta` reports), commits, tags `v0.2.0`, and pushes. Watch
the workflow with `gh run watch`. The release notes list the commits that
touched `server/`, `client/`, `shared/` or the Dockerfile since the
previous tag.

When the NAS verb contract changes (`NAS_CONTRACT` in `server/src/nas.ts`),
release mk-nas with the matching agent first; mk-nas's own release script
refuses to pin a drive whose contract is newer than its agent's.
