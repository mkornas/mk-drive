# Search inside files

- 2026-09-12 12:45 — Shipped: GET /api/search?in=content → searchContent() in search.ts (text ≤ 2 MB, PDF ≤ 25 MB via pdftotext -l 20, 4 files at a time, 10 s / 50k entries / 256 MB budgets, 50 hits), SearchHit.snippet; browse page: 'inside files' switch in the results line, snippet under the name in list and grid. Test covers text, PDF, binary and hidden. Visual check skipped (needs a browser login). — main @ 0aab341 Search inside files: text and PDF contents, a snippet per hit
