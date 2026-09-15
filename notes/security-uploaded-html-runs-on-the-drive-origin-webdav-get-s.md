# *Security: uploaded HTML runs on the drive origin** WebDAV GET serves .html/.svg/.xml inline with the session cookie accepted on /dav, /api/versions/file serves .xml unsandboxed: one header helper (attachment + CSP sandbox + nosniff) for every raw-file response; /dav only app passwords. Audit 2026-09-15

- 2026-09-15 14:45 — Fixed in 0512c8e (mk-drive 0.6.1), with regression tests; audit proofs re-run: closed. — main @ 0512c8e Security fixes from the 2026-09-15 audit
