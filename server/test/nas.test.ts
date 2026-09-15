/** NAS mode: /api/nas/* proxies a fake agent on a temp socket; admins only; agent errors map to HTTP. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { Meta, ShareAccess } from '../../shared/types.ts';
import type { Request, Share } from '../../shared/nas.ts';
import { smbUserNames } from '../src/nas.ts';

const PW = 'correct horse battery';
const MONITOR = 'monitor-token-0123456789abcdefghij';
let base: string;
let app: FastifyInstance;
let plain: FastifyInstance;
let agent: Server;
let admin = '';
let member = '';
const seen: Request[] = [];
let smbUsers: { name: string; hasPassword: boolean; createdAt: string }[] = [];
const shares = new Map<string, Share>();
/** An agent from before per-share SMB lists: refuses the key. */
let olderAgent = false;
let agentVersion = '0.2.0';
let agentContract = 2;

const json = (method: InjectOptions['method'], url: string, payload: unknown, cookie: string): InjectOptions => ({
  method,
  url,
  payload: JSON.stringify(payload),
  headers: { 'content-type': 'application/json', cookie },
});
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];

/** Answers like mk-nasd would, for the few verbs the tests poke. */
function fakeAgent(path: string): Promise<Server> {
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as Request;
        buf = buf.slice(nl + 1);
        seen.push(req);
        const reply = (body: unknown) => sock.write(JSON.stringify({ id: req.id, ...(body as object) }) + '\n');
        if (req.verb === 'health') reply({ ok: true, result: { ok: true, pools: [{ name: 'tank', health: 'ONLINE', capacity: 10, ok: true }], disks: [], problems: [], events: [] } });
        else if (req.verb === 'pools')
          reply({ ok: true, result: [{ name: 'tank', health: 'ONLINE', size: 100, allocated: 10, free: 90, capacity: 10, fragmentation: 0 }] });
        else if (req.verb === 'pool' && req.args?.pool === 'tank') reply({ ok: true, result: { name: 'tank', health: 'ONLINE', vdevs: [] } });
        else if (req.verb === 'pool') reply({ ok: false, error: { code: 'not-found', message: `cannot open '${String(req.args?.pool)}': no such pool` } });
        else if (req.verb === 'smart') reply({ ok: false, error: { code: 'bad-args', message: 'disk: not a disk id' } });
        else if (req.verb === 'smart.test')
          reply({ ok: true, result: { id: req.args?.disk, selfTest: { running: { kind: req.args?.kind, percentDone: 0 }, tests: [] } } });
        else if (req.verb === 'datasets')
          reply({
            ok: true,
            result: [
              { name: 'tank/Files', mountpoint: '/srv/locations/Files' },
              { name: 'tank/other', mountpoint: '/tank/other' },
            ],
          });
        else if (req.verb === 'version')
          reply({ ok: true, result: { agent: agentVersion, contract: agentContract, node: 't', zfs: null, smartctl: null, hostname: 'nas' } });
        else if (req.verb === 'users') reply({ ok: true, result: smbUsers });
        else if (req.verb === 'user.smbPassword') {
          smbUsers = [{ name: String(req.args?.name), hasPassword: true, createdAt: 'now' }];
          reply({ ok: true, result: smbUsers[0] });
        } else if (req.verb === 'share.set' && olderAgent && req.args?.smbAccess !== undefined)
          reply({ ok: false, error: { code: 'bad-args', message: 'unexpected argument: smbAccess' } });
        else if (req.verb === 'share.set') {
          // like the agent: keys left out keep what the share had; no list yet is null
          const before = shares.get(String(req.args?.dataset));
          const a = req.args as Partial<Share>;
          const share: Share = {
            dataset: String(a.dataset),
            name: String(a.dataset).split('/').pop()!,
            mountpoint: '/srv/locations/x',
            smb: a.smb ?? before?.smb ?? false,
            timeMachine: false,
            nfs: a.nfs ?? before?.nfs ?? false,
            nfsClients: [],
            smbAccess: a.smbAccess ?? before?.smbAccess ?? null,
            updatedAt: 'now',
          };
          shares.set(share.dataset, share);
          reply({ ok: true, result: share });
        } else if (req.verb === 'shares') reply({ ok: true, result: [...shares.values()] });
        else if (req.verb === 'update' || req.verb === 'update.check' || req.verb === 'update.install')
          reply(
            req.verb === 'update.install' && req.args?.version !== '0.6.0'
              ? { ok: false, error: { code: 'bad-args', message: 'not the newest release' } }
              : {
                  ok: true,
                  result: {
                    current: '0.5.0',
                    drive: '0.3.0',
                    latest: { version: '0.6.0', drive: '0.3.1', contract: 2, notes: '', publishedAt: 'then', url: 'u', signed: true },
                    checkedAt: 'now',
                    error: null,
                    available: true,
                    run:
                      req.verb === 'update.install'
                        ? { id: 1, version: '0.6.0', state: 'running', step: 'starting', startedAt: 'now', finishedAt: null, message: null }
                        : null,
                  },
                },
          );
        else if (req.verb === 'tunnel' || req.verb === 'tunnel.set' || req.verb === 'tunnel.remove')
          reply(
            req.verb === 'tunnel.set' && req.args?.token !== 'good-token'
              ? { ok: false, error: { code: 'bad-args', message: 'token: that is not a tunnel token' } }
              : {
                  ok: true,
                  result: {
                    configured: req.verb !== 'tunnel.remove',
                    tunnelId: req.verb === 'tunnel.remove' ? null : 't-1',
                    state: req.verb === 'tunnel.remove' ? 'off' : 'connected',
                    container: null,
                    since: null,
                    restarts: 0,
                    connections: 4,
                    hostnames: ['drive.example.com'],
                    lastConnectedAt: null,
                    lastError: null,
                  },
                },
          );
        else if (req.verb === 'power') reply({ ok: true, result: { restartNeeded: true, packages: ['linux-base'], busy: ['Scrub of tank, 40%'] } });
        else if (req.verb === 'system.reboot' || req.verb === 'system.shutdown')
          reply(
            req.args?.confirm === 'nas'
              ? { ok: true, result: { action: req.verb === 'system.reboot' ? 'reboot' : 'shutdown', at: 'soon' } }
              : { ok: false, error: { code: 'bad-args', message: 'type the name "nas" to confirm' } },
          );
        else if (req.verb === 'system') reply({ ok: true, result: { hostname: 'nas', uptime: 90000, cores: 4, now: null, history: [], disks: [] } });
        else if (req.verb === 'network' || req.verb === 'network.set' || req.verb === 'network.confirm')
          reply({
            ok: true,
            result: {
              hostname: 'nas',
              mdns: true,
              gateway: null,
              dns: [],
              interfaces: [],
              pending: req.verb === 'network.set' ? { interface: 'eth0', since: 'now', expiresAt: 'later' } : null,
            },
          });
        else if (req.verb === 'backup' || req.verb === 'backup.set' || req.verb === 'backup.run')
          reply({
            ok: true,
            result: {
              dataset: req.verb === 'backup.set' ? req.args?.dataset : 'tank/config',
              lastAt: null,
              lastResult: req.verb === 'backup.run' ? 'ok' : null,
              lastMessage: null,
              snapshots: 0,
              files: [],
              takenAt: null,
            },
          });
        else if (req.verb === 'backup.restore')
          reply(
            req.args?.confirm === req.args?.dataset
              ? { ok: true, result: { restoring: true, files: ['mk-nas.db'], takenAt: 'then' } }
              : { ok: false, error: { code: 'bad-args', message: 'type the name' } },
          );
        else if (req.verb === 'events')
          reply({
            ok: true,
            result: [{ eid: 9, class: 'resource.fs.zfs.statechange', summary: 'tank: sda went FAULTED', matters: true, count: 1, all: !!req.args?.all }],
          });
        else if (req.verb === 'scrub.policies') reply({ ok: true, result: [{ pool: 'tank', interval: 'monthly', updatedAt: null }] });
        else if (req.verb === 'scrub.policy.set') reply({ ok: true, result: { pool: req.args?.pool, interval: req.args?.interval, updatedAt: 'now' } });
        else if (req.verb === 'replication.key') reply({ ok: true, result: { publicKey: 'ssh-ed25519 AAAA mk-nas' } });
        else if (req.verb === 'replication.set')
          reply({
            ok: true,
            result: {
              id: 7,
              dataset: req.args?.dataset,
              host: req.args?.host,
              user: req.args?.user ?? 'root',
              port: 22,
              targetDataset: req.args?.targetDataset,
              recursive: false,
              schedule: 'daily',
              keep: 3,
              lastRunAt: null,
              lastResult: null,
              lastMessage: null,
              running: null,
              createdAt: 'now',
            },
          });
        else if (req.verb === 'replication.run')
          reply({
            ok: true,
            result: {
              id: 1,
              kind: 'replication',
              replicationId: req.args?.id,
              target: 'x',
              state: 'running',
              startedAt: 'now',
              finishedAt: null,
              progress: 0,
              bytes: 0,
              total: null,
              message: null,
            },
          });
        else if (req.verb === 'jobs') reply({ ok: true, result: [{ id: 1, replicationId: req.args?.replicationId ?? null, pool: req.args?.pool ?? null }] });
        else if (req.verb === 'dataset.create') {
          // like the agent: a location dataset is mounted under the drive's locations dir
          const name = String(req.args?.name).split('/').pop()!;
          if (req.args?.location) mkdirSync(join(base, 'locations', name), { recursive: true });
          reply({ ok: true, result: { name: req.args?.name, mountpoint: req.args?.location ? join(base, 'locations', name) : null } });
        } else if (req.verb === 'dataset.destroy') {
          // like the agent: the name typed, and a location's empty directory removed with it
          if (req.args?.confirm !== req.args?.dataset) reply({ ok: false, error: { code: 'bad-args', message: 'type the name to confirm' } });
          else {
            const name = String(req.args?.dataset).split('/').pop()!;
            rmSync(join(base, 'locations', name), { recursive: true, force: true });
            reply({ ok: true, result: { destroyed: req.args?.dataset, snapshots: req.args?.snapshots ? 2 : 0, location: name } });
          }
        } else if (req.verb === 'snapshot.destroy')
          reply(
            req.args?.confirm === req.args?.snapshot
              ? { ok: true, result: { destroyed: req.args?.snapshot } }
              : { ok: false, error: { code: 'bad-args', message: 'type the name to confirm' } },
          );
        else reply({ ok: false, error: { code: 'unknown-verb', message: 'no such verb' } });
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-nas-'));
  await mkdir(join(base, 'docs'), { recursive: true });
  await mkdir(join(base, 'locations', 'Files'), { recursive: true });
  const sock = join(base, 'mk-nas.sock');
  agent = await fakeAgent(sock);
  const cfg = (nasSocket: string, nasMonitorToken = MONITOR): Config => ({
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: 'alex@example.com',
    adminPassword: PW,
    locations: [],
    locationsDir: join(base, 'locations'),
    accessAud: '',
    nasSocket,
    nasMonitorToken,
  });
  app = await createApp(cfg(sock), { logger: false });
  plain = await createApp(cfg(''), { logger: false });
  admin = cookieOf(await app.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }, '')));
  await app.inject(json('POST', '/api/users', { email: 'anna@example.com', name: 'Anna', role: 'member', password: PW }, admin));
  member = cookieOf(await app.inject(json('POST', '/api/login', { email: 'anna@example.com', password: PW }, '')));
});
after(async () => {
  await app.close();
  await plain.close();
  agent.close();
  await rm(base, { recursive: true, force: true });
});

test('meta says whether NAS mode is on, and the agent version to someone signed in', async () => {
  const on = (await app.inject({ url: '/api/meta', headers: { cookie: admin } })).json<Meta>();
  assert.equal(on.nas, true);
  assert.equal(on.nasAgent, agentVersion, "the agent's version for the sidebar");
  assert.equal((await app.inject({ url: '/api/meta' })).json<Meta>().nasAgent, undefined, 'not told to someone signed out');
  const off = (await plain.inject({ url: '/api/meta' })).json<Meta>();
  assert.equal(off.nas, undefined);
});

test('without the socket the routes do not exist', async () => {
  const login = cookieOf(await plain.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }, '')));
  assert.equal((await plain.inject({ url: '/api/nas/pools', headers: { cookie: login } })).statusCode, 404);
});

test('admins only, and only with a browser session', async () => {
  assert.equal((await app.inject({ url: '/api/nas/pools' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/nas/pools', headers: { cookie: member } })).statusCode, 403);
  const token = (await app.inject(json('POST', '/api/app-passwords', { name: 'cli' }, admin))).json<{ secret: string }>();
  assert.equal((await app.inject({ url: '/api/nas/pools', headers: { authorization: `Bearer ${token.secret}` } })).statusCode, 403);
});

test('the monitor route: health and version for the monitor token, and nothing opens it but that token', async () => {
  seen.length = 0;
  const ok = await app.inject({ url: '/api/nas/monitor', headers: { authorization: `Bearer ${MONITOR}` } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), {
    health: { ok: true, pools: [{ name: 'tank', health: 'ONLINE', capacity: 10, ok: true }], disks: [], problems: [], events: [] },
    agent: agentVersion,
    hostname: 'nas',
  });
  assert.deepEqual(seen.map((r) => r.verb).sort(), ['health', 'version']);
  assert.equal(ok.headers['cache-control'], 'no-store');

  assert.equal((await app.inject({ url: '/api/nas/monitor' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/nas/monitor', headers: { cookie: admin } })).statusCode, 401, 'not an admin session');
  // from an address of its own: a POST goes through the usual sign-in, where the token is a wrong app password
  assert.equal((await app.inject({ method: 'POST', url: '/api/nas/monitor', remoteAddress: '198.51.100.7', headers: { authorization: `Bearer ${MONITOR}` } })).statusCode, 401, 'GET only');
  const token = (await app.inject(json('POST', '/api/app-passwords', { name: 'monitor' }, admin))).json<{ secret: string }>();
  assert.equal((await app.inject({ url: '/api/nas/monitor', headers: { authorization: `Bearer ${token.secret}` } })).statusCode, 401, 'not an app password');
  const wrong = await app.inject({ url: '/api/nas/monitor', headers: { authorization: `Bearer ${MONITOR}x` } });
  assert.equal(wrong.statusCode, 429, 'a wrong token is throttled like a password');
  assert.ok(Number(wrong.headers['retry-after']) >= 1);

  assert.equal((await plain.inject({ url: '/api/nas/monitor', headers: { authorization: `Bearer ${MONITOR}` } })).statusCode, 404, 'no socket, no route');
  const short = await createApp({ ...config, staticDir: '', dbFile: ':memory:', locations: [], locationsDir: join(base, 'locations'), accessAud: '', nasSocket: join(base, 'mk-nas.sock'), nasMonitorToken: 'short' }, { logger: false });
  try {
    assert.equal((await short.inject({ url: '/api/nas/monitor', headers: { authorization: 'Bearer short' } })).statusCode, 404, 'a short token keeps it off');
  } finally {
    await short.close();
  }
});

test('a verb goes over the socket and its result comes back', async () => {
  seen.length = 0;
  const res = await app.inject({ url: '/api/nas/pools', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ name: string }[]>()[0].name, 'tank');
  assert.deepEqual(
    seen.map((r) => r.verb),
    ['pools'],
  );
  const pool = await app.inject({ url: '/api/nas/pools/tank', headers: { cookie: admin } });
  assert.equal(pool.statusCode, 200);
  assert.deepEqual(seen[1].args, { pool: 'tank' });
  const ds = await app.inject({ url: '/api/nas/datasets?pool=tank', headers: { cookie: admin } });
  assert.equal(ds.statusCode, 200);
  assert.deepEqual(seen[2].args, { pool: 'tank' });
});

test("the agent's refusals become the matching HTTP status", async () => {
  const missing = await app.inject({ url: '/api/nas/pools/nope', headers: { cookie: admin } });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json<{ message: string }>().message, /no such pool/);
  const bad = await app.inject({ url: '/api/nas/disks/..%2Fsda/smart', headers: { cookie: admin } });
  assert.equal(bad.statusCode, 400);
  const unknown = await app.inject({ url: '/api/nas/scrubs', headers: { cookie: admin } });
  assert.equal(unknown.statusCode, 500);
});

test('make: a write verb goes through, is audited, and a location dataset appears in /api/locations at once', async () => {
  seen.length = 0;
  const before = (await app.inject({ url: '/api/locations', headers: { cookie: admin } })).json<{ name: string }[]>().map((l) => l.name);
  assert.deepEqual(before, ['Files']);
  const res = await app.inject(json('POST', '/api/nas/datasets', { name: 'tank/photos', location: true, quota: 5, extra: 'dropped' }, admin));
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(seen[0].args, { name: 'tank/photos', location: true, quota: 5 }, "only the verb's keys reach the agent");
  const after = (await app.inject({ url: '/api/locations', headers: { cookie: admin } })).json<{ name: string }[]>().map((l) => l.name);
  assert.deepEqual(after, ['Files', 'photos']);
  const audit = (await app.inject({ url: '/api/audit?limit=5', headers: { cookie: admin } })).json<{ action: string }[]>();
  assert.ok(audit.some((a) => a.action === 'nas.dataset.create'));

  const refused = await app.inject(json('POST', '/api/nas/snapshots/destroy', { snapshot: 'tank/photos@x', confirm: 'nope' }, admin));
  assert.equal(refused.statusCode, 400);
  const ok = await app.inject(json('POST', '/api/nas/snapshots/destroy', { snapshot: 'tank/photos@x', confirm: 'tank/photos@x' }, admin));
  assert.equal(ok.statusCode, 200);

  // destroying the location dataset takes the location out of the sidebar at once
  const gone = await app.inject(json('POST', '/api/nas/datasets/destroy', { dataset: 'tank/photos', confirm: 'tank/photos', snapshots: true, x: 1 }, admin));
  assert.equal(gone.statusCode, 200, gone.body);
  assert.deepEqual(seen.at(-1)?.args, { dataset: 'tank/photos', confirm: 'tank/photos', snapshots: true });
  assert.deepEqual(gone.json(), { destroyed: 'tank/photos', snapshots: 2, location: 'photos' });
  const left = (await app.inject({ url: '/api/locations', headers: { cookie: admin } })).json<{ name: string }[]>().map((l) => l.name);
  assert.deepEqual(left, ['Files']);
  assert.ok(
    (await app.inject({ url: '/api/audit?limit=5', headers: { cookie: admin } })).json<{ action: string }[]>().some((a) => a.action === 'nas.dataset.destroy'),
  );
  assert.equal((await app.inject(json('POST', '/api/nas/pools', { name: 'x' }, member))).statusCode, 403);
});

test("jobs by pool: a pool's scrubs and resilvers, only the pool reaching the agent", async () => {
  const jobs = await app.inject({ url: '/api/nas/jobs?pool=tank&replication=7', headers: { cookie: admin } });
  assert.equal(jobs.statusCode, 200);
  assert.deepEqual(seen.at(-1)?.args, { pool: 'tank' });
  assert.deepEqual(jobs.json(), [{ id: 1, replicationId: null, pool: 'tank' }]);
});

test("network: read, set with only the verb's keys, confirm; admins only", async () => {
  const read = await app.inject({ url: '/api/nas/network', headers: { cookie: admin } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json<{ hostname: string }>().hostname, 'nas');
  const set = await app.inject(json('PUT', '/api/nas/network', { interface: 'eth0', address: '10.0.0.2/24', gateway: '10.0.0.1', junk: 1 }, admin));
  assert.equal(set.statusCode, 200, set.body);
  assert.deepEqual(seen.at(-1)?.args, { interface: 'eth0', address: '10.0.0.2/24', gateway: '10.0.0.1' });
  assert.equal(set.json<{ pending: { interface: string } }>().pending.interface, 'eth0');
  const keep = await app.inject(json('POST', '/api/nas/network/confirm', {}, admin));
  assert.equal(keep.statusCode, 200);
  assert.equal(seen.at(-1)?.verb, 'network.confirm');
  const audit = (await app.inject({ url: '/api/audit?limit=5', headers: { cookie: admin } })).json<{ action: string }[]>();
  assert.ok(audit.some((a) => a.action === 'nas.network.set') && audit.some((a) => a.action === 'nas.network.confirm'));
  assert.equal((await app.inject(json('PUT', '/api/nas/network', { hostname: 'x' }, member))).statusCode, 403);
});

test('smart.test: the kind reaches the agent with the disk from the path; admins only', async () => {
  const res = await app.inject(json('POST', '/api/nas/disks/ata-X/smart-test', { kind: 'long', junk: 1 }, admin));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(seen.at(-1)?.args, { disk: 'ata-X', kind: 'long' });
  assert.equal(res.json<{ selfTest: { running: { kind: string } } }>().selfTest.running.kind, 'long');
  assert.equal((await app.inject(json('POST', '/api/nas/disks/ata-X/smart-test', { kind: 'short' }, member))).statusCode, 403);
});

test('settings backup: read, choose the dataset, run, restore with the name typed; admins only', async () => {
  assert.equal((await app.inject({ url: '/api/nas/backup', headers: { cookie: admin } })).json<{ dataset: string }>().dataset, 'tank/config');
  const set = await app.inject(json('PUT', '/api/nas/backup', { dataset: 'tank/cfg', junk: 1 }, admin));
  assert.equal(set.statusCode, 200, set.body);
  assert.deepEqual(seen.at(-1)?.args, { dataset: 'tank/cfg' });
  await app.inject(json('PUT', '/api/nas/backup', { dataset: null }, admin));
  assert.deepEqual(seen.at(-1)?.args, { dataset: null }, 'off');
  assert.equal((await app.inject(json('POST', '/api/nas/backup/run', {}, admin))).json<{ lastResult: string }>().lastResult, 'ok');
  assert.equal((await app.inject(json('POST', '/api/nas/backup/restore', { dataset: 'tank/config', confirm: 'no' }, admin))).statusCode, 400);
  const ok = await app.inject(json('POST', '/api/nas/backup/restore', { dataset: 'tank/config', confirm: 'tank/config' }, admin));
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json<{ restoring: boolean }>().restoring, true);
  assert.equal((await app.inject(json('POST', '/api/nas/backup/run', {}, member))).statusCode, 403);
});

test('system: the glance, admins only', async () => {
  const res = await app.inject({ url: '/api/nas/system', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ hostname: string }>().hostname, 'nas');
  assert.equal((await app.inject({ url: '/api/nas/system', headers: { cookie: member } })).statusCode, 403);
});

test('power: restart needed and running work, whether the request came through the tunnel; reboot and shutdown with the name typed; admins only', async () => {
  let res = await app.inject({ url: '/api/nas/power', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { restartNeeded: true, packages: ['linux-base'], busy: ['Scrub of tank, 40%'], viaTunnel: false });
  res = await app.inject({ url: '/api/nas/power', headers: { cookie: admin, 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(res.json<{ viaTunnel: boolean }>().viaTunnel, true);
  assert.equal((await app.inject({ url: '/api/nas/power', headers: { cookie: member } })).statusCode, 403);

  assert.equal((await app.inject(json('POST', '/api/nas/system/reboot', { confirm: 'nope' }, admin))).statusCode, 400);
  res = await app.inject(json('POST', '/api/nas/system/shutdown', { confirm: 'nas', extra: 1 }, admin));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ action: string }>().action, 'shutdown');
  assert.deepEqual(seen.at(-1), { id: seen.at(-1)!.id, verb: 'system.shutdown', args: { confirm: 'nas' } });
  assert.equal((await app.inject(json('POST', '/api/nas/system/reboot', { confirm: 'nas' }, member))).statusCode, 403);
});

test('tunnel: status for admins; set and remove refused through the tunnel itself; the token never reaches the audit', async () => {
  let res = await app.inject({ url: '/api/nas/tunnel', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.json().state, res.json().viaTunnel], ['connected', false]);
  res = await app.inject({ url: '/api/nas/tunnel', headers: { cookie: admin, 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(res.json().viaTunnel, true);
  assert.equal((await app.inject({ url: '/api/nas/tunnel', headers: { cookie: member } })).statusCode, 403);

  const through = {
    ...json('PUT', '/api/nas/tunnel', { token: 'good-token' }, admin),
    headers: { ...json('PUT', '/api/nas/tunnel', {}, admin).headers, 'cf-connecting-ip': '203.0.113.9' },
  };
  assert.equal((await app.inject(through)).statusCode, 403, 'not through the tunnel');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/nas/tunnel', headers: { cookie: admin, 'cf-connecting-ip': '203.0.113.9' } })).statusCode, 403);
  assert.equal((await app.inject(json('PUT', '/api/nas/tunnel', { token: 'bad' }, admin))).statusCode, 400);
  res = await app.inject(json('PUT', '/api/nas/tunnel', { token: 'good-token', extra: 1 }, admin));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.at(-1), { id: seen.at(-1)!.id, verb: 'tunnel.set', args: { token: 'good-token' } });
  res = await app.inject({ method: 'DELETE', url: '/api/nas/tunnel', headers: { cookie: admin } });
  assert.equal(res.json().state, 'off');
  const audit = (await app.inject({ url: '/api/audit', headers: { cookie: admin } })).json();
  assert.ok(!JSON.stringify(audit).includes('good-token'), 'the token is not in the drive audit');
  assert.ok(audit.some((a: { action: string }) => a.action === 'nas.tunnel.set'));
});

test('update: read, check now, install exactly the version with only its key; admins only', async () => {
  let res = await app.inject({ url: '/api/nas/update', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ available: boolean }>().available, true);
  res = await app.inject(json('POST', '/api/nas/update/check', {}, admin));
  assert.equal(seen.at(-1)?.verb, 'update.check');
  assert.equal((await app.inject(json('POST', '/api/nas/update/install', { version: '0.5.9' }, admin))).statusCode, 400);
  res = await app.inject(json('POST', '/api/nas/update/install', { version: '0.6.0', force: true }, admin));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.at(-1), { id: seen.at(-1)!.id, verb: 'update.install', args: { version: '0.6.0' } });
  assert.equal(res.json<{ run: { state: string } }>().run.state, 'running');
  for (const [method, url] of [
    ['GET', '/api/nas/update'],
    ['POST', '/api/nas/update/check'],
    ['POST', '/api/nas/update/install'],
  ] as const)
    assert.equal((await app.inject(json(method, url, method === 'GET' ? undefined : { version: '0.6.0' }, member))).statusCode, 403);
});

test('events: newest first, the routine ones only when asked', async () => {
  const some = await app.inject({ url: '/api/nas/events', headers: { cookie: admin } });
  assert.equal(some.statusCode, 200);
  assert.deepEqual(seen.at(-1)?.args, {});
  assert.equal(some.json<{ summary: string }[]>()[0].summary, 'tank: sda went FAULTED');
  await app.inject({ url: '/api/nas/events?all=1&limit=5', headers: { cookie: admin } });
  assert.deepEqual(seen.at(-1)?.args, { all: true, limit: 5 });
  assert.equal((await app.inject({ url: '/api/nas/events', headers: { cookie: member } })).statusCode, 403);
});

test("scrub schedule: listed with the default filled in, set per pool with only the verb's keys", async () => {
  const list = await app.inject({ url: '/api/nas/scrub-policies', headers: { cookie: admin } });
  assert.deepEqual(list.json(), [{ pool: 'tank', interval: 'monthly', updatedAt: null }]);
  const set = await app.inject(json('PUT', '/api/nas/scrub-policies', { pool: 'tank', interval: 'weekly', junk: 1 }, admin));
  assert.equal(set.statusCode, 200, set.body);
  assert.deepEqual(seen.at(-1)?.args, { pool: 'tank', interval: 'weekly' });
  assert.equal(set.json<{ interval: string }>().interval, 'weekly');
  assert.equal((await app.inject(json('PUT', '/api/nas/scrub-policies', { pool: 'tank', interval: 'off' }, member))).statusCode, 403);
});

test("shares: the routes are admin-only and pass the verb's keys", async () => {
  seen.length = 0;
  const res = await app.inject(json('PUT', '/api/nas/shares', { dataset: 'tank/x', smb: true, nfs: false, other: 1 }, admin));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(seen[0].args, { dataset: 'tank/x', smb: true, nfs: false });
  assert.equal((await app.inject(json('PUT', '/api/nas/shares', { dataset: 'tank/x', smb: true }, member))).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/nas/shares', headers: { cookie: admin } })).statusCode, 200);
});

const share = (dataset: string, smb: boolean, smbAccess: Share['smbAccess']): Share => ({
  dataset,
  name: dataset.split('/').pop()!,
  mountpoint: `/srv/locations/${dataset.split('/').pop()}`,
  smb,
  timeMachine: false,
  nfs: !smb,
  nfsClients: [],
  smbAccess,
  updatedAt: 'then',
});

test('shares from before lists become admins-only (read and write) once, audited; the rest are left alone', async () => {
  shares.clear();
  shares.set('tank/old', share('tank/old', true, null));
  shares.set('tank/nfs', share('tank/nfs', false, null));
  shares.set('tank/listed', share('tank/listed', true, [{ user: 'anna', level: 'read' }]));
  seen.length = 0;
  const res = await app.inject({ url: '/api/nas/shares', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200, res.body);
  const list = res.json<Share[]>();
  assert.deepEqual(list.find((s) => s.dataset === 'tank/old')?.smbAccess, [{ user: 'alex', level: 'write' }]);
  assert.equal(list.find((s) => s.dataset === 'tank/nfs')?.smbAccess, null, 'not on SMB: no list needed');
  assert.deepEqual(list.find((s) => s.dataset === 'tank/listed')?.smbAccess, [{ user: 'anna', level: 'read' }]);
  const sets = seen.filter((r) => r.verb === 'share.set');
  assert.deepEqual(
    sets.map((r) => r.args),
    [{ dataset: 'tank/old', smbAccess: [{ user: 'alex', level: 'write' }] }],
    'only the dataset and the list',
  );
  const audit = (await app.inject({ url: '/api/audit?limit=20', headers: { cookie: admin } })).json<{ action: string; detail: string }[]>();
  const entry = audit.filter((a) => a.action === 'nas.share.access' && JSON.parse(a.detail).dataset === 'tank/old');
  assert.equal(entry.length, 1);
  assert.deepEqual(JSON.parse(entry[0].detail), { dataset: 'tank/old', migrated: true, users: ['alex'] });

  seen.length = 0;
  await app.inject({ url: '/api/nas/shares', headers: { cookie: admin } });
  assert.deepEqual(
    seen.map((r) => r.verb),
    ['shares'],
    'once: the list is there now',
  );
});

test('a list set on the share reaches the agent unchanged and is audited', async () => {
  seen.length = 0;
  const smbAccess = [
    { user: 'anna', level: 'read' },
    { user: 'alex', level: 'write' },
  ];
  const res = await app.inject(json('PUT', '/api/nas/shares', { dataset: 'tank/old', smb: true, nfs: false, smbAccess }, admin));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(seen.at(-1)?.args, { dataset: 'tank/old', smb: true, nfs: false, smbAccess });
  assert.deepEqual(res.json<Share>().smbAccess, smbAccess);
  const audit = (await app.inject({ url: '/api/audit?limit=5', headers: { cookie: admin } })).json<{ action: string; detail: string }[]>();
  assert.deepEqual(JSON.parse(audit.find((a) => a.action === 'nas.share.set')!.detail).smbAccess, smbAccess);

  // an agent from before lists refuses the key: the share is set without it
  olderAgent = true;
  try {
    seen.length = 0;
    const older = await app.inject(json('PUT', '/api/nas/shares', { dataset: 'tank/older', smb: true, smbAccess }, admin));
    assert.equal(older.statusCode, 200, older.body);
    assert.deepEqual(
      seen.map((r) => r.args),
      [
        { dataset: 'tank/older', smb: true, smbAccess },
        { dataset: 'tank/older', smb: true },
      ],
    );
  } finally {
    olderAgent = false;
    shares.delete('tank/older');
  }
});

test('share access: the accounts with their SMB names and passwords, and where each starts; admins only', async () => {
  for (const [email, grants] of [
    ['reader@example.com', { Files: 'read' }],
    ['writer@example.com', { Files: 'write' }],
  ] as const)
    await app.inject(json('POST', '/api/users', { email, name: email.split('@')[0], role: 'member', password: PW, grants }, admin));
  smbUsers = [
    { name: 'alex', hasPassword: true, createdAt: 'now' },
    { name: 'reader', hasPassword: false, createdAt: 'now' },
  ];
  try {
    const of = (r: ShareAccess, email: string) => r.accounts.find((a) => a.email === email)!;
    const loc = await app.inject({ url: '/api/nas/shares/access?dataset=tank/Files', headers: { cookie: admin } });
    assert.equal(loc.statusCode, 200, loc.body);
    const l = loc.json<ShareAccess>();
    assert.equal(l.location, 'Files', 'the dataset mounted under the locations dir');
    assert.deepEqual(
      ['alex@example.com', 'reader@example.com', 'writer@example.com', 'anna@example.com'].map((e) => {
        const a = of(l, e);
        return [a.smbName, a.hasPassword, a.grant, a.suggested];
      }),
      [
        ['alex', true, 'write', 'write'],
        ['reader', false, 'read', 'read'],
        ['writer', false, 'write', 'write'],
        ['anna', false, null, null],
      ],
    );
    assert.equal(of(l, 'alex@example.com').role, 'admin');

    const other = (await app.inject({ url: '/api/nas/shares/access?dataset=tank/other', headers: { cookie: admin } })).json<ShareAccess>();
    assert.equal(other.location, null, 'not a location');
    assert.deepEqual(
      ['alex@example.com', 'reader@example.com', 'writer@example.com', 'anna@example.com'].map((e) => [of(other, e).grant, of(other, e).suggested]),
      [
        [null, 'write'],
        [null, null],
        [null, null],
        [null, null],
      ],
    );
    // a disabled account starts with nothing, whatever its grant: Samba does not know the drive disabled it
    const gone = (await app.inject(json('POST', '/api/users', { email: 'gone@example.com', name: 'gone', role: 'member', password: PW, grants: { Files: 'write' } }, admin))).json<{ id: number }>();
    await app.inject(json('PATCH', `/api/users/${gone.id}`, { disabled: true }, admin));
    const off = of((await app.inject({ url: '/api/nas/shares/access?dataset=tank/Files', headers: { cookie: admin } })).json<ShareAccess>(), 'gone@example.com');
    assert.deepEqual([off.grant, off.suggested], ['write', null]);
    assert.equal((await app.inject({ url: '/api/nas/shares/access?dataset=tank/nope', headers: { cookie: admin } })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/nas/shares/access?dataset=tank/Files', headers: { cookie: member } })).statusCode, 403);
  } finally {
    smbUsers = [];
  }
});

test('at startup, once listening, shares from before lists become admins-only too', async () => {
  shares.set('tank/boot', share('tank/boot', true, null));
  const fresh = await createApp(
    {
      ...config,
      staticDir: '',
      dbFile: ':memory:',
      adminEmail: 'alex@example.com',
      adminPassword: PW,
      locations: [],
      locationsDir: join(base, 'locations'),
      accessAud: '',
      nasSocket: join(base, 'mk-nas.sock'),
    },
    { logger: false },
  );
  try {
    assert.equal(shares.get('tank/boot')?.smbAccess, null, 'not before the server listens');
    await fresh.listen({ port: 0, host: '127.0.0.1' });
    for (let i = 0; i < 200 && shares.get('tank/boot')?.smbAccess === null; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(shares.get('tank/boot')?.smbAccess, [{ user: 'alex', level: 'write' }]);
  } finally {
    await fresh.close();
  }
});

test('the account page: every signed-in person may set their own SMB password; the name comes from the email', async () => {
  const before = (await app.inject({ url: '/api/account/smb', headers: { cookie: member } })).json<{ name: string; hasPassword: boolean; host: string }>();
  assert.deepEqual(before, { name: 'anna', hasPassword: false, host: 'nas' });
  assert.equal((await app.inject(json('POST', '/api/account/smb-password', { password: 'short' }, member))).statusCode, 400);
  seen.length = 0;
  const set = await app.inject(json('POST', '/api/account/smb-password', { password: 'correct horse battery' }, member));
  assert.equal(set.statusCode, 200, set.body);
  assert.deepEqual(seen.at(-1)?.args, { name: 'anna', password: 'correct horse battery' });
  const after = (await app.inject({ url: '/api/account/smb', headers: { cookie: member } })).json<{ hasPassword: boolean }>();
  assert.equal(after.hasPassword, true);
  const token = (await app.inject(json('POST', '/api/app-passwords', { name: 'cli' }, member))).json<{ secret: string }>();
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/account/smb-password',
        headers: { authorization: `Bearer ${token.secret}`, 'content-type': 'application/json' },
        payload: '{"password":"correct horse battery"}',
      })
    ).statusCode,
    403,
    'an app password may not change it',
  );
  const plainAdmin = cookieOf(await plain.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }, '')));
  assert.equal((await plain.inject({ url: '/api/account/smb', headers: { cookie: plainAdmin } })).statusCode, 404, 'not in NAS mode: the route does not exist');
});

test('SMB names: two accounts with the same local part get different names, the earlier account keeps the plain one', async () => {
  await app.inject(json('POST', '/api/users', { email: 'anna@other.example', name: 'Anna Two', role: 'member', password: PW }, admin));
  await app.inject(json('POST', '/api/users', { email: '1anna@crafted.example', name: 'Anna Three', role: 'member', password: PW }, admin));
  const users = (await app.inject({ url: '/api/users', headers: { cookie: admin } })).json<{ id: number; email: string }[]>();
  const idOf = (email: string) => users.find((u) => u.email === email)!.id;
  const two = cookieOf(await app.inject(json('POST', '/api/login', { email: 'anna@other.example', password: PW }, '')));
  const three = cookieOf(await app.inject(json('POST', '/api/login', { email: '1anna@crafted.example', password: PW }, '')));

  assert.equal((await app.inject({ url: '/api/account/smb', headers: { cookie: member } })).json<{ name: string }>().name, 'anna');
  assert.equal((await app.inject({ url: '/api/account/smb', headers: { cookie: two } })).json<{ name: string }>().name, `anna-${idOf('anna@other.example')}`);
  assert.equal(
    (await app.inject({ url: '/api/account/smb', headers: { cookie: three } })).json<{ name: string }>().name,
    `anna-${idOf('1anna@crafted.example')}`,
  );
  seen.length = 0;
  assert.equal((await app.inject(json('POST', '/api/account/smb-password', { password: 'correct horse battery' }, two))).statusCode, 200);
  assert.deepEqual(seen.at(-1)?.args, { name: `anna-${idOf('anna@other.example')}`, password: 'correct horse battery' }, 'the first Anna keeps her password');
});

test('SMB names: a suffix is kept within 32 characters and never lands on a name already taken', () => {
  const long = `${'a'.repeat(40)}@x.example`;
  const names = smbUserNames([
    { id: 12, email: 'alex@b.example' },
    { id: 1, email: 'alex@a.example' },
    { id: 7, email: long },
    { id: 3, email: long.replace('@x', '@y') },
    { id: 20, email: 'alex-12@c.example' },
    { id: 30, email: 'root@x.example' },
  ]);
  assert.equal(names.get(1), 'alex');
  assert.equal(names.get(12), 'alex-12');
  assert.equal(names.get(3), 'a'.repeat(32));
  assert.equal(names.get(7), `${'a'.repeat(30)}-7`);
  assert.notEqual(names.get(20), 'alex-12');
  assert.match(names.get(20)!, /^alex-12-20/);
  assert.equal(names.get(30), 'root-');
  for (const n of names.values()) assert.match(n, /^[a-z][a-z0-9._-]{0,31}$/);
});

test('replication: key, set, run, jobs by replication', async () => {
  seen.length = 0;
  assert.equal(
    (await app.inject({ url: '/api/nas/replications/key', headers: { cookie: admin } })).json<{ publicKey: string }>().publicKey,
    'ssh-ed25519 AAAA mk-nas',
  );
  const set = await app.inject(
    json('PUT', '/api/nas/replications', { dataset: 'tank/photos', host: 'truenas', targetDataset: 'backup/photos', junk: 1 }, admin),
  );
  assert.equal(set.statusCode, 200, set.body);
  assert.deepEqual(seen.at(-1)?.args, { dataset: 'tank/photos', host: 'truenas', targetDataset: 'backup/photos' });
  const run = await app.inject(json('POST', '/api/nas/replications/7/run', {}, admin));
  assert.equal(run.statusCode, 200, run.body);
  assert.deepEqual(seen.at(-1)?.args, { id: 7 });
  const jobs = await app.inject({ url: '/api/nas/jobs?replication=7', headers: { cookie: admin } });
  assert.deepEqual(seen.at(-1)?.args, { replicationId: 7 });
  assert.equal(jobs.json<unknown[]>().length, 1);
  assert.equal((await app.inject(json('POST', '/api/nas/replications/7/run', {}, member))).statusCode, 403);
});

test('meta asks for an upgrade when the agent speaks an older contract', async () => {
  agentVersion = '0.4.0';
  agentContract = 1;
  // the version is cached a minute: a fresh app sees the old agent at once
  const fresh = await createApp(
    {
      ...config,
      staticDir: '',
      dbFile: ':memory:',
      adminEmail: 'alex@example.com',
      adminPassword: PW,
      locations: [],
      accessAud: '',
      nasSocket: join(base, 'mk-nas.sock'),
    },
    { logger: false },
  );
  try {
    const meta = (await fresh.inject({ url: '/api/meta' })).json<Meta>();
    assert.deepEqual(meta.nasOutdated, { agent: '0.4.0', contract: 1, needs: 2 });
  } finally {
    await fresh.close();
    agentVersion = '0.2.0';
    agentContract = 2;
  }
  const current = (await app.inject({ url: '/api/meta' })).json<Meta>();
  assert.equal(current.nasOutdated, undefined);
});

test('an agent that is not there is a 503, not a crash', async () => {
  const gone = await createApp(
    {
      ...config,
      staticDir: '',
      dbFile: ':memory:',
      adminEmail: 'alex@example.com',
      adminPassword: PW,
      locations: [],
      accessAud: '',
      nasSocket: join(base, 'absent.sock'),
    },
    { logger: false },
  );
  try {
    const cookie = cookieOf(await gone.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }, '')));
    const res = await gone.inject({ url: '/api/nas/health', headers: { cookie } });
    assert.equal(res.statusCode, 503);
    assert.match(res.json<{ message: string }>().message, /not running/);
  } finally {
    await gone.close();
  }
});
