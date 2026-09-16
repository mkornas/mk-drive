/**
 * The API contract shared by the server and the client (and by any future
 * native client). Paths in the API are "drive paths": `<location>/<relative
 * path>` with forward slashes, no leading slash, e.g. `Docs/invoices/2026`.
 */

export type LocationMode = 'rw' | 'ro';

export type ConnectorType = 'webdav' | 's3';

/** A mounted directory the drive exposes. */
export interface Location {
  /** Unique name, also the first segment of every drive path under it. */
  name: string;
  mode: LocationMode;
  /** Where the bytes are: a directory on this host, or a connector. */
  source: 'mount' | ConnectorType;
  /** Lucide icon name (client-side). */
  icon: string;
  /** Free / total bytes of the filesystem behind the location, when known. */
  space?: { free: number; total: number };
  /** What this location supports beyond browsing; `writable` already reflects the caller's grant. */
  capabilities: { writable: boolean; versions: boolean };
  /** The caller's access to this location. */
  access: Exclude<AccessLevel, 'none'>;
  /** Set when the directory could not be read at the last check. */
  error?: string;
}

export type EntryKind = 'file' | 'dir';

export interface Entry {
  name: string;
  /** Full drive path of the entry. */
  path: string;
  kind: EntryKind;
  /** Bytes; 0 for directories. */
  size: number;
  /** Modification time, epoch milliseconds. */
  mtime: number;
  /** MIME type guessed from the extension; empty for directories. */
  mime: string;
  /** Weak validator derived from size + mtime; matches the `ETag` of `GET /api/file`. */
  etag: string;
  hidden: boolean;
  /** A thumbnail can be requested for this file (`GET /api/thumb`). */
  thumb?: boolean;
  /** Folders-only listings (`dirs=1`): whether this directory has subfolders of its own, so a tree knows which nodes can expand. */
  hasDirs?: boolean;
  /** When the picture was taken (EXIF), epoch milliseconds; absent when the file has no such date. */
  taken?: number;
}

export interface Listing {
  path: string;
  location: string;
  /** The listed directory itself. */
  dir: Entry;
  entries: Entry[];
  /** True when dotfiles were left out (pass `hidden=1` to include them). */
  hiddenOmitted: boolean;
  /** The caller's access to this directory (a folder shared with them may allow more than the location does). */
  access: Exclude<AccessLevel, 'none'>;
}

export type Role = 'admin' | 'member';
export type AccessLevel = 'none' | 'read' | 'write';

/** Who is making the request. */
export interface Identity {
  id: number;
  email: string;
  name: string;
  role: Role;
  /** `access` = Cloudflare Access token mapped to this user; `session` = our own cookie (password or single sign-on); `token` = an app password (Basic or Bearer). */
  via: 'access' | 'session' | 'token';
  /** The app password in use when `via` is `token`. */
  tokenId?: number;
}

/** A location that is not a host mount: a WebDAV server or an S3 bucket, added by an admin. Secrets never come back. */
export interface Connector {
  name: string;
  type: ConnectorType;
  mode: LocationMode;
  icon: string;
  hide: string[];
  /** The non-secret settings, as strings, for display. */
  config: Record<string, string>;
  createdAt: number;
}

/** `POST /api/connectors`. `config` is `{ url, username?, password? }` for webdav, `{ endpoint, region?, bucket, prefix?, accessKey, secretKey, pathStyle? }` for s3. */
export interface ConnectorInput {
  name: string;
  type: ConnectorType;
  mode?: LocationMode;
  icon?: string;
  hide?: string[];
  config: Record<string, unknown>;
}

/** An app password: a long random secret for non-browser clients (curl, WebDAV, scripts), shown once when made. */
export interface AppPassword {
  id: number;
  name: string;
  /** The first characters of the secret, to tell them apart. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  lastIp: string;
}

/** `POST /api/app-passwords`: the only time the secret is visible. */
export interface AppPasswordCreated extends AppPassword {
  secret: string;
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  /** Per-location access; admins have every location implicitly. */
  grants: Record<string, AccessLevel>;
}

/** `POST /api/logout`: the session is gone; `redirect` is the provider's own logout page when the session came from it. */
export interface SignOutResult {
  ok: boolean;
  redirect?: string;
}

/** `POST /api/account/password` (body `{ current, password, revokeAppPasswords? }`, default true): the other sessions are signed out; how many app passwords went with them. */
export interface PasswordChanged {
  ok: boolean;
  appPasswordsRevoked: number;
}

export interface Session {
  /** A public id for signing this session out (`DELETE /api/sessions/:id`); never the cookie's secret. */
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string;
  ip: string;
  current: boolean;
}

export interface AuditEntry {
  id: number;
  at: number;
  userId: number | null;
  email: string;
  action: string;
  path: string;
  detail: string;
}

/** Single sign-on as the Settings → Sign-in page sees it. The client secret never leaves the server. */
export interface SsoSettings {
  /** 'env' when DRIVE_OIDC_* configure it (read-only here), 'settings' when an admin saved it, null when it is off. */
  source: 'env' | 'settings' | null;
  name: string;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  /** The provider answered its discovery document. */
  ready: boolean;
  /** Why it did not, the last time the drive asked. */
  error: string | null;
  /** What to register at the provider, for the address this page is open on. */
  redirectUri: string;
  logoutRedirectUri: string;
  /** Password sign-in is off on this drive: a wrong client ID or secret would leave nobody a way in. */
  passwordLoginOff: boolean;
  /** Where password sign-in works (`PUT /api/settings/password-login` changes it). */
  passwordLogin: PasswordLoginMode;
  /** 'env' when DRIVE_PASSWORD_LOGIN sets it (read-only here), else 'settings' (an admin's choice, `on` until one is made). */
  passwordLoginSource: 'env' | 'settings';
}

/** Where password sign-in works: everywhere, only from the local network (loopback and private addresses, never through Cloudflare), or nowhere. */
export type PasswordLoginMode = 'on' | 'local' | 'off';

export interface PasswordLoginInput {
  mode: PasswordLoginMode;
}

export interface SsoSettingsInput {
  name?: string;
  issuer: string;
  clientId: string;
  /** Omitted or empty keeps the secret already saved. */
  clientSecret?: string;
}

export interface Meta {
  app: 'mk-drive';
  version: string;
  build: string;
  /** What the header calls this drive, as an admin named it; the app's own name when unset. */
  name?: string;
  /** Who the current visitor is; `null` until signed in. */
  me: Identity | null;
  /** No users exist yet: the setup page must create the admin. */
  setupRequired: boolean;
  /** While setup is required: it takes the setup code the box shows after installing (`DRIVE_SETUP_TOKEN`). */
  setupCodeRequired?: boolean;
  /** Why a presented credential (e.g. a Cloudflare Access identity) was refused. */
  reason?: string;
  /** Demo mode: sample data, reset on every start. */
  demo?: boolean;
  /** Demo mode with the well-known password: the pages may print the demo account. Unset when the operator set their own
   * `DRIVE_DEMO_PASSWORD`, which is told to whoever should get in (an app review) and never shown. */
  demoAccount?: { email: string; password: string };
  /** Single sign-on is configured: show a "Sign in with <name>" button that goes to `/auth/login`. */
  sso?: { name: string };
  /** The password form is offered to this visitor (`DRIVE_PASSWORD_LOGIN` or Settings → Sign-in may limit it to the local network or turn it off). */
  passwordLogin: boolean;
  /** Password sign-in is limited to the local network (`local`), whoever asks: with `passwordLogin` false the visitor is outside it, and the page can say it works at home. */
  passwordLoginLocal?: boolean;
  /** NAS mode: the mk-nas agent's socket is configured, so admins get the Storage section (`/api/nas/*`) and everyone an SMB password on the account page. */
  nas?: boolean;
  /** NAS mode: the agent speaks an older verb contract than this drive was built for; the Storage pages may misbehave until mk-nas is upgraded. */
  nasOutdated?: { agent: string; contract: number; needs: number };
  /** NAS mode, signed in: the mk-nas agent's version, for the foot of the sidebar. */
  nasAgent?: string;
}

/** NAS mode, `GET /api/nas/shares/access?dataset=`: the drive accounts for a share's SMB list, with what the dialog starts from. */
export interface ShareAccess {
  /** The drive location the dataset is; null when it is not one (or no dataset was asked about). */
  location: string | null;
  accounts: ShareAccessAccount[];
}

export interface ShareAccessAccount {
  userId: number;
  email: string;
  name: string;
  role: Role;
  /** The name Samba knows the account by. */
  smbName: string;
  /** The account has set an SMB password; without one it cannot sign in, list or not. */
  hasPassword: boolean;
  /** The account's grant on the location; admins 'write'; null without a location or a grant. */
  grant: 'read' | 'write' | null;
  /** Where the dialog starts for a share without a list: the grant, or for a dataset that is not a location, admins 'write' and nobody else. */
  suggested: 'read' | 'write' | null;
}

export interface Health {
  ok: boolean;
  build: string;
  version: string;
  uptime: number;
}

export interface ApiError {
  ok: false;
  message: string;
}

/** What to do when the destination name is taken. */
export type ConflictPolicy = 'fail' | 'replace' | 'rename';

export interface OpResult {
  /** Source drive path. */
  from: string;
  /** Resulting drive path, when the operation succeeded. */
  to?: string;
  ok: boolean;
  /** `exists` when a `fail` policy hit a taken name; else a message. */
  error?: string;
  code?: 'exists' | 'forbidden' | 'notfound' | 'error';
}

export interface TrashEntry {
  id: string;
  location: string;
  /** Where it was, as a drive path. */
  original: string;
  name: string;
  kind: EntryKind;
  size: number;
  deletedAt: number;
  deletedBy: string;
}

export interface UploadStatus {
  id: string;
  /** Destination drive path of the finished file. */
  path: string;
  size: number;
  received: number;
  /** Whether something already sits at the destination (decide `onConflict` at completion). */
  exists: boolean;
}

/** A search hit; `snippet` is the text around the first match when the search looked inside the file. */
export type SearchHit = Entry & { snippet?: string };

export interface SearchResult {
  entries: SearchHit[];
  truncated: boolean;
  visited: number;
  /** Files whose contents were read (content search only). */
  scanned?: number;
}

/** What is under a folder (`GET /api/du?path=`), from a bounded walk. */
export interface FolderStats {
  path: string;
  bytes: number;
  files: number;
  dirs: number;
  /** The most recent modification time under the folder, epoch ms; 0 when empty. */
  newest: number;
  /** The biggest files, largest first. */
  largest: Entry[];
  /** The walk stopped before covering everything, so the numbers are a floor. */
  truncated: boolean;
}

/** A starred or recently opened entry, with when it was starred / opened. */
export type MarkedEntry = Entry & { at: number };

/** A file that arrived lately (`GET /api/arrivals`): an upload by someone with an account, or through a file-request link. */
export type Arrival = Entry & {
  at: number;
  by: { email: string; name: string };
  /** True when a visitor sent it through a file-request link (on the owner's behalf). */
  viaLink: boolean;
};

/** What a link lets visitors do: browse and download, download the folder as one zip, or only add files to it (a file request). */
export type ShareMode = 'browse' | 'download' | 'upload';

/** A public link to a file or folder. */
export interface Share {
  id: string;
  path: string;
  name: string;
  kind: EntryKind;
  mode: ShareMode;
  /** Whether a password is required. */
  locked: boolean;
  expiresAt: number | null;
  createdAt: number;
  createdBy: string;
  hits: number;
  lastHitAt: number | null;
}

/** One page of the photo timeline (`GET /api/photos?location=&before=&limit=`): images and videos, newest first. */
export interface PhotoPage {
  entries: Entry[];
  /** Pass back as `before` for the next, older page; null at the end. */
  next: number | null;
  total: number;
  /** The walk hit its budget before covering the whole location. */
  truncated: boolean;
  scannedAt: number;
}

/** A folder or file shared with a local account: the owner's grant, narrowed to one path. */
export interface UserShare {
  id: number;
  path: string;
  name: string;
  level: Exclude<AccessLevel, 'none'>;
  /** Filled in for the recipient (`GET /api/shared-with-me`), so a file can be previewed without listing its parent. */
  kind?: EntryKind;
  size?: number;
  mtime?: number;
  mime?: string;
  /** Who it was shared with. */
  user: { id: number; email: string; name: string };
  /** Who shared it. */
  owner: { id: number; email: string; name: string };
  createdAt: number;
}

/** What the public share page learns about a link before (and after) unlocking. */
export interface ShareInfo {
  id: string;
  name: string;
  kind: EntryKind;
  mode: ShareMode;
  locked: boolean;
  /** True once the visitor has the password cookie (or no password is needed). */
  open: boolean;
  expiresAt: number | null;
  size: number;
  mtime: number;
  mime: string;
}

/** A point-in-time copy of a file from a filesystem snapshot. */
export interface Version {
  /** Snapshot name, e.g. `auto-drive-2026-09-11_03-30`. */
  snapshot: string;
  /** Best guess of when the snapshot was taken (parsed from the name), else 0. */
  at: number;
  size: number;
  mtime: number;
}
