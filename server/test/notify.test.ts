import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Alert, Alerts } from '../../shared/nas.ts';
import { decide, readPrefs, settingsFor, watchOnce, writePrefs } from '../src/notify.ts';
import { deviceName, isPushEndpoint, Push } from '../src/push.ts';
import { Settings } from '../src/settings.ts';
import { openDb } from '../src/db.ts';
import { Users } from '../src/users.ts';
import type { FastifyInstance } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { NotifySettings } from '../../shared/types.ts';

const alert = (over: Partial<Alert>): Alert => ({
  key: 'pool:tank:state',
  severity: 'critical',
  title: 'Pool tank is DEGRADED',
  detail: 'Replace the disk.',
  since: '2026-09-16T09:00:00.000Z',
  lastSeen: '2026-09-16T09:05:00.000Z',
  confirmed: true,
  ackedAt: null,
  clearedAt: null,
  ...over,
});
const alerts = (open: Alert[], recent: Alert[] = []): Alerts => ({ open, recent, worst: open[0]?.severity ?? null });

test('what is worth waking someone: confirmed, loud enough, and not already told', () => {
  const hot = alert({ key: 'disk:d1:temp', severity: 'warning', title: 'Disk d1 is at 56 °C' });
  const fresh = alert({ key: 'pool:tank:full', severity: 'critical', confirmed: false, title: 'Pool tank is 96% full' });
  const news = alerts([alert({}), hot, fresh, alert({ key: 'update:available', severity: 'info', title: 'mk-nas 0.9.0 is out' })]);

  const d = decide(new Set(), news, 'warning');
  assert.deepEqual(d.raised.map((a) => a.key), ['pool:tank:state', 'disk:d1:temp'], 'worst first; the unconfirmed one waits, info is below the line');
  assert.deepEqual(d.cleared, []);

  assert.deepEqual(decide(new Set(), news, 'critical').raised.map((a) => a.key), ['pool:tank:state']);
  assert.deepEqual(decide(new Set(), news, 'info').raised.map((a) => a.key), ['pool:tank:state', 'disk:d1:temp', 'update:available']);
  assert.deepEqual(decide(new Set(['pool:tank:state']), news, 'warning').raised.map((a) => a.key), ['disk:d1:temp'], 'nobody is told twice');
});

test('when it is over, the people who heard about it hear that too', () => {
  const gone = alert({ clearedAt: '2026-09-16T10:00:00.000Z' });
  const d = decide(new Set(['pool:tank:state']), alerts([], [gone]), 'warning');
  assert.deepEqual(d.cleared.map((a) => a.key), ['pool:tank:state']);
  assert.deepEqual(decide(new Set(), alerts([], [gone]), 'warning').cleared, [], 'nothing was said, so there is nothing to take back');
});

test('an endpoint is an https URL and nothing else; a device gets a readable name', () => {
  assert.equal(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(isPushEndpoint('http://fcm.googleapis.com/x'), false, 'the server POSTs there: https only');
  assert.equal(isPushEndpoint('https://user:pass@example.com/x'), false);
  assert.equal(isPushEndpoint('file:///etc/passwd'), false);
  // never the box itself or a neighbour: no addresses, no port, no local names
  for (const inward of [
    'https://127.0.0.1/x',
    'https://192.168.1.1/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://nas/x',
    'https://nas.local/x',
    'https://router.lan/x',
    'https://db.internal/x',
    'https://fcm.googleapis.com:8443/x',
    'https://LOCALHOST./x',
  ])
    assert.equal(isPushEndpoint(inward), false, inward);
  for (const real of ['https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc', 'https://wns2-par02p.notify.windows.com/w/?token=abc'])
    assert.equal(isPushEndpoint(real), true, real);
  assert.equal(isPushEndpoint('https://' + 'x'.repeat(3000)), false);
  assert.equal(isPushEndpoint(42), false);
  assert.equal(deviceName('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox on Linux');
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iOS');
  assert.equal(deviceName(undefined), 'A browser');
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'mk-drive-notify-'));
  const db = openDb(join(dir, 'drive.db'));
  const settings = new Settings(db);
  const users = new Users(db);
  const push = new Push(db, settings, { subject: 'mailto:test@example.com', publicKey: '', privateKey: '' });
  return { dir, db, settings, users, push };
}

test('subscriptions belong to an account: one row per browser, forgotten by endpoint or by id', async () => {
  const { dir, db, settings, users, push } = await fixture();
  try {
    const me = await users.create({ email: 'admin@example.com', name: 'A', role: 'admin', password: 'a-long-enough-password' });
    const other = await users.create({ email: 'member@example.com', name: 'B', role: 'member', password: 'a-long-enough-password' });
    const sub = { endpoint: 'https://push.example.com/one', keys: { p256dh: 'k', auth: 'a' } };
    push.subscribe(me.id, sub, 'Mozilla/5.0 (X11; Linux) Firefox/130.0');
    push.subscribe(me.id, sub, 'Mozilla/5.0 (X11; Linux) Firefox/130.0');
    assert.equal(push.devices(me.id).length, 1, 'subscribing again from the same browser is not a second device');
    push.subscribe(me.id, { endpoint: 'https://push.example.com/two', keys: { p256dh: 'k', auth: 'a' } }, 'Chrome/120 Windows');
    assert.equal(push.devices(me.id).length, 2);
    assert.equal(push.devices(other.id).length, 0, "another account cannot see this account's devices");
    assert.equal(push.devices(me.id, sub.endpoint).find((d) => d.current)?.name, 'Firefox on Linux');

    assert.equal(push.unsubscribe(other.id, { endpoint: sub.endpoint }), false, 'and cannot remove them either');
    assert.equal(push.unsubscribe(me.id, { endpoint: sub.endpoint }), true);
    const [left] = push.devices(me.id);
    assert.equal(push.unsubscribe(me.id, { id: left.id }), true);
    assert.deepEqual(push.devices(me.id), []);

    assert.throws(() => push.subscribe(me.id, { endpoint: 'http://push.example.com/x', keys: { p256dh: 'k', auth: 'a' } }, ''), /push endpoint/);
    assert.equal(settingsFor(push, settings, me.id).supported, true, 'the keys are made on first use');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('preferences: a sane default, only the values that exist, and nothing crosses accounts', async () => {
  const { dir, db, settings, users, push } = await fixture();
  try {
    const me = await users.create({ email: 'admin@example.com', name: 'A', role: 'admin', password: 'a-long-enough-password' });
    assert.deepEqual(readPrefs(settings, me.id), { minSeverity: 'warning', nasAlerts: true });
    writePrefs(settings, me.id, { minSeverity: 'critical' });
    assert.deepEqual(readPrefs(settings, me.id), { minSeverity: 'critical', nasAlerts: true });
    writePrefs(settings, me.id, { nasAlerts: false });
    assert.deepEqual(readPrefs(settings, me.id), { minSeverity: 'critical', nasAlerts: false });
    assert.throws(() => writePrefs(settings, me.id, { minSeverity: 'loud' as never }), /critical, warning or info/);
    assert.deepEqual(readPrefs(settings, me.id + 99), { minSeverity: 'warning', nasAlerts: true });
    assert.equal(settingsFor(push, settings, me.id).minSeverity, 'critical');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a pass over the alerts tells each admin once, keeps what is open, and forgets what cleared', async () => {
  const { dir, db, settings, users, push } = await fixture();
  try {
    const admin = await users.create({ email: 'admin@example.com', name: 'A', role: 'admin', password: 'a-long-enough-password' });
    const member = await users.create({ email: 'member@example.com', name: 'B', role: 'member', password: 'a-long-enough-password' });
    const quiet = await users.create({ email: 'quiet@example.com', name: 'C', role: 'admin', password: 'a-long-enough-password' });
    writePrefs(settings, quiet.id, { nasAlerts: false });
    const sent: { userIds: number[]; title: string; tag?: string }[] = [];
    const fake = { ...push, send: async (userIds: number[], n: { title: string; tag?: string }) => (sent.push({ userIds, title: n.title, tag: n.tag }), 1) } as unknown as Push;
    let live = alerts([alert({})]);
    const deps = { push: fake, settings, users, alerts: async () => live };

    await watchOnce(deps);
    assert.deepEqual(sent.map((s) => [s.userIds[0], s.title]), [[admin.id, 'Pool tank is DEGRADED']], 'the admin who wants them, and nobody else');
    assert.equal(sent[0].tag, 'nas:pool:tank:state', 'the key is the tag, so it replaces itself rather than stacking');
    assert.ok(![member.id, quiet.id].includes(sent[0].userIds[0]));

    sent.length = 0;
    await watchOnce(deps);
    assert.equal(sent.length, 0, 'still true, already told');

    sent.length = 0;
    live = alerts([], [alert({ clearedAt: '2026-09-16T11:00:00.000Z' })]);
    await watchOnce(deps);
    assert.deepEqual(sent.map((s) => s.title), ['Over: Pool tank is DEGRADED']);

    sent.length = 0;
    live = alerts([alert({})]);
    await watchOnce(deps);
    assert.deepEqual(sent.map((s) => s.title), ['Pool tank is DEGRADED'], 'it happened again: worth saying again');

    sent.length = 0;
    const broken = { ...deps, alerts: async () => { throw new Error('the agent is older than alerts'); } };
    assert.deepEqual(await watchOnce(broken), { sent: 0 }, 'an agent without the verb is quiet, not a crash');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the routes ----

const PW = 'correct horse battery';

test('the notification routes: this account only, a real session only, and nothing silly accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-drive-notify-routes-'));
  await mkdir(join(dir, 'docs'), { recursive: true });
  const cfg: Config = { ...config, staticDir: '', dbFile: ':memory:', dataDir: join(dir, 'data'), adminEmail: 'alex@example.com', adminPassword: PW, accessAud: '', locations: [{ name: 'Docs', path: join(dir, 'docs'), mode: 'rw', hide: [] }] };
  const app: FastifyInstance = await createApp(cfg, { logger: false });
  const json = { 'content-type': 'application/json' };
  try {
    assert.equal((await app.inject({ url: '/api/notifications' })).statusCode, 401, 'signed out: nothing to see');
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: json, payload: { email: 'alex@example.com', password: PW } });
    const cookie = ([] as string[]).concat((login.headers['set-cookie'] as string | string[]) ?? [])[0].split(';')[0];

    const first = await app.inject({ url: '/api/notifications', headers: { cookie } });
    assert.equal(first.statusCode, 200);
    const s = first.json<NotifySettings>();
    assert.equal(s.supported, true);
    assert.ok(s.publicKey && s.publicKey.length > 20, 'the page needs the key to subscribe');
    assert.deepEqual(s.devices, []);
    assert.equal(s.minSeverity, 'warning');

    const bad = await app.inject({ method: 'POST', url: '/api/notifications/subscribe', headers: { cookie, ...json }, payload: { endpoint: 'http://evil.example/x', keys: { p256dh: 'k', auth: 'a' } } });
    assert.equal(bad.statusCode, 400, 'the server POSTs to that address later: https only');

    const ok = await app.inject({ method: 'POST', url: '/api/notifications/subscribe', headers: { cookie, ...json, 'user-agent': 'Mozilla/5.0 (X11; Linux) Firefox/130.0' }, payload: { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k', auth: 'a' } } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json<NotifySettings>().devices.map((d) => [d.name, d.current]), [['Firefox on Linux', true]]);

    const pref = await app.inject({ method: 'PUT', url: '/api/notifications', headers: { cookie, ...json }, payload: { minSeverity: 'critical' } });
    assert.equal(pref.json<NotifySettings>().minSeverity, 'critical');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/notifications', headers: { cookie, ...json }, payload: { minSeverity: 'nope' } })).statusCode, 400);

    const device = ok.json<NotifySettings>().devices[0];
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/notifications/devices/${device.id + 999}`, headers: { cookie } })).statusCode, 404);
    const gone = await app.inject({ method: 'DELETE', url: `/api/notifications/devices/${device.id}`, headers: { cookie } });
    assert.deepEqual(gone.json<NotifySettings>().devices, []);

    const test = await app.inject({ method: 'POST', url: '/api/notifications/test', headers: { cookie, ...json } });
    assert.equal(test.statusCode, 400, 'no device subscribed: say so instead of pretending');

    assert.equal((await app.inject({ url: '/api/nas/alerts', headers: { cookie } })).statusCode, 404, 'no NAS socket: the route does not exist');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
