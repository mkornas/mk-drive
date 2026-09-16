import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  Alerts as NasAlerts,
  ConfigBackup,
  Dataset as NasDataset,
  DatasetCreateArgs,
  DatasetDestroyArgs,
  DatasetSetArgs,
  Disk as NasDisk,
  Health as NasHealth,
  Policy as NasPolicy,
  PolicySetArgs,
  Power as NasPower,
  PowerScheduled,
  ScrubInterval,
  ScrubPolicy,
  Pool as NasPool,
  PoolCreateArgs,
  PoolSummary as NasPoolSummary,
  Scrub as NasScrub,
  Share as NasShare,
  ShareSetArgs,
  Smart as NasSmart,
  SmbUser as NasSmbUser,
  Snapshot as NasSnapshot,
  System as NasSystem,
  Tunnel as NasTunnel,
  Update as NasUpdate,
  Version as NasVersion,
  ZfsEvent,
  Job as NasJob,
  Network as NasNetwork,
  NetworkSetArgs,
  Replication as NasReplication,
  ReplicationSetArgs,
  ReplicationTest,
  ImportablePool,
} from '../../../../shared/nas';
import type {
  AccessLevel,
  PasswordLoginMode,
  SsoSettings,
  SsoSettingsInput,
  AppPassword,
  Arrival,
  FolderStats,
  AppPasswordCreated,
  AuditEntry,
  ConflictPolicy,
  Connector,
  ConnectorInput,
  Entry,
  Identity,
  Listing,
  PhotoPage,
  Location,
  MarkedEntry,
  Meta,
  NotifySettings,
  NotifySettingsInput,
  OpResult,
  PasswordChanged,
  PushSubscribeInput,
  Role,
  SearchResult,
  Session,
  Share,
  ShareAccess,
  ShareInfo,
  ShareMode,
  SignOutResult,
  TrashEntry,
  UploadStatus,
  User,
  UserShare,
  Version,
} from '../../../../shared/types';

/** Thin typed wrapper over the JSON API. Paths are drive paths (`Docs/a/b`). */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  private get<T>(url: string, params?: HttpParams): Promise<T> {
    return firstValueFrom(this.http.get<T>(url, { params }));
  }
  private post<T>(url: string, body: unknown): Promise<T> {
    return firstValueFrom(this.http.post<T>(url, body));
  }
  private patch<T>(url: string, body: unknown): Promise<T> {
    return firstValueFrom(this.http.patch<T>(url, body));
  }
  private delete<T>(url: string): Promise<T> {
    return firstValueFrom(this.http.delete<T>(url));
  }

  // ---- identity ----
  meta(): Promise<Meta> {
    return this.get('/api/meta');
  }
  setup(email: string, name: string, password: string, setupCode?: string): Promise<Identity> {
    return this.post('/api/setup', { email, name, password, setupCode });
  }
  login(email: string, password: string): Promise<Identity> {
    return this.post('/api/login', { email, password });
  }
  logout(): Promise<SignOutResult> {
    return this.post<SignOutResult>('/api/logout', {});
  }
  sessions(): Promise<Session[]> {
    return this.get('/api/sessions');
  }
  revokeSession(id: string): Promise<unknown> {
    return this.delete(`/api/sessions/${encodeURIComponent(id)}`);
  }
  revokeOtherSessions(): Promise<unknown> {
    return this.post('/api/sessions/revoke-others', {});
  }
  appPasswords(): Promise<AppPassword[]> {
    return this.get('/api/app-passwords');
  }
  createAppPassword(name: string): Promise<AppPasswordCreated> {
    return this.post('/api/app-passwords', { name });
  }
  revokeAppPassword(id: number): Promise<unknown> {
    return this.delete(`/api/app-passwords/${id}`);
  }
  rename(name: string): Promise<Identity> {
    return this.patch('/api/account', { name });
  }
  changePassword(current: string, password: string, revokeAppPasswords: boolean): Promise<PasswordChanged> {
    return this.post('/api/account/password', { current, password, revokeAppPasswords });
  }

  // ---- admin ----
  users(): Promise<User[]> {
    return this.get('/api/users');
  }
  createUser(u: { email: string; name: string; role: Role; password: string; grants: Record<string, AccessLevel> }): Promise<User> {
    return this.post('/api/users', u);
  }
  updateUser(id: number, patch: { name?: string; role?: Role; disabled?: boolean; grants?: Record<string, AccessLevel>; password?: string }): Promise<User> {
    return this.patch(`/api/users/${id}`, patch);
  }
  deleteUser(id: number): Promise<unknown> {
    return this.delete(`/api/users/${id}`);
  }
  audit(limit = 200, before?: number): Promise<AuditEntry[]> {
    let params = new HttpParams().set('limit', limit);
    if (before) params = params.set('before', before);
    return this.get('/api/audit', params);
  }

  /** The drive's name in the header (admins); an empty name puts the default back. */
  renameDrive(name: string): Promise<{ name: string | null }> {
    return firstValueFrom(this.http.put<{ name: string | null }>('/api/settings/name', { name }));
  }
  ssoSettings(): Promise<SsoSettings> {
    return this.get('/api/settings/sso');
  }
  setSsoSettings(input: SsoSettingsInput): Promise<SsoSettings> {
    return firstValueFrom(this.http.put<SsoSettings>('/api/settings/sso', input));
  }
  removeSsoSettings(): Promise<SsoSettings> {
    return this.delete('/api/settings/sso');
  }
  setPasswordLogin(mode: PasswordLoginMode): Promise<SsoSettings> {
    return firstValueFrom(this.http.put<SsoSettings>('/api/settings/password-login', { mode }));
  }

  // ---- notifications (any signed-in account; web push to this account's browsers) ----
  readonly notifications = {
    get: (): Promise<NotifySettings> => this.get('/api/notifications'),
    set: (input: NotifySettingsInput): Promise<NotifySettings> => firstValueFrom(this.http.put<NotifySettings>('/api/notifications', input)),
    /** What `PushSubscription.toJSON()` gave, so the server can push to this browser. */
    subscribe: (sub: PushSubscribeInput): Promise<NotifySettings> => this.post('/api/notifications/subscribe', sub),
    unsubscribe: (endpoint: string): Promise<NotifySettings> => this.post('/api/notifications/unsubscribe', { endpoint }),
    /** Forget another browser, by the id `GET /api/notifications` gave it. */
    forget: (id: number): Promise<NotifySettings> => this.delete(`/api/notifications/devices/${id}`),
    test: (): Promise<{ sent: number }> => this.post('/api/notifications/test', {}),
  };

  // ---- NAS mode (admin; only when the mk-nas socket is mounted) ----
  readonly nas = {
    version: (): Promise<NasVersion> => this.get('/api/nas/version'),
    health: (): Promise<NasHealth> => this.get('/api/nas/health'),
    system: (): Promise<NasSystem> => this.get('/api/nas/system'),
    /** `viaTunnel`: this browser reaches the drive through Cloudflare, away from the box. */
    power: (): Promise<NasPower & { viaTunnel: boolean }> => this.get('/api/nas/power'),
    tunnel: (): Promise<NasTunnel & { viaTunnel: boolean }> => this.get('/api/nas/tunnel'),
    setTunnel: (token: string): Promise<NasTunnel & { viaTunnel: boolean }> =>
      firstValueFrom(this.http.put<NasTunnel & { viaTunnel: boolean }>('/api/nas/tunnel', { token })),
    removeTunnel: (): Promise<NasTunnel & { viaTunnel: boolean }> => this.delete('/api/nas/tunnel'),
    update: (): Promise<NasUpdate> => this.get('/api/nas/update'),
    checkUpdate: (): Promise<NasUpdate> => this.post('/api/nas/update/check', {}),
    installUpdate: (version: string): Promise<NasUpdate> => this.post('/api/nas/update/install', { version }),
    reboot: (confirm: string): Promise<PowerScheduled> => this.post('/api/nas/system/reboot', { confirm }),
    shutdown: (confirm: string): Promise<PowerScheduled> => this.post('/api/nas/system/shutdown', { confirm }),
    network: (): Promise<NasNetwork> => this.get('/api/nas/network'),
    setNetwork: (args: NetworkSetArgs): Promise<NasNetwork> => firstValueFrom(this.http.put<NasNetwork>('/api/nas/network', args)),
    confirmNetwork: (): Promise<NasNetwork> => this.post('/api/nas/network/confirm', {}),
    disks: (): Promise<NasDisk[]> => this.get('/api/nas/disks'),
    smart: (id: string): Promise<NasSmart> => this.get(`/api/nas/disks/${encodeURIComponent(id)}/smart`),
    smartTest: (id: string, kind: 'short' | 'long'): Promise<NasSmart> => this.post(`/api/nas/disks/${encodeURIComponent(id)}/smart-test`, { kind }),
    pools: (): Promise<NasPoolSummary[]> => this.get('/api/nas/pools'),
    pool: (name: string): Promise<NasPool> => this.get(`/api/nas/pools/${encodeURIComponent(name)}`),
    datasets: (pool?: string): Promise<NasDataset[]> => this.get('/api/nas/datasets', pool ? new HttpParams().set('pool', pool) : undefined),
    snapshots: (dataset?: string): Promise<NasSnapshot[]> => this.get('/api/nas/snapshots', dataset ? new HttpParams().set('dataset', dataset) : undefined),
    scrubs: (): Promise<NasScrub[]> => this.get('/api/nas/scrubs'),
    policies: (): Promise<NasPolicy[]> => this.get('/api/nas/policies'),
    /** What ZFS reported, newest first; the ones that matter unless `all`. */
    events: (all = false): Promise<ZfsEvent[]> => this.get('/api/nas/events', all ? new HttpParams().set('all', '1') : undefined),
    /** What is wrong right now and what cleared lately; an agent without the verb answers with an error. */
    alerts: (): Promise<NasAlerts> => this.get('/api/nas/alerts'),
    ackAlert: (key: string): Promise<NasAlerts> => this.post('/api/nas/alerts/ack', { key }),
    // make (the agent validates everything and refuses anything destructive without the name typed)
    createPool: (args: PoolCreateArgs): Promise<NasPool> => this.post('/api/nas/pools', args),
    scrub: (pool: string): Promise<{ started: true }> => this.post(`/api/nas/pools/${encodeURIComponent(pool)}/scrub`, {}),
    wipeDisk: (id: string, confirm: string): Promise<NasDisk> => this.post(`/api/nas/disks/${encodeURIComponent(id)}/wipe`, { confirm }),
    createDataset: (args: DatasetCreateArgs): Promise<NasDataset> => this.post('/api/nas/datasets', args),
    setDataset: (args: DatasetSetArgs): Promise<NasDataset> => this.patch('/api/nas/datasets', args),
    destroyDataset: (args: DatasetDestroyArgs): Promise<{ destroyed: string; snapshots: number; location: string | null }> =>
      this.post('/api/nas/datasets/destroy', args),
    createSnapshot: (dataset: string, name?: string): Promise<NasSnapshot> => this.post('/api/nas/snapshots', name ? { dataset, name } : { dataset }),
    destroySnapshot: (snapshot: string, confirm: string): Promise<{ destroyed: string }> => this.post('/api/nas/snapshots/destroy', { snapshot, confirm }),
    rollback: (snapshot: string, confirm: string): Promise<{ rolledBackTo: string }> => this.post('/api/nas/snapshots/rollback', { snapshot, confirm }),
    setPolicy: (args: PolicySetArgs): Promise<NasPolicy> => firstValueFrom(this.http.put<NasPolicy>('/api/nas/policies', args)),
    scrubPolicies: (): Promise<ScrubPolicy[]> => this.get('/api/nas/scrub-policies'),
    setScrubPolicy: (pool: string, interval: ScrubInterval): Promise<ScrubPolicy> =>
      firstValueFrom(this.http.put<ScrubPolicy>('/api/nas/scrub-policies', { pool, interval })),
    // share
    shares: (): Promise<NasShare[]> => this.get('/api/nas/shares'),
    setShare: (args: ShareSetArgs): Promise<NasShare> => firstValueFrom(this.http.put<NasShare>('/api/nas/shares', args)),
    /** The accounts for a share's SMB list, with where each starts; without a dataset the accounts only. */
    shareAccess: (dataset?: string): Promise<ShareAccess> => this.get('/api/nas/shares/access', dataset ? new HttpParams().set('dataset', dataset) : undefined),
    removeShare: (dataset: string): Promise<{ removed: string }> => this.post('/api/nas/shares/remove', { dataset }),
    users: (): Promise<NasSmbUser[]> => this.get('/api/nas/users'),
    // survive
    replaceDisk: (pool: string, old: string, disk: string, confirm: string): Promise<NasPool> =>
      this.post(`/api/nas/pools/${encodeURIComponent(pool)}/replace`, { old, disk, confirm }),
    importable: (): Promise<ImportablePool[]> => this.get('/api/nas/pools/importable'),
    importPool: (pool: string): Promise<NasPool> => this.post('/api/nas/pools/import', { pool }),
    // copy
    replications: (): Promise<NasReplication[]> => this.get('/api/nas/replications'),
    setReplication: (args: ReplicationSetArgs): Promise<NasReplication> => firstValueFrom(this.http.put<NasReplication>('/api/nas/replications', args)),
    runReplication: (id: number): Promise<NasJob> => this.post(`/api/nas/replications/${id}/run`, {}),
    removeReplication: (id: number): Promise<{ removed: number }> => this.post(`/api/nas/replications/${id}/remove`, {}),
    testReplication: (args: { host: string; user?: string; port?: number; targetDataset: string }): Promise<ReplicationTest> =>
      this.post('/api/nas/replications/test', args),
    replicationKey: (): Promise<{ publicKey: string }> => this.get('/api/nas/replications/key'),
    // the box's settings
    backup: (): Promise<ConfigBackup> => this.get('/api/nas/backup'),
    setBackup: (dataset: string | null): Promise<ConfigBackup> => firstValueFrom(this.http.put<ConfigBackup>('/api/nas/backup', { dataset })),
    runBackup: (): Promise<ConfigBackup> => this.post('/api/nas/backup/run', {}),
    restoreBackup: (dataset: string, confirm: string): Promise<{ restoring: true; files: string[]; takenAt: string }> =>
      this.post('/api/nas/backup/restore', { dataset, confirm }),
    jobs: (replicationId?: number): Promise<NasJob[]> =>
      this.get('/api/nas/jobs', replicationId !== undefined ? new HttpParams().set('replication', String(replicationId)) : undefined),
    /** One pool's scrubs and resilvers, the running one first. */
    poolJobs: (pool: string): Promise<NasJob[]> => this.get('/api/nas/jobs', new HttpParams().set('pool', pool)),
    /** The signed-in person's own SMB access (any role). */
    mySmb: (): Promise<{ name: string; hasPassword: boolean; host: string }> => this.get('/api/account/smb'),
    setMySmbPassword: (password: string): Promise<{ name: string; hasPassword: boolean }> => this.post('/api/account/smb-password', { password }),
  };

  // ---- files ----
  locations(): Promise<Location[]> {
    return this.get('/api/locations');
  }
  ls(path: string, opts: { hidden?: boolean; dirsOnly?: boolean } = {}): Promise<Listing> {
    let params = new HttpParams().set('path', path);
    if (opts.hidden) params = params.set('hidden', '1');
    if (opts.dirsOnly) params = params.set('dirs', '1');
    return this.get('/api/ls', params);
  }
  /** URL of the file itself, for `src`, `href` and downloads. */
  fileUrl(path: string, download = false): string {
    return `/api/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
  }
  /** Thumbnail URL for an image entry; `w` is one of 160, 320, 640, 1280. */
  thumbUrl(path: string, w = 320): string {
    return `/api/thumb?path=${encodeURIComponent(path)}&w=${w}`;
  }
  /** Names under `path` (every location you can open when it is empty), or with `inFiles` the contents of text files and PDFs (a snippet per hit). */
  search(path: string, q: string, hidden = false, inFiles = false): Promise<SearchResult> {
    let params = new HttpParams().set('q', q);
    if (path) params = params.set('path', path);
    if (hidden) params = params.set('hidden', '1');
    if (inFiles) params = params.set('in', 'content');
    return this.get('/api/search', params);
  }
  photos(location: string, before: number | null = null, limit = 200, fresh = false): Promise<PhotoPage> {
    let params = new HttpParams().set('location', location).set('limit', String(limit));
    if (before !== null) params = params.set('before', String(before));
    if (fresh) params = params.set('fresh', '1');
    return this.get('/api/photos', params);
  }
  stars(): Promise<MarkedEntry[]> {
    return this.get('/api/stars');
  }
  star(path: string): Promise<unknown> {
    return this.post('/api/stars', { path });
  }
  unstar(path: string): Promise<unknown> {
    return this.delete(`/api/stars?path=${encodeURIComponent(path)}`);
  }
  /** What is under a folder: size, counts, newest change, largest files (a bounded walk). */
  folderStats(path: string, hidden = false): Promise<FolderStats> {
    let params = new HttpParams().set('path', path);
    if (hidden) params = params.set('hidden', '1');
    return this.get('/api/du', params);
  }
  /** The newest uploads you may see, including what visitors sent through file-request links. */
  arrivals(limit = 30): Promise<Arrival[]> {
    return this.get('/api/arrivals', new HttpParams().set('limit', String(limit)));
  }
  recent(): Promise<MarkedEntry[]> {
    return this.get('/api/recent');
  }
  touchRecent(path: string): Promise<unknown> {
    return this.post('/api/recent', { path });
  }
  clearRecent(): Promise<unknown> {
    return this.delete('/api/recent');
  }

  // ---- share links ----
  shares(): Promise<Share[]> {
    return this.get('/api/shares');
  }
  sharesFor(path: string): Promise<Share[]> {
    return this.get('/api/shares/for', new HttpParams().set('path', path));
  }
  createShare(path: string, opts: { expiresAt?: number | null; password?: string; mode?: ShareMode }): Promise<Share> {
    return this.post('/api/shares', { path, ...opts });
  }
  deleteShare(id: string): Promise<unknown> {
    return this.delete(`/api/shares/${encodeURIComponent(id)}`);
  }
  // ---- connectors (admin) ----
  connectors(): Promise<Connector[]> {
    return this.get('/api/connectors');
  }
  addConnector(input: ConnectorInput): Promise<Connector> {
    return this.post('/api/connectors', input);
  }
  removeConnector(name: string): Promise<unknown> {
    return this.delete(`/api/connectors/${encodeURIComponent(name)}`);
  }
  // ---- folders shared with people ----
  userSharesFor(path: string): Promise<UserShare[]> {
    return this.get('/api/user-shares', new HttpParams().set('path', path));
  }
  shareWithUser(path: string, email: string, level: 'read' | 'write'): Promise<UserShare> {
    return this.post('/api/user-shares', { path, email, level });
  }
  removeUserShare(id: number): Promise<unknown> {
    return this.delete(`/api/user-shares/${id}`);
  }
  sharedWithMe(): Promise<UserShare[]> {
    return this.get('/api/shared-with-me');
  }
  shareLink(id: string): string {
    return `${location.origin}/s/${id}`;
  }
  // public side
  shareInfo(id: string): Promise<ShareInfo> {
    return this.get(`/api/s/${encodeURIComponent(id)}`);
  }
  shareUnlock(id: string, password: string): Promise<unknown> {
    return this.post(`/api/s/${encodeURIComponent(id)}/unlock`, { password });
  }
  shareLs(id: string, path = ''): Promise<Listing> {
    return this.get(`/api/s/${encodeURIComponent(id)}/ls`, new HttpParams().set('path', path));
  }
  shareFileUrl(id: string, path = '', download = false): string {
    return `/api/s/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
  }
  shareThumbUrl(id: string, path: string, w = 320): string {
    return `/api/s/${encodeURIComponent(id)}/thumb?path=${encodeURIComponent(path)}&w=${w}`;
  }
  shareZipUrl(id: string, path = ''): string {
    return `/api/s/${encodeURIComponent(id)}/zip?path=${encodeURIComponent(path)}`;
  }

  // ---- versions ----
  versions(path: string): Promise<Version[]> {
    return this.get('/api/versions', new HttpParams().set('path', path));
  }
  versionUrl(path: string, snapshot: string, download = false): string {
    return `/api/versions/file?path=${encodeURIComponent(path)}&snapshot=${encodeURIComponent(snapshot)}${download ? '&download=1' : ''}`;
  }
  restoreVersion(path: string, snapshot: string, onConflict: ConflictPolicy = 'rename'): Promise<{ path: string }> {
    return this.post('/api/versions/restore', { path, snapshot, onConflict });
  }

  /** URL of a zip of the given paths (one location). */
  zipUrl(paths: string[]): string {
    return '/api/zip?' + paths.map((p) => 'path=' + encodeURIComponent(p)).join('&');
  }

  // ---- changes ----
  mkdir(dir: string, name: string, onConflict: ConflictPolicy = 'fail'): Promise<{ path: string }> {
    return this.post('/api/mkdir', { path: dir, name, onConflict });
  }
  renameEntry(path: string, name: string, onConflict: ConflictPolicy = 'fail'): Promise<{ path: string }> {
    return this.post('/api/rename', { path, name, onConflict });
  }
  move(paths: string[], to: string, onConflict: ConflictPolicy = 'fail'): Promise<OpResult[]> {
    return this.post('/api/move', { paths, to, onConflict });
  }
  copy(paths: string[], to: string, onConflict: ConflictPolicy = 'fail'): Promise<OpResult[]> {
    return this.post('/api/copy', { paths, to, onConflict });
  }
  deleteEntries(paths: string[]): Promise<OpResult[]> {
    return this.post('/api/delete', { paths });
  }
  trash(location: string): Promise<TrashEntry[]> {
    return this.get('/api/trash', new HttpParams().set('location', location));
  }
  restore(id: string, onConflict: ConflictPolicy = 'fail'): Promise<{ path: string }> {
    return this.post(`/api/trash/${encodeURIComponent(id)}/restore`, { onConflict });
  }
  purge(id: string): Promise<unknown> {
    return this.delete(`/api/trash/${encodeURIComponent(id)}`);
  }
  emptyTrash(location: string): Promise<{ count: number }> {
    return this.post('/api/trash/empty', { location });
  }

  // ---- uploads (chunked) ----
  /** The account's upload transport (see `sendFile` in uploader.service.ts). */
  readonly uploads = {
    begin: (dir: string, name: string, size: number, mtime?: number) => this.uploadBegin(dir, name, size, mtime),
    status: (id: string) => this.uploadStatus(id),
    piece: (id: string, offset: number, piece: Blob, signal?: AbortSignal) => this.uploadPiece(id, offset, piece, signal),
    complete: (id: string, onConflict: ConflictPolicy) => this.uploadComplete(id, onConflict),
  };
  /** A file-request link's transport: the same pieces, no account, into the link's folder (`dir` is ignored). */
  shareUploads(shareId: string) {
    const base = `/api/s/${encodeURIComponent(shareId)}/uploads`;
    return {
      begin: (_dir: string, name: string, size: number, mtime?: number): Promise<UploadStatus> => this.post(base, { name, size, mtime }),
      status: (id: string): Promise<UploadStatus> => this.get(`${base}/${encodeURIComponent(id)}`),
      piece: (id: string, offset: number, piece: Blob, signal?: AbortSignal) => this.sendPiece(`${base}/${encodeURIComponent(id)}`, offset, piece, signal),
      complete: (id: string): Promise<{ name: string }> => this.post(`${base}/${encodeURIComponent(id)}/complete`, {}),
    };
  }
  uploadBegin(dir: string, name: string, size: number, mtime?: number): Promise<UploadStatus> {
    return this.post('/api/uploads', { dir, name, size, mtime });
  }
  uploadStatus(id: string): Promise<UploadStatus> {
    return this.get(`/api/uploads/${encodeURIComponent(id)}`);
  }
  /** One piece; resolves with the new status. Uses fetch so the body can be a Blob slice and the request can be aborted. */
  uploadPiece(id: string, offset: number, piece: Blob, signal?: AbortSignal): Promise<UploadStatus> {
    return this.sendPiece(`/api/uploads/${encodeURIComponent(id)}`, offset, piece, signal);
  }
  private async sendPiece(url: string, offset: number, piece: Blob, signal?: AbortSignal): Promise<UploadStatus> {
    const res = await fetch(url, {
      method: 'PATCH',
      body: piece,
      headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) },
      credentials: 'same-origin',
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as UploadStatus & { message?: string };
    if (!res.ok) throw Object.assign(new Error(body.message ?? `HTTP ${res.status}`), { status: res.status });
    return body;
  }
  uploadComplete(id: string, onConflict: ConflictPolicy = 'fail'): Promise<{ path: string }> {
    return this.post(`/api/uploads/${encodeURIComponent(id)}/complete`, { onConflict });
  }
  uploadAbort(id: string): Promise<unknown> {
    return this.delete(`/api/uploads/${encodeURIComponent(id)}`);
  }

  /** The first `max` bytes of a file as text (for previews). */
  /** Save edited text; `etag` is what the file had when it was opened (the server refuses a stale one). */
  async writeText(path: string, text: string, etag: string): Promise<Entry> {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: text,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream', 'if-match': etag },
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string } & Entry;
    if (!res.ok) throw new Error(data.message ?? `save failed (${res.status})`);
    return data;
  }
  async text(path: string, max = 1_000_000): Promise<{ text: string }> {
    const res = await fetch(this.fileUrl(path), { headers: { Range: `bytes=0-${max - 1}` }, credentials: 'same-origin' });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text() };
  }
}

/** Message out of an HTTP error, for toasts and inline errors. */
export function errorMessage(e: unknown): string {
  const err = e as { error?: { message?: string }; message?: string; status?: number };
  return err?.error?.message ?? err?.message ?? 'Request failed';
}
