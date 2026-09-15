import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { Meta, SsoSettings } from '../../shared/types.ts';

const PW = 'correct horse battery';
let base: string;
const apps: FastifyInstance[] = [];

async function appWith(passwordLogin: Config['passwordLogin'], dbFile = ':memory:'): Promise<FastifyInstance> {
  const cfg: Config = {
    ...config,
    staticDir: '',
    dbFile,
    adminEmail: 'alex@example.com',
    adminPassword: PW,
    locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }],
    accessAud: '',
    passwordLogin,
  };
  const app = await createApp(cfg, { logger: false });
  apps.push(app);
  return app;
}

const login = (app: FastifyInstance, remoteAddress: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/login',
    remoteAddress,
    payload: JSON.stringify({ email: 'alex@example.com', password: PW }),
    headers: { 'content-type': 'application/json', ...headers },
  });
const meta = async (app: FastifyInstance, remoteAddress: string, headers: Record<string, string> = {}) =>
  (await app.inject({ url: '/api/meta', remoteAddress, headers })).json<Meta>();

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-pw-'));
  await mkdir(join(base, 'docs'), { recursive: true });
});
after(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await rm(base, { recursive: true, force: true });
});

test('on: the form is offered everywhere', async () => {
  const app = await appWith('on');
  assert.equal((await meta(app, '203.0.113.5')).passwordLogin, true);
  assert.equal((await login(app, '203.0.113.5')).statusCode, 200);
});

test('local: private addresses may use the password, the internet (and anything via Cloudflare) may not', async () => {
  const app = await appWith('local');
  assert.equal((await meta(app, '192.168.1.7')).passwordLogin, true);
  assert.equal((await meta(app, '192.168.1.7')).passwordLoginLocal, true);
  assert.equal((await login(app, '192.168.1.7')).statusCode, 200);
  assert.equal((await login(app, '::ffff:10.0.0.9')).statusCode, 200);
  const outside = await meta(app, '203.0.113.5');
  assert.deepEqual([outside.passwordLogin, outside.passwordLoginLocal], [false, true]);
  const refused = await login(app, '203.0.113.5');
  assert.equal(refused.statusCode, 403);
  assert.match(refused.json().message, /only on the local network/);
  // carrier-grade NAT is not the local network
  assert.equal((await login(app, '100.64.0.9')).statusCode, 403);
  // through the tunnel the peer is a Docker address, but Cloudflare's headers say where it really came from
  assert.equal((await login(app, '172.18.0.3', { 'cf-connecting-ip': '198.51.100.4' })).statusCode, 403);
  // a trusted proxy's X-Forwarded-For is believed
  assert.equal((await login(app, '127.0.0.1', { 'x-forwarded-for': '198.51.100.4' })).statusCode, 403);
  // SSO and the rest of the API are untouched
  assert.equal((await app.inject({ url: '/api/health', remoteAddress: '203.0.113.5' })).statusCode, 200);
});

test("throttle: Cloudflare's client address is believed only from a trusted proxy", async () => {
  const app = await appWith('on');
  const as = (remoteAddress: string, email: string, password: string, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress,
      payload: JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json', ...headers },
    });
  // straight from the internet: a made-up header does not buy a fresh address
  assert.equal((await as('203.0.113.5', 'nobody@example.com', 'wrong-one', { 'cf-connecting-ip': '198.51.100.1' })).statusCode, 401);
  assert.equal((await as('203.0.113.5', 'alex@example.com', PW, { 'cf-connecting-ip': '198.51.100.2' })).statusCode, 429);
  // through the tunnel (a trusted peer) each visitor is their own address
  assert.equal((await as('127.0.0.1', 'someone@example.com', 'wrong-one', { 'cf-connecting-ip': '198.51.100.3' })).statusCode, 401);
  assert.equal((await as('127.0.0.1', 'alex@example.com', PW, { 'cf-connecting-ip': '198.51.100.4' })).statusCode, 200);
});

test('throttle: a concurrent burst for one account is judged one attempt at a time', async () => {
  const app = await appWith('on');
  const burst = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: `203.0.113.${i + 1}`,
        payload: JSON.stringify({ email: 'alex@example.com', password: i === 11 ? PW : `wrong-${i}` }),
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  const codes = burst.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 401).length, 1, `one guess evaluated: ${codes.join(',')}`);
  assert.equal(codes.filter((c) => c === 429).length, 11);
});

test('off: never, even on the LAN', async () => {
  const app = await appWith('off');
  assert.equal((await meta(app, '127.0.0.1')).passwordLogin, false);
  assert.equal((await meta(app, '127.0.0.1')).passwordLoginLocal, undefined);
  const refused = await login(app, '127.0.0.1');
  assert.equal(refused.statusCode, 403);
  assert.match(refused.json().message, /is off/);
});

const signIn = async (app: FastifyInstance, remoteAddress = '192.168.1.7') => String((await login(app, remoteAddress)).headers['set-cookie']).split(';')[0];
const audit = async (app: FastifyInstance, cookie: string) =>
  (await app.inject({ url: '/api/audit', remoteAddress: '192.168.1.7', headers: { cookie } })).json() as { action: string; email: string; detail: string }[];

test('local: a refusal is the same whether the password was right, audited with the reason and address, and throttles nobody on the LAN', async () => {
  const app = await appWith('local');
  const wrong = await app.inject({
    method: 'POST',
    url: '/api/login',
    remoteAddress: '203.0.113.5',
    payload: JSON.stringify({ email: 'alex@example.com', password: 'not the password' }),
    headers: { 'content-type': 'application/json' },
  });
  const right = await login(app, '203.0.113.5');
  assert.deepEqual([wrong.statusCode, right.statusCode], [403, 403]);
  assert.equal(wrong.json().message, right.json().message, 'the refusal does not tell a right password from a wrong one');
  for (let i = 0; i < 5; i++) assert.equal((await login(app, '203.0.113.5')).statusCode, 403, 'refused again, not a 429');
  // the account itself is not held back at home
  const cookie = await signIn(app);
  assert.ok(cookie.startsWith('mkdrive_session='));
  const refusals = (await audit(app, cookie)).filter((a) => a.action === 'login.failed');
  assert.ok(refusals.length >= 1 && refusals.length < 7, `refusals audited on a back-off: ${refusals.length}`);
  assert.equal(refusals[0].email, 'alex@example.com');
  assert.match(refusals[0].detail, /outside the local network \(203\.0\.113\.5\)/);
});

test('local and off: an app password still works from anywhere (Basic and Bearer)', async () => {
  const dbFile = join(base, 'tokens.db');
  const first = await appWith('on', dbFile);
  const cookie = await signIn(first);
  const made = await first.inject({
    method: 'POST',
    url: '/api/app-passwords',
    remoteAddress: '192.168.1.7',
    payload: JSON.stringify({ name: 'phone' }),
    headers: { 'content-type': 'application/json', cookie },
  });
  const secret = made.json().secret as string;
  await first.close();
  for (const mode of ['local', 'off'] as const) {
    const app = await appWith(mode, dbFile);
    assert.equal((await login(app, '203.0.113.5')).statusCode, 403);
    const basic = `Basic ${Buffer.from(`alex@example.com:${secret}`).toString('base64')}`;
    for (const authorization of [basic, `Bearer ${secret}`]) {
      const me = await app.inject({ url: '/api/me', remoteAddress: '127.0.0.1', headers: { authorization, 'cf-connecting-ip': '198.51.100.4' } });
      assert.equal(me.statusCode, 200, `${mode}: ${me.body}`);
    }
    await app.close();
  }
});

test('Settings → Sign-in: an admin picks the mode when the environment does not; off needs single sign-on; env, members and app passwords are refused', async () => {
  const app = await appWith('');
  const cookie = await signIn(app);
  const put = (mode: unknown, headers: Record<string, string> = { cookie }) =>
    app.inject({
      method: 'PUT',
      url: '/api/settings/password-login',
      remoteAddress: '192.168.1.7',
      payload: JSON.stringify({ mode }),
      headers: { 'content-type': 'application/json', ...headers },
    });
  let view = (await app.inject({ url: '/api/settings/sso', remoteAddress: '192.168.1.7', headers: { cookie } })).json<SsoSettings>();
  assert.deepEqual([view.passwordLogin, view.passwordLoginSource, view.passwordLoginOff], ['on', 'settings', false]);

  const local = await put('local');
  assert.equal(local.statusCode, 200, local.body);
  view = local.json<SsoSettings>();
  assert.deepEqual([view.passwordLogin, view.passwordLoginSource], ['local', 'settings']);
  // in force at once: the internet (through the tunnel) is refused, home is not, the admin's session stays
  assert.equal((await meta(app, '127.0.0.1', { 'cf-connecting-ip': '198.51.100.4' })).passwordLogin, false);
  assert.equal((await login(app, '127.0.0.1', { 'cf-connecting-ip': '198.51.100.4' })).statusCode, 403);
  assert.equal((await login(app, '192.168.1.8')).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/me', remoteAddress: '203.0.113.5', headers: { cookie } })).statusCode, 200);

  assert.equal((await put('sometimes')).statusCode, 400);
  const off = await put('off');
  assert.equal(off.statusCode, 400, 'no single sign-on: off would lock everyone out');
  assert.match(off.json().message, /single sign-on first/);

  const member = await app.inject({
    method: 'POST',
    url: '/api/users',
    remoteAddress: '192.168.1.7',
    payload: JSON.stringify({ email: 'm@example.com', name: 'M', role: 'member', password: 'another long password' }),
    headers: { 'content-type': 'application/json', cookie },
  });
  assert.equal(member.statusCode, 201, member.body);
  const mc = String(
    (
      await app.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '192.168.1.7',
        payload: JSON.stringify({ email: 'm@example.com', password: 'another long password' }),
        headers: { 'content-type': 'application/json' },
      })
    ).headers['set-cookie'],
  ).split(';')[0];
  assert.equal((await put('on', { cookie: mc })).statusCode, 403);
  const secret = (
    await app.inject({
      method: 'POST',
      url: '/api/app-passwords',
      remoteAddress: '192.168.1.7',
      payload: JSON.stringify({ name: 'script' }),
      headers: { 'content-type': 'application/json', cookie },
    })
  ).json().secret as string;
  assert.equal((await put('on', { authorization: `Bearer ${secret}` })).statusCode, 403);

  assert.equal((await put('on')).statusCode, 200);
  assert.equal((await meta(app, '203.0.113.5')).passwordLogin, true);
  assert.equal((await meta(app, '203.0.113.5')).passwordLoginLocal, undefined);
  assert.ok((await audit(app, cookie)).some((a) => a.action === 'settings.password-login'));

  // the environment wins and shows read-only
  const envApp = await appWith('local');
  const envCookie = await signIn(envApp);
  const envView = (await envApp.inject({ url: '/api/settings/sso', remoteAddress: '192.168.1.7', headers: { cookie: envCookie } })).json<SsoSettings>();
  assert.deepEqual([envView.passwordLogin, envView.passwordLoginSource], ['local', 'env']);
  const refused = await envApp.inject({
    method: 'PUT',
    url: '/api/settings/password-login',
    remoteAddress: '192.168.1.7',
    payload: JSON.stringify({ mode: 'on' }),
    headers: { 'content-type': 'application/json', cookie: envCookie },
  });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().message, /DRIVE_PASSWORD_LOGIN/);
});
