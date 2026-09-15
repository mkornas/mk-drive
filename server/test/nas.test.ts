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
import type { Meta } from '../../shared/types.ts';
import type { Request } from '../../shared/nas.ts';

const PW = 'correct horse battery';
let base: string;
let app: FastifyInstance;
let plain: FastifyInstance;
let agent: Server;
let admin = '';
let member = '';
const seen: Request[] = [];
let smbUsers: { name: string; hasPassword: boolean; createdAt: string }[] = [];
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
        if (req.verb === 'pools')
          reply({ ok: true, result: [{ name: 'tank', health: 'ONLINE', size: 100, allocated: 10, free: 90, capacity: 10, fragmentation: 0 }] });
        else if (req.verb === 'pool' && req.args?.pool === 'tank') reply({ ok: true, result: { name: 'tank', health: 'ONLINE', vdevs: [] } });
        else if (req.verb === 'pool') reply({ ok: false, error: { code: 'not-found', message: `cannot open '${String(req.args?.pool)}': no such pool` } });
        else if (req.verb === 'smart') reply({ ok: false, error: { code: 'bad-args', message: 'disk: not a disk id' } });
        else if (req.verb === 'smart.test')
          reply({ ok: true, result: { id: req.args?.disk, selfTest: { running: { kind: req.args?.kind, percentDone: 0 }, tests: [] } } });
        else if (req.verb === 'datasets') reply({ ok: true, result: [] });
        else if (req.verb === 'version')
          reply({ ok: true, result: { agent: agentVersion, contract: agentContract, node: 't', zfs: null, smartctl: null, hostname: 'nas' } });
        else if (req.verb === 'users') reply({ ok: true, result: smbUsers });
        else if (req.verb === 'user.smbPassword') {
          smbUsers = [{ name: String(req.args?.name), hasPassword: true, createdAt: 'now' }];
          reply({ ok: true, result: smbUsers[0] });
        } else if (req.verb === 'share.set')
          reply({
            ok: true,
            result: {
              dataset: req.args?.dataset,
              name: 'x',
              mountpoint: '/srv/locations/x',
              smb: !!req.args?.smb,
              timeMachine: false,
              nfs: !!req.args?.nfs,
              nfsClients: [],
              updatedAt: 'now',
            },
          });
        else if (req.verb === 'shares') reply({ ok: true, result: [] });
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
  const cfg = (nasSocket: string): Config => ({
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: 'alex@example.com',
    adminPassword: PW,
    locations: [],
    locationsDir: join(base, 'locations'),
    accessAud: '',
    nasSocket,
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
