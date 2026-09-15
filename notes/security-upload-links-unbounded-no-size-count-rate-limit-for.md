# *Security: upload links unbounded** no size/count/rate limit for anonymous upload links, chunked PATCH without Content-Length writes past the announced size: require Content-Length, count bytes, per-link caps, space check, rate limit

- 2026-09-15 14:45 — Fixed in 0512c8e (mk-drive 0.6.1), with regression tests; audit proofs re-run: closed. — main @ 0512c8e Security fixes from the 2026-09-15 audit
