# SMB access per share (drive)

- 2026-09-15 15:11 — Committed 77e1b7e: dialog list prefilled from grants (disabled accounts start with nothing), per-share who-can-open on the Shares page, admins-only migration at startup and on the Shares page. Verified in the VM: a pre-list share became alice write at drive start; changing it to Read in the dialog reached Samba (valid users, no write list). — main @ 77e1b7e NAS mode: who can open each SMB share
