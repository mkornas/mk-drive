/**
 * NAS mode: `/api/nas/*` for admins, each route one verb of the agent.
 * Registered only when DRIVE_NAS_SOCKET is set; the rest of the app never
 * knows whether it is here. Bodies go to the agent as they are — it
 * validates every value and refuses keys it does not know — after being
 * narrowed to the keys the verb takes, so nothing else rides along.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest, forbidden } from '../errors.ts';
import { smbUserName } from '../nas.ts';
import { PASSWORD_MIN } from '../users.ts';
import type { Locations } from '../locations.ts';
import type { NasClient } from '../nas.ts';
import type { Users } from '../users.ts';
import type {
  ConfigBackup,
  Dataset,
  DatasetCreateArgs,
  DatasetDestroyArgs,
  DatasetSetArgs,
  Disk,
  Health,
  ImportablePool,
  Job,
  Network,
  NetworkSetArgs,
  Policy,
  PolicySetArgs,
  Power,
  PowerScheduled,
  Pool,
  PoolCreateArgs,
  PoolSummary,
  Replication,
  ReplicationSetArgs,
  ReplicationTest,
  Scrub,
  ScrubInterval,
  ScrubPolicy,
  Share,
  ShareSetArgs,
  Smart,
  SmbUser,
  Snapshot,
  System,
  Tunnel,
  Update,
  Version,
  ZfsEvent,
} from '../../../shared/nas.ts';
import { sessionOnly } from './app-passwords.ts';

function pick<T extends object>(body: unknown, keys: (keyof T)[]): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('send a JSON object');
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((body as Record<string, unknown>)[k as string] !== undefined) out[k as string] = (body as Record<string, unknown>)[k as string];
  return out as T;
}

export function registerNasRoutes(app: FastifyInstance, nas: NasClient, locations: Locations, users: Users): void {
  const admin = (req: FastifyRequest) => {
    if (req.identity?.role !== 'admin') throw forbidden('admins only');
    sessionOnly(req);
  };
  const audit = (req: FastifyRequest, action: string, detail: unknown) => users.audit({ userId: req.identity.id, email: req.identity.email, action, detail });

  // ---- see ----
  app.get('/api/nas/version', async (req): Promise<Version> => {
    admin(req);
    return nas.call('version');
  });
  app.get('/api/nas/health', async (req): Promise<Health> => {
    admin(req);
    return nas.call('health');
  });
  app.get('/api/nas/system', async (req): Promise<System> => {
    admin(req);
    return nas.call('system');
  });
  /** `viaTunnel`: the request came through Cloudflare, so whoever shuts the box down is not next to its power button. */
  app.get('/api/nas/power', async (req): Promise<Power & { viaTunnel: boolean }> => {
    admin(req);
    return { ...(await nas.call('power')), viaTunnel: typeof req.headers['cf-connecting-ip'] === 'string' };
  });
  // ---- the Cloudflare Tunnel: changing it through itself would cut the very connection in use, so that is refused ----
  const viaTunnel = (req: FastifyRequest) => typeof req.headers['cf-connecting-ip'] === 'string';
  const notThroughTunnel = (req: FastifyRequest) => {
    if (viaTunnel(req)) throw forbidden('this page is open through the tunnel: changing it would cut this connection. Do it from home, on the local network');
  };
  app.get('/api/nas/tunnel', async (req): Promise<Tunnel & { viaTunnel: boolean }> => {
    admin(req);
    return { ...(await nas.call('tunnel')), viaTunnel: viaTunnel(req) };
  });
  app.put('/api/nas/tunnel', async (req): Promise<Tunnel & { viaTunnel: boolean }> => {
    admin(req);
    notThroughTunnel(req);
    const { token } = pick<{ token: string }>(req.body, ['token']);
    const t = await nas.call('tunnel.set', { token });
    audit(req, 'nas.tunnel.set', { tunnelId: t.tunnelId });
    return { ...t, viaTunnel: false };
  });
  app.delete('/api/nas/tunnel', async (req): Promise<Tunnel & { viaTunnel: boolean }> => {
    admin(req);
    notThroughTunnel(req);
    const t = await nas.call('tunnel.remove');
    audit(req, 'nas.tunnel.remove', {});
    return { ...t, viaTunnel: false };
  });

  app.get('/api/nas/update', async (req): Promise<Update> => {
    admin(req);
    return nas.call('update');
  });
  app.post('/api/nas/update/check', async (req): Promise<Update> => {
    admin(req);
    return nas.call('update.check');
  });
  app.post('/api/nas/update/install', async (req): Promise<Update> => {
    admin(req);
    const { version } = pick<{ version: string }>(req.body, ['version']);
    const u = await nas.call('update.install', { version });
    audit(req, 'nas.update.install', { version });
    return u;
  });
  for (const action of ['reboot', 'shutdown'] as const) {
    app.post(`/api/nas/system/${action}`, async (req): Promise<PowerScheduled> => {
      admin(req);
      const { confirm } = pick<{ confirm: string }>(req.body, ['confirm']);
      const r = await nas.call(`system.${action}`, { confirm });
      audit(req, `nas.system.${action}`, { at: r.at });
      return r;
    });
  }
  app.get('/api/nas/network', async (req): Promise<Network> => {
    admin(req);
    return nas.call('network');
  });
  app.put('/api/nas/network', async (req): Promise<Network> => {
    admin(req);
    const args = pick<NetworkSetArgs>(req.body, ['hostname', 'interface', 'dhcp', 'address', 'gateway', 'dns', 'revertAfter']);
    const n = await nas.call('network.set', args);
    audit(req, 'nas.network.set', args);
    return n;
  });
  app.post('/api/nas/network/confirm', async (req): Promise<Network> => {
    admin(req);
    const n = await nas.call('network.confirm');
    audit(req, 'nas.network.confirm', {});
    return n;
  });
  app.get('/api/nas/disks', async (req): Promise<Disk[]> => {
    admin(req);
    return nas.call('disks');
  });
  app.get<{ Params: { id: string } }>('/api/nas/disks/:id/smart', async (req): Promise<Smart> => {
    admin(req);
    return nas.call('smart', { disk: req.params.id });
  });
  app.post<{ Params: { id: string } }>('/api/nas/disks/:id/smart-test', async (req): Promise<Smart> => {
    admin(req);
    const { kind } = pick<{ kind: 'short' | 'long' }>(req.body, ['kind']);
    const s = await nas.call('smart.test', { disk: req.params.id, kind });
    audit(req, 'nas.smart.test', { disk: req.params.id, kind });
    return s;
  });
  app.get('/api/nas/pools', async (req): Promise<PoolSummary[]> => {
    admin(req);
    return nas.call('pools');
  });
  app.get<{ Params: { name: string } }>('/api/nas/pools/:name', async (req): Promise<Pool> => {
    admin(req);
    return nas.call('pool', { pool: req.params.name });
  });
  app.get<{ Querystring: { pool?: string } }>('/api/nas/datasets', async (req): Promise<Dataset[]> => {
    admin(req);
    return nas.call('datasets', req.query.pool ? { pool: req.query.pool } : {});
  });
  app.get<{ Querystring: { dataset?: string } }>('/api/nas/snapshots', async (req): Promise<Snapshot[]> => {
    admin(req);
    return nas.call('snapshots', req.query.dataset ? { dataset: req.query.dataset } : {});
  });
  app.get('/api/nas/scrubs', async (req): Promise<Scrub[]> => {
    admin(req);
    return nas.call('scrubs');
  });
  app.get<{ Querystring: { replication?: string; pool?: string } }>('/api/nas/jobs', async (req): Promise<Job[]> => {
    admin(req);
    return nas.call('jobs', req.query.pool ? { pool: req.query.pool } : req.query.replication ? { replicationId: Number(req.query.replication) } : {});
  });
  app.get<{ Querystring: { all?: string; limit?: string } }>('/api/nas/events', async (req): Promise<ZfsEvent[]> => {
    admin(req);
    return nas.call('events', { ...(req.query.all === '1' ? { all: true } : {}), ...(req.query.limit ? { limit: Number(req.query.limit) } : {}) });
  });
  app.get('/api/nas/policies', async (req): Promise<Policy[]> => {
    admin(req);
    return nas.call('policies');
  });

  // ---- make ----
  app.post('/api/nas/pools', async (req, reply): Promise<Pool> => {
    admin(req);
    const args = pick<PoolCreateArgs>(req.body, ['name', 'layout', 'disks', 'confirm']);
    const pool = await nas.call('pool.create', args);
    audit(req, 'nas.pool.create', { name: args.name, layout: args.layout, disks: args.disks });
    reply.code(201);
    return pool;
  });
  app.post<{ Params: { name: string } }>('/api/nas/pools/:name/scrub', async (req): Promise<{ started: true }> => {
    admin(req);
    const r = await nas.call('pool.scrub', { pool: req.params.name });
    audit(req, 'nas.pool.scrub', { pool: req.params.name });
    return r;
  });
  app.post<{ Params: { id: string } }>('/api/nas/disks/:id/wipe', async (req): Promise<Disk> => {
    admin(req);
    const { confirm } = pick<{ confirm: string }>(req.body, ['confirm']);
    const d = await nas.call('disk.wipe', { disk: req.params.id, confirm });
    audit(req, 'nas.disk.wipe', { disk: req.params.id });
    return d;
  });
  app.post('/api/nas/datasets', async (req, reply): Promise<Dataset> => {
    admin(req);
    const args = pick<DatasetCreateArgs>(req.body, ['name', 'quota', 'compression', 'atime', 'location']);
    const ds = await nas.call('dataset.create', args);
    audit(req, 'nas.dataset.create', { name: args.name, location: !!args.location });
    // a dataset made as a location is mounted under our locations dir: pick it up now, no restart
    if (args.location) await locations.rescan();
    reply.code(201);
    return ds;
  });
  app.patch('/api/nas/datasets', async (req): Promise<Dataset> => {
    admin(req);
    const args = pick<DatasetSetArgs>(req.body, ['dataset', 'quota', 'compression', 'atime']);
    const ds = await nas.call('dataset.set', args);
    audit(req, 'nas.dataset.set', args);
    return ds;
  });
  app.post('/api/nas/datasets/destroy', async (req): Promise<{ destroyed: string; snapshots: number; location: string | null }> => {
    admin(req);
    const args = pick<DatasetDestroyArgs>(req.body, ['dataset', 'confirm', 'snapshots']);
    const r = await nas.call('dataset.destroy', args);
    audit(req, 'nas.dataset.destroy', { name: args.dataset, snapshots: r.snapshots, location: r.location });
    // it was one of our locations: its directory is gone, so the sidebar must lose it now, not at the next restart
    if (r.location) await locations.rescan();
    return r;
  });
  app.post('/api/nas/snapshots', async (req, reply): Promise<Snapshot> => {
    admin(req);
    const args = pick<{ dataset: string; name?: string }>(req.body, ['dataset', 'name']);
    const s = await nas.call('snapshot.create', args);
    audit(req, 'nas.snapshot.create', { name: s.name });
    reply.code(201);
    return s;
  });
  app.post('/api/nas/snapshots/destroy', async (req): Promise<{ destroyed: string }> => {
    admin(req);
    const args = pick<{ snapshot: string; confirm: string }>(req.body, ['snapshot', 'confirm']);
    const r = await nas.call('snapshot.destroy', args);
    audit(req, 'nas.snapshot.destroy', { name: args.snapshot });
    return r;
  });
  app.post('/api/nas/snapshots/rollback', async (req): Promise<{ rolledBackTo: string }> => {
    admin(req);
    const args = pick<{ snapshot: string; confirm: string }>(req.body, ['snapshot', 'confirm']);
    const r = await nas.call('snapshot.rollback', args);
    audit(req, 'nas.snapshot.rollback', r);
    return r;
  });
  // ---- share ----
  app.get('/api/nas/shares', async (req): Promise<Share[]> => {
    admin(req);
    return nas.call('shares');
  });
  app.put('/api/nas/shares', async (req): Promise<Share> => {
    admin(req);
    const args = pick<ShareSetArgs>(req.body, ['dataset', 'smb', 'timeMachine', 'nfs', 'nfsClients']);
    const s = await nas.call('share.set', args);
    audit(req, 'nas.share.set', args);
    return s;
  });
  app.post('/api/nas/shares/remove', async (req): Promise<{ removed: string }> => {
    admin(req);
    const { dataset } = pick<{ dataset: string }>(req.body, ['dataset']);
    const r = await nas.call('share.remove', { dataset });
    audit(req, 'nas.share.remove', { dataset });
    return r;
  });
  app.get('/api/nas/users', async (req): Promise<SmbUser[]> => {
    admin(req);
    return nas.call('users');
  });

  // ---- the signed-in person's own SMB access (any role; a browser session, not an app password) ----
  app.get('/api/account/smb', async (req): Promise<{ name: string; hasPassword: boolean; host: string }> => {
    sessionOnly(req);
    const name = smbUserName(req.identity.email);
    const [users, version] = await Promise.all([nas.call('users'), nas.call('version')]);
    return { name, hasPassword: users.some((u) => u.name === name && u.hasPassword), host: version.hostname };
  });
  app.post<{ Body: { password?: unknown } }>('/api/account/smb-password', async (req): Promise<{ name: string; hasPassword: boolean }> => {
    sessionOnly(req);
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) throw badRequest(`the SMB password must be at least ${PASSWORD_MIN} characters`);
    const name = smbUserName(req.identity.email);
    const u = await nas.call('user.smbPassword', { name, password });
    audit(req, 'nas.smb.password', { name });
    return { name: u.name, hasPassword: u.hasPassword };
  });

  // ---- copy ----
  app.get('/api/nas/replications', async (req): Promise<Replication[]> => {
    admin(req);
    return nas.call('replications');
  });
  app.put('/api/nas/replications', async (req): Promise<Replication> => {
    admin(req);
    const args = pick<ReplicationSetArgs>(req.body, ['id', 'dataset', 'host', 'user', 'port', 'targetDataset', 'recursive', 'schedule', 'keep']);
    const r = await nas.call('replication.set', args);
    audit(req, 'nas.replication.set', { id: r.id, dataset: r.dataset, target: `${r.user}@${r.host}:${r.targetDataset}` });
    return r;
  });
  app.post<{ Params: { id: string } }>('/api/nas/replications/:id/run', async (req): Promise<Job> => {
    admin(req);
    const job = await nas.call('replication.run', { id: Number(req.params.id) });
    audit(req, 'nas.replication.run', { id: Number(req.params.id), job: job.id });
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/nas/replications/:id/remove', async (req): Promise<{ removed: number }> => {
    admin(req);
    const r = await nas.call('replication.remove', { id: Number(req.params.id) });
    audit(req, 'nas.replication.remove', { id: r.removed });
    return r;
  });
  app.post('/api/nas/replications/test', async (req): Promise<ReplicationTest> => {
    admin(req);
    return nas.call('replication.test', pick(req.body, ['host', 'user', 'port', 'targetDataset']));
  });
  app.get('/api/nas/replications/key', async (req): Promise<{ publicKey: string }> => {
    admin(req);
    return nas.call('replication.key');
  });

  // ---- survive ----
  app.post<{ Params: { name: string } }>('/api/nas/pools/:name/replace', async (req): Promise<Pool> => {
    admin(req);
    const { old, disk, confirm } = pick<{ old: string; disk: string; confirm: string }>(req.body, ['old', 'disk', 'confirm']);
    const p = await nas.call('disk.replace', { pool: req.params.name, old, disk, confirm });
    audit(req, 'nas.disk.replace', { pool: req.params.name, old, disk });
    return p;
  });
  app.get('/api/nas/pools/importable', async (req): Promise<ImportablePool[]> => {
    admin(req);
    return nas.call('pool.importable');
  });
  app.post('/api/nas/pools/import', async (req): Promise<Pool> => {
    admin(req);
    const { pool } = pick<{ pool: string }>(req.body, ['pool']);
    const p = await nas.call('pool.import', { pool });
    audit(req, 'nas.pool.import', { pool });
    return p;
  });

  app.get('/api/nas/scrub-policies', async (req): Promise<ScrubPolicy[]> => {
    admin(req);
    return nas.call('scrub.policies');
  });
  app.put('/api/nas/scrub-policies', async (req): Promise<ScrubPolicy> => {
    admin(req);
    const args = pick<{ pool: string; interval: ScrubInterval }>(req.body, ['pool', 'interval']);
    const p = await nas.call('scrub.policy.set', args);
    audit(req, 'nas.scrub.policy.set', args);
    return p;
  });
  // ---- the box's settings ----
  app.get('/api/nas/backup', async (req): Promise<ConfigBackup> => {
    admin(req);
    return nas.call('backup');
  });
  app.put('/api/nas/backup', async (req): Promise<ConfigBackup> => {
    admin(req);
    const { dataset } = pick<{ dataset: string | null }>(req.body, ['dataset']);
    const b = await nas.call('backup.set', { dataset: dataset ?? null });
    audit(req, 'nas.backup.set', { dataset: dataset ?? null });
    return b;
  });
  app.post('/api/nas/backup/run', async (req): Promise<ConfigBackup> => {
    admin(req);
    const b = await nas.call('backup.run');
    audit(req, 'nas.backup.run', { dataset: b.dataset, result: b.lastResult });
    return b;
  });
  app.post('/api/nas/backup/restore', async (req): Promise<{ restoring: true; files: string[]; takenAt: string }> => {
    admin(req);
    const args = pick<{ dataset: string; confirm: string }>(req.body, ['dataset', 'confirm']);
    const r = await nas.call('backup.restore', args);
    audit(req, 'nas.backup.restore', { dataset: args.dataset, takenAt: r.takenAt });
    return r;
  });
  app.put('/api/nas/policies', async (req): Promise<Policy> => {
    admin(req);
    const args = pick<PolicySetArgs>(req.body, ['dataset', 'hourly', 'daily', 'weekly', 'monthly']);
    const p = await nas.call('policy.set', args);
    audit(req, 'nas.policy.set', args);
    return p;
  });
}
