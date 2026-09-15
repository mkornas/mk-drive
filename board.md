---
kanban-plugin: board
updated: 2026-09-14
---

# mk-drive

One card per line, ranked top-down inside each column. `#p0`..`#p3` = priority, `[[name]]` = notes/name.md.

## Now

## Next

- [ ] *Datasets page polish** tree indentation by hierarchy, used bar relative to quota, 'Open in the drive' link for location datasets, snapshot count per dataset, delete dataset with typed name once the agent has dataset.destroy #p2 #nas [[datasets-page-polish-tree-indentation-by-hierarchy-used-bar]]
- [ ] *Snapshots page polish** group by dataset with a dataset filter select, relative times, 'Browse files' link into the drive's versions (.zfs/snapshot) for location datasets, delete several at once with one typed confirmation #p2 #nas [[snapshots-page-polish-group-by-dataset-with-a-dataset-filter]]
- [ ] *Live storage state** poll every 30 s while a scrub or resilver runs, and a Storage badge in the sidebar when health is not ok; SSE from the agent later #p2 #nas [[live-storage-state-poll-every-30-s-while-a-scrub-or-resilver]]
- [ ] *Storage on a phone** every Storage page and dialog at 400 px: stacked tables, forms in one column, the vdev tree scrollable #p2 #nas
- [ ] *Storage commands in the palette** 'Snapshot <dataset> now', 'Scrub <pool>', 'Go to Storage' #p3 #nas
- [ ] **iOS app, server prep** app passwords may read /api/nas/* (admin role, GET only; writes stay session-only) and a Bearer 401 is JSON, not the Basic challenge; the /connect/app page that mints an app password after SSO — docs/ios-app-plan.md, do before the Mac session #p2 #ios
- [ ] **iOS app** native SwiftUI app + Files adapter (File Provider) + read-only Storage tab, in its own repo mk-drive-ios; the plan with milestones M0–M7 is docs/ios-app-plan.md — worked on macOS #p2 #ios
- [ ] **iOS app: say why a home address is refused** when iOS blocks plain http (NSURLErrorAppTransportSecurityRequiresSecureConnection, -1022) — a name like nas.home.arpa is neither an IP, a .local name nor dotless — tell the person to type http://<box>.local:8810 or the IP with the port instead of a generic 'can't connect'; and when a local address times out, mention Local Network permission and that a guest network may not reach the server #p2 #ios
- [ ] **iOS app: a home and an outside address** the account keeps two server addresses for the same drive (e.g. http://mk-nas.local:8810 and https://drive.example.com), uses the local one when it answers on the current network and the outside one otherwise, re-checked when the network changes; both ends are the same drive, so the app password and the Files adapter's items stay valid; the Files extension follows the same choice #p2 #ios

## Later

- [ ] **Polish locale** app-level i18n (mk-kit pl pack alone gives a mixed-language UI, deferred in M3) #p3 #i18n
- [ ] **iOS app** File Provider extension over /api (ETags, chunked uploads); Swift, separate repo, after the web app is stable #p3 #beyond

## Done
- [x] *Network settings page** Storage → Network: hostname, per-interface DHCP/static address, gateway, DNS; a change is applied with a countdown and reverts unless the page confirms it still reaches the NAS; shows the mDNS name to type on other machines #p2 #nas [[network-settings-page-storage-network-hostname-per-interface]]
- [x] *Storage overview: vitals with graphs** a row of sparklines on the Overview from the agent's system verb — CPU, memory, network in/out, disk I/O, the hottest temperature — with the last 30 minutes, following the dataviz rules (one palette, no chart junk); the pool bars stay the hero #p2 #nas [[storage-overview-vitals-with-graphs-a-row-of-sparklines-on-t]]
- [x] *First-run wizard** an empty NAS gets one flow instead of three pages: pick two free disks → mirror → first dataset as a location → done; the same steps the pages offer, in order, with the typed confirmation once #p1 #nas [[first-run-wizard-an-empty-nas-gets-one-flow-instead-of-three]]
- [x] **Storage section (NAS mode)** DRIVE_NAS_SOCKET → /api/nas proxy to mk-nasd (admins only) and Storage pages that appear only with the socket: Disks, Pools, Datasets, Snapshots, Health first (mk-nas phase 1), then shares, replication, SMB password on the account page #p2 #nas [[storage-section-nas-mode]]
- [x] *Replace a disk UI (mk-nas phase 5)** degraded pool banner, pick the new disk, resilver progress, import a foreign pool #p2 #nas [[replace-a-disk-ui-mk-nas-phase-5-degraded-pool-banner-pick-t]]
- [x] *Replication UI (mk-nas phase 4)** jobs to another host, last result and history, run now #p2 #nas [[replication-ui-mk-nas-phase-4-jobs-to-another-host-last-resu]]
- [x] *Shares UI (mk-nas phase 3)** per-dataset SMB and NFS shares, an SMB password on the account page like app passwords, the Time Machine flag, who may connect #p2 #nas [[shares-ui-mk-nas-phase-3-per-dataset-smb-and-nfs-shares-an-s]]
- [x] *Pools page polish** capacity bar with used/free labels, per-disk model and size next to the vdev names (from the disks verb), scrub progress bar that polls while running, last scrub as relative time, degraded/faulted vdevs red with the action text prominent #p1 #nas [[pools-page-polish-capacity-bar-with-used-free-labels-per-dis]]
- [x] *Disks page polish** temperature, power-on time and wear as columns with warm/hot tones, SMART detail dialog with the attribute table from the smart verb, sort by column, a small pool/OS/free legend #p1 #nas [[disks-page-polish-temperature-power-on-time-and-wear-as-colu]]
- [x] *Storage overview** /storage becomes Overview (Health folds in): stat tiles — capacity used/free across pools with a bar, pools and their health, disks with the hottest temperature, snapshots count and the last automatic one, scrub state; the problems list on top; every tile links to its page #p1 #nas [[storage-overview-storage-becomes-overview-health-folds-in-st]]
- [x] **Folder details** Details… on a folder: total size, files, folders, last change and the largest files, from a bounded walk (GET /api/du); a dialog from the context menu #p1 #ui [[folder-details]]
- [x] **Search the whole drive** the search box on Home looks across every location you can open (names, or inside files), budgets shared between locations, results in the feed with where each hit lives #p1 #search [[search-the-whole-drive]]
- [x] **Home page** '/' becomes a real home instead of a redirect: locations with free space, 'New on the drive' (latest arrivals from the audit, incl. file-request uploads, filtered by the caller's grant), recent, starred, shared with me #p1 #ui [[home-page]]
- [x] **Search inside files** the search box gets an 'in files' switch: bounded content search over text files and PDFs (pdftotext, already in the image) with a snippet per hit; same budgets as the name search #p1 #search [[search-inside-files]]
- [x] **File requests** an upload-only public link to a folder: visitors add files and see nothing else; conflict policy keeps both; owner needs write; mode select in the share dialog, drop zone on the public page #p1 #sharing [[file-requests]]
- [x] **PDF thumbnails** first page via poppler's pdftocairo (in the image; DRIVE_PDFTOCAIRO, off when missing) on the localPath seam like video posters; grid, photos-style tiles and share pages get real previews for documents #p2 #media [[pdf-thumbnails]]
- [x] **Photos by date taken** EXIF DateTimeOriginal (jpeg/tiff/webp/png via sharp metadata, own parser, no lib) with a disposable cache in SQLite keyed by path+etag; timeline and preview use it, mtime stays the fallback #p2 #media [[photos-by-date-taken]]
- [x] **Connectors** SmbProvider / S3Provider / WebDavProvider configured in the UI instead of host mounts #p3 #beyond [[connectors]]
- [x] **In-place markdown editing** mk-block-editor on .md files with conflict check on mtime/etag #p3 #beyond [[in-place-markdown-editing]]
- [x] **Share a single file with a person** today only folders can be shared with an account (links cover files); needs a way to open a file whose parent is invisible #p3 #share [[share-a-single-file-with-a-person]]
- [x] **Video thumbnails** ffmpeg when the binary is present, same capped WebP cache; poster frame in grid and lightbox #p2 #media [[video-thumbnails]]
- [x] **WebDAV endpoint** same server, same grants, per-app passwords; Finder / Explorer / iOS Files without an app; provider interface already fits #p2 #beyond [[webdav-endpoint]]
- [x] **Per-app passwords** revocable tokens for non-browser clients (Basic auth on /api and WebDAV); listed and revoked on the Devices page #p2 #auth [[per-app-passwords]]
- [x] **Share with a user** grant a folder to a local account (read/write) next to public links; shows up under Shared with me #p2 #share [[share-with-a-user]]
- [x] **@mk-kit/ui 0.59** upgrade and drop the app-side workarounds it made unnecessary: folders-first sort bypass in browse.ts (table compare), tree iconName, dialog focus re-entry guards, hotkeys allowInInput #p1 #mk-kit [[mk-kit-ui-0-59]]
- [x] **Drop Cloudflare Access** single sign-on (passkeys) is the internet login now; no Access in front any more, keep DRIVE_ACCESS_* as an optional feature for others #p1 #auth
- [x] **Password login only from trusted networks** DRIVE_PASSWORD_LOGIN=on|lan|off (lan = trusted proxies / private ranges); the internet path shows only single sign-on, the password stays the fallback on the LAN #p1 #auth
- [x] **Password recovery** admins set anyone's password from People (key icon); a locked-out admin runs node src/cli.ts password <email> inside the container; README + GUIDE say so #p1 #auth
- [x] **Connect this computer** Settings → Connect: per-system steps (GNOME Files, KDE, GVFS, Finder, Explorer, rclone files-on-demand, iPhone, Android, curl, JSON API) with the address and a freshly made app password filled in; your own system first #p2 #docs
- [x] **Photos timeline** every image and video of a location, newest first, grouped by day; lightbox for images, drawer for videos; bounded walk cached 2 min, paged by mtime; sidebar Library → Photos #p2 #media
- [x] **Momentum theme** the mk-kit Momentum preset on the whole app (vendored momentum-preset.css until mk-kit ships it; data-mk-preset on html); teal identity retired #p2 #design
- [x] **Preview drawer: previous / next** strip at the top of the drawer plus ← → while it is open, through the listing's non-image files #p2 #ux
- [x] **Share target: phone → drive** installed app in the share sheet; sw.js parks the shared files in a cache, /share page picks the folder and uses the normal uploader with the session #p2 #pwa
- [ ] **Sign-out without the confirm page** @mk-kit/auth 0.2.0 (PR mk-kit#108, released): MkIdentity.idToken + endSessionUrl(uri, idTokenHint); the drive keeps sessions.id_token and passes it back on logout #p2 #auth
