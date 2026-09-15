import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { Meta } from '../../shared/types.ts';

const PW = 'correct horse battery';
let base: string;
let app: FastifyInstance;

function cfgWith(over: Partial<Config>): Config {
  return {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: 'alex@example.com',
    adminPassword: PW,
    locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }],
    accessAud: '',
    ...over,
  };
}

const setCookies = (res: { headers: Record<string, unknown> }) => ([] as string[]).concat((res.headers['set-cookie'] as string | string[]) ?? []);
const login = async (a: FastifyInstance, headers: Record<string, string> = {}) =>
  a.inject({
    method: 'POST',
    url: '/api/login',
    headers: { 'content-type': 'application/json', ...headers },
    payload: { email: 'alex@example.com', password: PW },
  });
const cookieOf = (res: { headers: Record<string, unknown> }) => setCookies(res)[0].split(';')[0];
/** A body-less POST, like a form or fetch() from another page would send. */
const bare = (url: string, headers: Record<string, string>): InjectOptions => ({ method: 'POST', url, headers });

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-security-'));
  await mkdir(join(base, 'docs', 'public'), { recursive: true });
  app = await createApp(cfgWith({}), { logger: false });
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('CSRF: a same-site POST without a body is refused; the drive’s own pages and header-less clients are not', async () => {
  const cookie = cookieOf(await login(app));
  const other = cookieOf(await login(app));
  const alive = async (c: string) => (await app.inject({ url: '/api/me', headers: { cookie: c } })).statusCode === 200;

  // another port on this host, or a sibling subdomain: same-site, and SameSite=Lax lets the cookie ride along
  const sameSite = await app.inject(bare('/api/sessions/revoke-others', { cookie, 'sec-fetch-site': 'same-site' }));
  assert.equal(sameSite.statusCode, 403);
  assert.ok(await alive(other), 'nothing was revoked');
  assert.equal((await app.inject(bare('/api/logout', { cookie, 'sec-fetch-site': 'cross-site' }))).statusCode, 403);

  // no Sec-Fetch-Site (plain-http LAN browsers): a foreign Origin is refused, the drive's own is not
  const foreign = await app.inject(bare('/api/sessions/revoke-others', { cookie, host: 'drive.test', origin: 'http://drive.test:8080' }));
  assert.equal(foreign.statusCode, 403);
  assert.equal((await app.inject(bare('/api/sessions/revoke-others', { cookie, host: 'drive.test', origin: 'null' }))).statusCode, 403);
  assert.ok(await alive(other));
  const own = await app.inject(bare('/api/sessions/revoke-others', { cookie, host: 'drive.test', origin: 'http://drive.test' }));
  assert.equal(own.statusCode, 200, own.body);

  // the drive's own page (same-origin), and a request the user started (none)
  const other2 = cookieOf(await login(app));
  assert.equal((await app.inject(bare('/api/sessions/revoke-others', { cookie, 'sec-fetch-site': 'same-origin' }))).statusCode, 200);
  assert.ok(!(await alive(other2)), 'same-origin went through');
  assert.equal((await app.inject(bare('/api/sessions/revoke-others', { cookie, 'sec-fetch-site': 'none' }))).statusCode, 200);

  // curl, WebDAV clients, the iOS app: neither header
  assert.equal((await app.inject(bare('/api/sessions/revoke-others', { cookie }))).statusCode, 200);
  const made = await app.inject({
    method: 'POST',
    url: '/api/app-passwords',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { name: 'phone' },
  });
  const secret = made.json().secret as string;
  const mkdirRes = await app.inject({
    method: 'POST',
    url: '/api/mkdir',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    payload: { path: 'Docs', name: 'from-the-app' },
  });
  assert.equal(mkdirRes.statusCode, 200, mkdirRes.body);
  const basic = Buffer.from(`alex@example.com:${secret}`).toString('base64');
  const viaBasic = await app.inject({
    method: 'POST',
    url: '/api/mkdir',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
    payload: { path: 'Docs', name: 'from-webdav-client' },
  });
  assert.equal(viaBasic.statusCode, 200, viaBasic.body);
});

test('CSRF: a public share link still takes a POST from the drive’s own page', async () => {
  const cookie = cookieOf(await login(app));
  const share = await app.inject({
    method: 'POST',
    url: '/api/shares',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { path: 'Docs/public', password: 'open sesame 123' },
  });
  assert.equal(share.statusCode, 201, share.body);
  const id = share.json().id as string;
  const unlock = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `/api/s/${id}/unlock`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: { password: 'open sesame 123' },
    });
  assert.equal((await unlock({ 'sec-fetch-site': 'same-origin' })).statusCode, 200);
  assert.equal((await unlock({ host: 'drive.test', origin: 'http://drive.test' })).statusCode, 200);
  assert.equal((await unlock({ 'sec-fetch-site': 'same-site' })).statusCode, 403);
});

test('session cookie: __Host- on HTTPS (the old name still read, then cleared), the plain name on http', async () => {
  const plain = await login(app);
  assert.match(setCookies(plain)[0], /^mkdrive_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);

  const https = { 'x-forwarded-proto': 'https' };
  const secure = await login(app, https);
  const [set] = setCookies(secure);
  assert.match(set, /^__Host-mkdrive_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.ok(!/Domain=/i.test(set));
  const hostCookie = set.split(';')[0];
  assert.equal((await app.inject({ url: '/api/me', headers: { ...https, cookie: hostCookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: hostCookie } })).statusCode, 401, 'http never reads the __Host- name');

  // a session from before the upgrade keeps working on HTTPS; the next sign-in replaces it and clears the old name
  const old = cookieOf(plain);
  assert.equal((await app.inject({ url: '/api/me', headers: { ...https, cookie: old } })).statusCode, 200);
  const again = await login(app, { ...https, cookie: old });
  const cookies = setCookies(again);
  assert.match(cookies[0], /^__Host-mkdrive_session=/);
  assert.ok(
    cookies.some((c) => /^mkdrive_session=; .*Max-Age=0/.test(c)),
    'the old name is cleared',
  );

  // a sibling subdomain's planted plain cookie does not win over the __Host- one
  const me = (await app.inject({ url: '/api/me', headers: { ...https, cookie: `mkdrive_session=planted; ${hostCookie}` } })).statusCode;
  assert.equal(me, 200);

  const out = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { ...https, cookie: hostCookie, 'content-type': 'application/json' },
    payload: {},
  });
  assert.deepEqual(
    setCookies(out).map((c) => c.split('=')[0]),
    ['__Host-mkdrive_session', 'mkdrive_session'],
  );
  assert.equal((await app.inject({ url: '/api/me', headers: { ...https, cookie: hostCookie } })).statusCode, 401);
});

test('setup code: asked for when DRIVE_SETUP_TOKEN is set, wrong ones refused and throttled, gone after setup', async () => {
  const code = 'K7QX-94MZ-RT2P';
  const fresh = await createApp(cfgWith({ adminEmail: '', adminPassword: '', setupToken: code }), { logger: false });
  const setup = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fresh.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'content-type': 'application/json', ...headers },
      payload: { email: 'owner@example.com', name: 'Owner', password: PW, ...body },
    });
  try {
    const meta = (await fresh.inject({ url: '/api/meta' })).json() as Meta;
    assert.equal(meta.setupRequired, true);
    assert.equal(meta.setupCodeRequired, true);

    const missing = await setup({});
    assert.equal(missing.statusCode, 403);
    assert.match(missing.json().message, /setup code/);
    const wrong = await setup({ setupCode: 'K7QX-94MZ-RT2Q' }, { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(wrong.statusCode, 403);
    assert.match(wrong.json().message, /wrong/);
    // the same address must wait before the next guess (the peer is loopback, a trusted proxy, so the header counts)
    const soon = await setup({ setupCode: code }, { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(soon.statusCode, 429);
    assert.equal(((await fresh.inject({ url: '/api/meta' })).json() as Meta).setupRequired, true, 'no account yet');

    // typed from the box's screen: lower case, spaces instead of dashes
    const ok = await setup({ setupCode: ` ${code.toLowerCase().replace(/-/g, ' ')} ` }, { 'x-forwarded-for': '203.0.113.10' });
    assert.equal(ok.statusCode, 200, ok.body);
    const after = (await fresh.inject({ url: '/api/meta' })).json() as Meta;
    assert.equal(after.setupRequired, false);
    assert.equal(after.setupCodeRequired, undefined);
    assert.equal((await setup({ email: 'late@example.com', setupCode: code }, { 'x-forwarded-for': '203.0.113.11' })).statusCode, 403);
  } finally {
    await fresh.close();
  }

  const open = await createApp(cfgWith({ adminEmail: '', adminPassword: '' }), { logger: false });
  try {
    assert.equal(((await open.inject({ url: '/api/meta' })).json() as Meta).setupCodeRequired, undefined, 'not asked when unset');
    const res = await open.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'owner@example.com', name: 'Owner', password: PW },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await open.close();
  }
});

test('a cookie with a malformed percent-escape reads as absent, not as a 500', async () => {
  const bad = '%E0%A4%A';
  for (const cookie of [`mkdrive_session=${bad}`, `__Host-mkdrive_session=${bad}`, `CF_Authorization=${bad}`]) {
    const res = await app.inject({ url: '/api/me', headers: { cookie, 'x-forwarded-proto': 'https' } });
    assert.equal(res.statusCode, 401, cookie);
  }
  // behind Cloudflare Access too, where the CF_Authorization cookie is read as a token
  const access = await createApp(cfgWith({ accessTeam: 'example', accessAud: 'aud' }), { logger: false });
  try {
    const res = await access.inject({ url: '/api/me', headers: { cookie: `CF_Authorization=${bad}` } });
    assert.equal(res.statusCode, 401);
    const session = cookieOf(await login(access));
    const ok = await access.inject({ url: '/api/me', headers: { cookie: `${session}; CF_Authorization=${bad}` } });
    assert.equal(ok.statusCode, 200, 'a good session next to a malformed cookie still works');
  } finally {
    await access.close();
  }
});

test('a DRIVE_COOKIE_SECRET under 16 characters stops the start with a message naming it', async () => {
  await assert.rejects(createApp(cfgWith({ cookieSecret: 'short-secret' }), { logger: false }), /DRIVE_COOKIE_SECRET/);
  const ok = await createApp(cfgWith({ cookieSecret: 'x'.repeat(16) }), { logger: false });
  await ok.close();
});
