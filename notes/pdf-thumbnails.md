# PDF thumbnails

- 2026-09-12 09:05 — Shipped 23d90a4, deployed. thumbs.ts generatePdf() via pdftocairo (stdout; pdftoppm cannot), DRIVE_PDFTOCAIRO, poppler-utils in the image, canThumb() advertises application/pdf only when detected. Tests: stand-in renderer + real poppler where present (70 total). Verified on a running drive: startup log 'PDF thumbnails: pdftocairo version 25.12.0' and page one of a sample PDF rendered inside the container. — main @ 23d90a4 PDF thumbnails: the first page, through poppler
