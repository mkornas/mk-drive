#!/usr/bin/env bash
# Cut a release: tools/release.sh 0.2.0
# Sets the version the app reports, commits it, tags vX.Y.Z and pushes both; the Release workflow does the rest
# (tests, ghcr.io/mkornas/mk-drive:X.Y.Z, the GitHub Release with the image tarball).
set -euo pipefail
v=${1:?usage: tools/release.sh X.Y.Z}
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "release.sh: $v is not X.Y.Z" >&2; exit 2; }
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ $(git branch --show-current) == main ]] || { echo "release.sh: not on main" >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo "release.sh: the tree has changes; commit or stash them first" >&2; exit 1; }
git fetch -q origin
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] || { echo "release.sh: main is not the same as origin/main; pull or push first" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$v" >/dev/null && { echo "release.sh: v$v exists already" >&2; exit 1; }
for f in package.json server/package.json; do
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('$f'));p.version='$v';fs.writeFileSync('$f',JSON.stringify(p,null,2)+'\n')"
done
(cd server && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null)
git add package.json server/package.json server/package-lock.json
git commit -q -s -m "mk-drive $v"
git tag -a "v$v" -m "mk-drive $v"
git push -q origin main "v$v"
echo "pushed v$v — the Release workflow builds ghcr.io/mkornas/mk-drive:$v: gh run watch \$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
