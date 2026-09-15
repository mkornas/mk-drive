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
import type { Meta } from '../../shared/types.ts';

/** A tiny OpenID provider that signs anyone in as the email given in `who`. */
async function provider(who: { email: string; name: string }) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const idp = Fastify();
  idp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
  let issuer = '';
  idp.get('/.well-known/openid-configuration', async () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/end-session`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] }));
  idp.get<{ Querystring: Record<string, string> }>('/authorize', async (req, reply) => {
    const code = `c${codes.size + 1}`;
    codes.set(code, { challenge: req.query.code_challenge, nonce: req.query.nonce });
    return reply.redirect(`${req.query.redirect_uri}?code=${code}&state=${encodeURIComponent(req.query.state)}`);
  });
  idp.post<{ Body: Record<string, string> }>('/token', async (req, reply) => {
    const c = codes.get(req.body.code);
    if (!c || createHash('sha256').update(req.body.code_verifier).digest('base64url') !== c.challenge) return reply.code(400).send({ error: 'invalid_grant' });
    codes.delete(req.body.code);
    const id_token = await new SignJWT({ nonce: c.nonce, email: who.email, email_verified: true, name: who.name }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience('mk-drive').setSubject('u1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
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
const who = { email: 'Alex@Example.com', name: 'Alex' };

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-sso-'));
  await mkdir(join(base, 'docs'), { recursive: true });
  const p = await provider(who);
  idp = p.idp;
  const cfg: Config = { ...config, staticDir: '', dbFile: ':memory:', adminEmail: 'alex@example.com', adminPassword: 'correct horse battery', locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }], accessAud: '', oidcIssuer: p.issuer, oidcClientId: 'mk-drive', oidcClientSecret: 's', oidcName: 'Example ID' };
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
  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: session, host: 'drive.test', 'content-type': 'application/json' }, payload: {} });
  const end = new URL(out.json().redirect as string);
  assert.equal(end.pathname, '/end-session');
  assert.equal(end.searchParams.get('post_logout_redirect_uri'), 'http://drive.test/login');
  assert.match(end.searchParams.get('id_token_hint') ?? '', /^eyJ/, 'the ID token goes back to the provider');
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: session } })).statusCode, 401);
});

test('a password session signs out locally only', async () => {
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { 'content-type': 'application/json' }, payload: { email: 'alex@example.com', password: 'correct horse battery' } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie, 'content-type': 'application/json' }, payload: {} });
  assert.deepEqual(out.json(), { ok: true });
});

test('an unreachable provider at start is retried on login and explained on the login page', async () => {
  const cfg: Config = { ...config, staticDir: '', dbFile: ':memory:', adminEmail: 'alex@example.com', adminPassword: 'correct horse battery', locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }], accessAud: '', oidcIssuer: 'http://127.0.0.1:1', oidcClientId: 'mk-drive', oidcClientSecret: 's', oidcName: 'Example ID' };
  const down = await createApp(cfg, { logger: false });
  try {
    assert.deepEqual(((await down.inject({ url: '/api/meta' })).json() as Meta).sso, { name: 'Example ID' }, 'the button stays: the provider may be back by the time it is clicked');
    const login = await down.inject({ url: '/auth/login', headers: { host: 'drive.test' } });
    assert.equal(login.statusCode, 303);
    assert.match(decodeURIComponent(String(login.headers.location)), /^\/login\?reason=sign-in with Example ID is unavailable: http:\/\/127\.0\.0\.1:1 could not be reached/);
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
