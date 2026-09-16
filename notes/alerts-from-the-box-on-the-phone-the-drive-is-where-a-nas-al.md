# *Alerts from the box, on the phone** the drive is where a NAS alert reaches its owner: subscribe to web push, show what the agent reports (degraded pool, failing disk, failed scrub or backup, an update waiting) as a badge and a list, and let each kind be turned off; needs the mk-nas alert engine first

- 2026-09-16 15:49 — Pairs with the mk-nas card 'Tell me when something is wrong': the agent raises and clears the events, the drive subscribes and delivers them. Do the agent side first.
- 2026-09-16 18:42 — Done with the agent's engine (mk-nas 0.9.0) and the drive (0.9.0): push per browser per account, a bell with what is open, alerts on Storage → Overview with Acknowledge, and Settings → Notifications. Verified on the VM (raised in 8s, cleared in 12s) and on the box; the owner's test notification arrived.
- 2026-09-16 18:42 — Shipped in drive 0.9.0 / mk-nas 0.9.0; a test notification reached the owner's browser — main @ c7deea7 mk-drive 0.9.0
