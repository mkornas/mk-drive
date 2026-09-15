# *Security: symlinks escape a location** versions read/restore follow symlinks out, writes follow a final-component symlink, symlinks bypass grants and hidden names, delete acts on the target: realpath containment on every path, O_NOFOLLOW writes, lstat for rm/rename

- 2026-09-15 14:45 — Fixed in 0512c8e (mk-drive 0.6.1), with regression tests; audit proofs re-run: closed. — main @ 0512c8e Security fixes from the 2026-09-15 audit
