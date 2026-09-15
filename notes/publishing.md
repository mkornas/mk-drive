# Publishing checklist

What to check before the repository, or a fresh copy of it, is public.

1. Re-check the tracked files for anything about one particular deployment
   (addresses, host names, accounts, dataset names):
   `git grep -n -i -E '192\.168|homelab|infra|/srv/|@gmail'` should only hit
   generic examples and test fixtures.
2. The public history is a squashed snapshot (or rewritten with
   `git filter-repo`), so older commits are not carried along.
3. The GHCR package is public (Packages → mk-drive → Package settings); the
   README's one-line demo needs it.
4. Links point at the public repository: the mk-kit "built with" entry and
   the blog post.
