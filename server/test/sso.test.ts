import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createHash } from 'node:crypto';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { safeReturnPath } from '../src/sso.ts';
import type { Meta } from '../../shared/types.ts';

/** A tiny OpenID provider that signs anyone in as the email given in `who`. */
async function provider(who: { email: string; name: string; verified?: boolean }) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const idp = Fastify();
  idp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  let issuer = '';
  idp.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    end_session_endpoint: `${issuer}/end-session`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  }));
  idp.get<{ Querystring: Record<string, string> }>('/authorize', async (req, reply) => {
    const code = `c${codes.size + 1}`;
    codes.set(code, { challenge: req.query.code_challenge, nonce: req.query.nonce });
    return reply.redirect(`${req.query.redirect_uri}?code=${code}&state=${encodeURIComponent(req.query.state)}`);
  });
  idp.post<{ Body: Record<string, string> }>('/token', async (req, reply) => {
    const c = codes.get(req.body.code);
    if (!c || createHash('sha256').update(req.body.code_verifier).digest('base64url') !== c.challenge) return reply.code(400).send({ error: 'invalid_grant' });
    codes.delete(req.body.code);
    const id_token = await new SignJWT({ nonce: c.nonce, email: who.email, email_verified: who.verified ?? true, name: who.name })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('mk-drive')
      .setSubject('u1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return { access_token: 'at', token_type: 'Bearer', id_token, expires_in: 300 };
  });
  idp.get('/jwks', async () => ({ keys: [jwk] }));
  await idp.listen({ port: 0, host: '127.0.0.1' });
  issuer = `http://127.0.0.1:${(idp.server.address() as { port: number }).port}`;
  return { idp, issuer, who };
}

let base: string;
let idp: FastifyInstance;
let app: FastifyInstance;
const who: { email: string; name: string; verified?: boolean } = { email: 'Alex@Example.com', name: 'Alex' };

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-sso-'));
  await mkdir(join(base, 'docs'), { recursive: true });
  const p = await provider(who);
  idp = p.idp;
  const cfg: Config = {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: 'alex@example.com',
    adminPassword: 'correct horse battery',
    locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }],
    accessAud: '',
    oidcIssuer: p.issuer,
    oidcClientId: 'mk-drive',
    oidcClientSecret: 's',
    oidcName: 'Example ID',
  };
  app = await createApp(cfg, { logger: false });
});
after(async () => {
  await app.close();
  await idp.close();
  await rm(base, { recursive: true, force: true });
});

test('meta advertises SSO; login round-trips through the provider into a normal session', async () => {
  const meta = (await app.inject({ url: '/api/meta' })).json() as Meta;
  assert.deepEqual(meta.sso, { name: 'Example ID' });

  const login = await app.inject({ url: '/auth/login?next=/d/Docs', headers: { host: 'drive.test' } });
  assert.equal(login.statusCode, 302);
  const to = new URL(login.headers.location as string);
  assert.equal(to.searchParams.get('redirect_uri'), 'http://drive.test/auth/callback');
  const transient = String(login.headers['set-cookie']).split(';')[0];

  const back = new URL((await fetch(to, { redirect: 'manual' })).headers.get('location')!);
  const cb = await app.inject({ url: back.pathname + back.search, headers: { host: 'drive.test', cookie: transient } });
  assert.equal(cb.statusCode, 303);
  assert.equal(cb.headers.location, '/d/Docs');
  const cookies = ([] as string[]).concat(cb.headers['set-cookie'] as string | string[]);
  const session = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('mkdrive_session='));
  assert.ok(session, 'a session cookie is set');
  const me = (await app.inject({ url: '/api/me', headers: { cookie: session } })).json();
  assert.equal(me.email, 'alex@example.com');
  assert.equal(me.via, 'session');
  const audit = (await app.inject({ url: '/api/audit', headers: { cookie: session } })).json() as { action: string; detail: string }[];
  assert.ok(audit.some((a) => a.action === 'login' && a.detail.startsWith('sso')));

  // signing out ends the provider's session too, and sends the browser back to the login page
  const out = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: session, host: 'drive.test', 'content-type': 'application/json' },
    payload: {},
  });
  const end = new URL(out.json().redirect as string);
  assert.equal(end.pathname, '/end-session');
  assert.equal(end.searchParams.get('post_logout_redirect_uri'), 'http://drive.test/login');
  assert.match(end.searchParams.get('id_token_hint') ?? '', /^eyJ/, 'the ID token goes back to the provider');
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: session } })).statusCode, 401);
});

test('a password session signs out locally only', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'alex@example.com', password: 'correct horse battery' },
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie, 'content-type': 'application/json' }, payload: {} });
  assert.deepEqual(out.json(), { ok: true });
});

test('an unreachable provider at start is retried on login and explained on the login page', async () => {
  const cfg: Config = {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: 'alex@example.com',
    adminPassword: 'correct horse battery',
    locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }],
    accessAud: '',
    oidcIssuer: 'http://127.0.0.1:1',
    oidcClientId: 'mk-drive',
    oidcClientSecret: 's',
    oidcName: 'Example ID',
  };
  const down = await createApp(cfg, { logger: false });
  try {
    assert.deepEqual(
      ((await down.inject({ url: '/api/meta' })).json() as Meta).sso,
      { name: 'Example ID' },
      'the button stays: the provider may be back by the time it is clicked',
    );
    const login = await down.inject({ url: '/auth/login', headers: { host: 'drive.test' } });
    assert.equal(login.statusCode, 303);
    assert.match(
      decodeURIComponent(String(login.headers.location)),
      /^\/login\?reason=sign-in with Example ID is unavailable: http:\/\/127\.0\.0\.1:1 could not be reached/,
    );
  } finally {
    await down.close();
  }
});

test('an identity without a local account is sent back to the login page with a reason', async () => {
  who.email = 'stranger@example.com';
  const login = await app.inject({ url: '/auth/login', headers: { host: 'drive.test' } });
  const transient = String(login.headers['set-cookie']).split(';')[0];
  const back = new URL((await fetch(login.headers.location as string, { redirect: 'manual' })).headers.get('location')!);
  const cb = await app.inject({ url: back.pathname + back.search, headers: { host: 'drive.test', cookie: transient } });
  assert.equal(cb.statusCode, 303);
  assert.match(String(cb.headers.location), /^\/login\?reason=no%20account%20for%20stranger/);
  assert.ok(!String(cb.headers['set-cookie'] ?? '').includes('mkdrive_session='), 'no session for a stranger');
});

test('an unverified email, or one with non-ASCII characters, is refused even when an account matches', async () => {
  const signIn = async () => {
    const login = await app.inject({ url: '/auth/login', headers: { host: 'drive.test' } });
    const transient = String(login.headers['set-cookie']).split(';')[0];
    const back = new URL((await fetch(login.headers.location as string, { redirect: 'manual' })).headers.get('location')!);
    return app.inject({ url: back.pathname + back.search, headers: { host: 'drive.test', cookie: transient } });
  };
  const admin = String(
    (
      await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'alex@example.com', password: 'correct horse battery' },
      })
    ).headers['set-cookie'],
  ).split(';')[0];
  const zoe = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { 'content-type': 'application/json', cookie: admin },
    payload: { email: 'zoë@example.com', name: 'Zoë', role: 'member', password: 'another long password' },
  });
  assert.equal(zoe.statusCode, 201, zoe.body);
  try {
    who.email = 'alex@example.com';
    who.verified = false;
    let cb = await signIn();
    assert.equal(cb.statusCode, 303);
    assert.match(decodeURIComponent(String(cb.headers.location)), /^\/login\?reason=.*not verified/);
    assert.ok(!String(cb.headers['set-cookie'] ?? '').includes('mkdrive_session='), 'no session for an unverified email');

    who.email = 'zoë@example.com';
    who.verified = true;
    cb = await signIn();
    assert.match(decodeURIComponent(String(cb.headers.location)), /^\/login\?reason=.*non-ASCII/);
    assert.ok(!String(cb.headers['set-cookie'] ?? '').includes('mkdrive_session='));
    const audit = (await app.inject({ url: '/api/audit', headers: { cookie: admin } })).json() as { action: string; detail: string }[];
    for (const why of [/not verified/, /non-ASCII/])
      assert.ok(
        audit.some((a) => a.action === 'login.failed' && why.test(a.detail)),
        String(why),
      );
  } finally {
    who.email = 'Alex@Example.com';
    delete who.verified;
  }
});

test('`next` never leaves the drive: a tab, a backslash, // or another origin lands on the home page', async () => {
  const landing = async (next: string) => {
    const login = await app.inject({ url: `/auth/login?next=${encodeURIComponent(next)}`, headers: { host: 'drive.test' } });
    assert.equal(login.statusCode, 302, next);
    const transient = String(login.headers['set-cookie']).split(';')[0];
    // the drive's own guard, before the library: what the login cookie remembers is already the home page
    const parked = JSON.parse(Buffer.from(decodeURIComponent(transient.split('=')[1]).split('.')[0], 'base64url').toString()).next;
    const back = new URL((await fetch(login.headers.location as string, { redirect: 'manual' })).headers.get('location')!);
    const cb = await app.inject({ url: back.pathname + back.search, headers: { host: 'drive.test', cookie: transient } });
    assert.equal(cb.statusCode, 303, next);
    assert.equal(parked, cb.headers.location, next);
    return cb.headers.location;
  };
  // browsers drop the tab and read `/\t/evil.example` as //evil.example
  for (const bad of ['/\t/evil.example', '/\n/evil.example', '//evil.example', '/\\evil.example', 'https://evil.example', '/ /evil.example'])
    assert.equal(await landing(bad), '/', JSON.stringify(bad));
  assert.equal(await landing('/d/Docs'), '/d/Docs');
  assert.equal(await landing('/'), '/');
});

test('safeReturnPath', () => {
  for (const bad of ['/\t/evil.example', '//evil.example', '/\\evil.example', 'https://evil.example', 'd/Docs', '', '/a\x7f', undefined, ['/d/Docs']])
    assert.equal(safeReturnPath(bad), null, JSON.stringify(bad));
  for (const good of ['/', '/d/Docs', '/d/Docs/a%20b?x=1#y']) assert.equal(safeReturnPath(good), good);
});

test('Settings → Sign-in: an admin sets the provider, checked first, secret never shown, live without a restart; off again; env and a password-less drive refuse', async () => {
  who.email = 'Alex@Example.com';
  const p = await provider(who);
  const cfg: Config = {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: 'alex@example.com',
    adminPassword: 'correct horse battery',
    locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }],
    accessAud: '',
    oidcIssuer: '',
    oidcClientId: '',
    oidcClientSecret: '',
    oidcName: 'Single sign-on',
  };
  const plain = await createApp(cfg, { logger: false });
  const json = { 'content-type': 'application/json', host: 'drive.test' };
  try {
    const login = await plain.inject({
      method: 'POST',
      url: '/api/login',
      headers: json,
      payload: { email: 'alex@example.com', password: 'correct horse battery' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const as = { ...json, cookie };
    assert.equal(((await plain.inject({ url: '/api/meta' })).json() as Meta).sso, undefined, 'nothing ships configured');
    let s = (await plain.inject({ url: '/api/settings/sso', headers: as })).json();
    assert.deepEqual([s.source, s.redirectUri, s.logoutRedirectUri, s.hasSecret], [null, 'http://drive.test/auth/callback', 'http://drive.test/login', false]);
    const notSet = await plain.inject({ url: '/auth/login', headers: { host: 'drive.test' } });
    assert.match(decodeURIComponent(String(notSet.headers.location)), /not set up/);

    const down = await plain.inject({
      method: 'PUT',
      url: '/api/settings/sso',
      headers: as,
      payload: { name: 'Home ID', issuer: 'http://127.0.0.1:1', clientId: 'mk-drive', clientSecret: 's' },
    });
    assert.equal(down.statusCode, 400, 'an issuer that does not answer is not saved');
    assert.match(down.json().message, /could not be read/);
    assert.equal(
      (await plain.inject({ method: 'PUT', url: '/api/settings/sso', headers: as, payload: { issuer: 'ftp://x', clientId: 'a', clientSecret: 'b' } }))
        .statusCode,
      400,
    );
    assert.equal(
      (await plain.inject({ method: 'PUT', url: '/api/settings/sso', headers: as, payload: { issuer: p.issuer, clientId: 'mk-drive' } })).statusCode,
      400,
      'no secret saved yet',
    );

    const put = await plain.inject({
      method: 'PUT',
      url: '/api/settings/sso',
      headers: as,
      payload: { name: 'Home ID', issuer: `${p.issuer}/`, clientId: 'mk-drive', clientSecret: 's' },
    });
    assert.equal(put.statusCode, 200, put.body);
    s = put.json();
    assert.deepEqual([s.source, s.name, s.issuer, s.clientId, s.hasSecret, s.ready], ['settings', 'Home ID', p.issuer, 'mk-drive', true, true]);
    assert.ok(!put.body.includes('"s"') && !('clientSecret' in s), 'the secret never comes back');
    assert.deepEqual(((await plain.inject({ url: '/api/meta' })).json() as Meta).sso, { name: 'Home ID' });

    // a round trip with the saved provider, no restart
    const go = await plain.inject({ url: '/auth/login?next=/d/Docs', headers: { host: 'drive.test' } });
    assert.equal(go.statusCode, 302);
    const back = new URL((await fetch(go.headers.location as string, { redirect: 'manual' })).headers.get('location')!);
    const cb = await plain.inject({
      url: back.pathname + back.search,
      headers: { host: 'drive.test', cookie: String(go.headers['set-cookie']).split(';')[0] },
    });
    assert.equal(cb.headers.location, '/d/Docs');

    // renaming keeps the secret when none is sent
    s = (
      await plain.inject({
        method: 'PUT',
        url: '/api/settings/sso',
        headers: as,
        payload: { name: 'Our ID', issuer: p.issuer, clientId: 'mk-drive', clientSecret: '' },
      })
    ).json();
    assert.deepEqual([s.name, s.hasSecret], ['Our ID', true]);

    const member = await plain.inject({
      method: 'POST',
      url: '/api/users',
      headers: as,
      payload: { email: 'm@example.com', name: 'M', role: 'member', password: 'another long password' },
    });
    assert.equal(member.statusCode, 201, member.body);
    const mc = String(
      (await plain.inject({ method: 'POST', url: '/api/login', headers: json, payload: { email: 'm@example.com', password: 'another long password' } }))
        .headers['set-cookie'],
    ).split(';')[0];
    assert.equal((await plain.inject({ url: '/api/settings/sso', headers: { ...json, cookie: mc } })).statusCode, 403);
    assert.equal((await plain.inject({ method: 'DELETE', url: '/api/settings/sso', headers: { host: 'drive.test', cookie: mc } })).statusCode, 403);

    const off = await plain.inject({ method: 'DELETE', url: '/api/settings/sso', headers: { host: 'drive.test', cookie } });
    assert.equal(off.statusCode, 200, off.body);
    assert.deepEqual([off.json().source, off.json().hasSecret], [null, false]);
    assert.equal(((await plain.inject({ url: '/api/meta' })).json() as Meta).sso, undefined);
    const audit = (await plain.inject({ url: '/api/audit', headers: as })).json() as { action: string; detail: string }[];
    assert.ok(audit.filter((a) => a.action === 'settings.sso').length >= 3);
    assert.ok(!JSON.stringify(audit).includes('"clientSecret"'), 'the audit names no secret');

    // the environment stays in charge
    const envSession = String(
      (await app.inject({ method: 'POST', url: '/api/login', headers: json, payload: { email: 'alex@example.com', password: 'correct horse battery' } }))
        .headers['set-cookie'],
    ).split(';')[0];
    const envView = (await app.inject({ url: '/api/settings/sso', headers: { ...json, cookie: envSession } })).json();
    assert.deepEqual([envView.source, envView.name, envView.hasSecret], ['env', 'Example ID', true]);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings/sso',
          headers: { ...json, cookie: envSession },
          payload: { issuer: p.issuer, clientId: 'x', clientSecret: 'y' },
        })
      ).statusCode,
      409,
    );
  } finally {
    await plain.close();
    await p.idp.close();
  }

  // password sign-in off: single sign-on is the only way in, so it cannot be turned off from the page
  const p2 = await provider(who);
  const dbFile = join(base, 'locked.db');
  const common = {
    ...config,
    staticDir: '',
    dbFile,
    adminEmail: 'alex@example.com',
    adminPassword: 'correct horse battery',
    locations: [],
    accessAud: '',
    oidcIssuer: '',
    oidcClientId: '',
    oidcClientSecret: '',
  };
  const setup = await createApp(common, { logger: false });
  const sc = String(
    (await setup.inject({ method: 'POST', url: '/api/login', headers: json, payload: { email: 'alex@example.com', password: 'correct horse battery' } }))
      .headers['set-cookie'],
  ).split(';')[0];
  assert.equal(
    (
      await setup.inject({
        method: 'PUT',
        url: '/api/settings/sso',
        headers: { ...json, cookie: sc },
        payload: { issuer: p2.issuer, clientId: 'mk-drive', clientSecret: 's' },
      })
    ).statusCode,
    200,
  );
  await setup.close();
  const locked = await createApp({ ...common, passwordLogin: 'off' }, { logger: false });
  try {
    const go = await locked.inject({ url: '/auth/login', headers: { host: 'drive.test' } });
    const back = new URL((await fetch(go.headers.location as string, { redirect: 'manual' })).headers.get('location')!);
    const cb = await locked.inject({
      url: back.pathname + back.search,
      headers: { host: 'drive.test', cookie: String(go.headers['set-cookie']).split(';')[0] },
    });
    const session = ([] as string[])
      .concat(cb.headers['set-cookie'] as string[])
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('mkdrive_session='))!;
    assert.equal((await locked.inject({ url: '/api/settings/sso', headers: { host: 'drive.test', cookie: session } })).json().passwordLoginOff, true);
    const off = await locked.inject({ method: 'DELETE', url: '/api/settings/sso', headers: { host: 'drive.test', cookie: session } });
    assert.equal(off.statusCode, 400);
    assert.match(off.json().message, /only way in/);
  } finally {
    await locked.close();
    await p2.idp.close();
  }
});
