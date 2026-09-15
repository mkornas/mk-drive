# Storage section (NAS mode)

- 2026-09-12 18:07 — 2026-09-12: read-only Storage section shipped (health, disks, pools, datasets, snapshots) over /api/nas/*; verified against a fake agent in tests and live against mk-nasd on the dev box. Shares, replication and the SMB password wait for mk-nas phases 3-4.
- 2026-09-12 21:56 — All of it shipped across mk-nas phases 1–6: Overview, Disks, Pools (create, scrub, replace, import), Datasets (create, settings, policies, share), Snapshots, Shares, Copies, the SMB password on the account page, the outdated-agent banner. Pushed on main up to 6317db3. — main @ 6317db3 test: the outdated-agent banner
