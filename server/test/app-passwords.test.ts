import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { AppPassword, AppPasswordCreated, Identity } from '../../shared/types.ts';

const PW = 'correct horse battery';
let base: string;
let app: FastifyInstance;
let admin = '';
let made: AppPasswordCreated;

const json = (method: InjectOptions['method'], url: string, payload: unknown, headers: Record<string, string>): InjectOptions => ({
  method,
  url,
  payload: JSON.stringify(payload),
  headers: { 'content-type': 'application/json', ...headers },
});
const basic = (email: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${email}:${secret}`).toString('base64')}` });
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-token-'));
  await mkdir(join(base, 'docs'), { recursive: true });
  await writeFile(join(base, 'docs', 'a.txt'), 'A');
  const cfg: Config = {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: 'alex@example.com',
    adminPassword: PW,
    locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }],
    accessAud: '',
  };
  app = await createApp(cfg, { logger: false });
  const login = await app.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }, {}));
  admin = String(login.headers['set-cookie']).split(';')[0];
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('a session makes an app password; the secret is shown once', async () => {
  assert.equal((await app.inject(json('POST', '/api/app-passwords', { name: '' }, { cookie: admin }))).statusCode, 400);
  const res = await app.inject(json('POST', '/api/app-passwords', { name: 'Finder on the MacBook' }, { cookie: admin }));
  assert.equal(res.statusCode, 201);
  made = res.json() as AppPasswordCreated;
  assert.ok(made.secret.length >= 32);
  assert.equal(made.prefix, made.secret.slice(0, 6));
  const list = (await app.inject({ url: '/api/app-passwords', headers: { cookie: admin } })).json() as AppPassword[];
  assert.deepEqual(
    list.map((t) => [t.name, t.prefix, t.lastUsedAt]),
    [['Finder on the MacBook', made.prefix, null]],
  );
  assert.ok(!('secret' in list[0]));
});

test('Basic and Bearer open the API as the user; wrong ones do not', async () => {
  const viaBasic = await app.inject({ url: '/api/me', headers: basic('Alex@example.com', made.secret) });
  assert.equal(viaBasic.statusCode, 200);
  const id = viaBasic.json() as Identity;
  assert.equal(id.via, 'token');
  assert.equal(id.tokenId, made.id);
  assert.equal((await app.inject({ url: '/api/file?path=Docs/a.txt', headers: bearer(made.secret) })).body, 'A');
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Docs', name: 'from-curl' }, bearer(made.secret)))).statusCode, 200);

  // failures count against the address, so keep them off the one the rest of the file uses
  const wrongUser = await app.inject({ url: '/api/me', headers: basic('anna@example.com', made.secret), remoteAddress: '203.0.113.1' });
  assert.equal(wrongUser.statusCode, 401);
  assert.match(String(wrongUser.headers['www-authenticate']), /^Basic realm=/);
  assert.equal((await app.inject({ url: '/api/me', headers: bearer('nope'), remoteAddress: '203.0.113.1' })).statusCode, 401);
  const list = (await app.inject({ url: '/api/app-passwords', headers: { cookie: admin } })).json() as AppPassword[];
  assert.ok(list[0].lastUsedAt, 'use is remembered');
});

test('WebDAV takes an app password, never the browser session cookie', async () => {
  assert.equal((await app.inject({ url: '/dav/Docs/a.txt', headers: basic('alex@example.com', made.secret) })).statusCode, 200);
  for (const url of ['/dav/Docs/a.txt', '/d%61v/Docs/a.txt', '/dav']) {
    const res = await app.inject({ url, headers: { cookie: admin } });
    assert.equal(res.statusCode, 401, url);
    assert.match(String(res.headers['www-authenticate']), /^Basic realm=/);
  }
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: admin } })).statusCode, 200, 'the cookie still opens the API');
});

test('an app password cannot manage the account or mint more', async () => {
  for (const [method, url, body] of [
    ['GET', '/api/app-passwords', undefined],
    ['POST', '/api/app-passwords', { name: 'x' }],
    ['GET', '/api/sessions', undefined],
    ['POST', '/api/account/password', { current: PW, password: 'another long one' }],
    ['GET', '/api/users', undefined],
    ['POST', '/api/logout', {}],
  ] as const) {
    const res = await app.inject(body === undefined ? { method, url, headers: bearer(made.secret) } : json(method, url, body, bearer(made.secret)));
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }
});

test('revoked, and throttled after repeated bad secrets', async () => {
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/app-passwords/${made.id}`, headers: { cookie: admin } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/me', headers: bearer(made.secret) })).statusCode, 401);
  for (let i = 0; i < 3; i++) await app.inject({ url: '/api/me', headers: bearer('guess' + i), remoteAddress: '203.0.113.9' });
  const fresh = (await app.inject(json('POST', '/api/app-passwords', { name: 'again' }, { cookie: admin }))).json() as AppPasswordCreated;
  const blocked = await app.inject({ url: '/api/me', headers: bearer(fresh.secret), remoteAddress: '203.0.113.9' });
  assert.equal(blocked.statusCode, 401, 'even a good secret waits while that address is throttled');
  assert.match(blocked.json().message, /too many attempts/);
  assert.equal((await app.inject({ url: '/api/me', headers: bearer(fresh.secret), remoteAddress: '203.0.113.10' })).statusCode, 200);
});

test('a password change revokes the app passwords unless asked to keep them; an admin reset always does', async () => {
  const anna = (
    await app.inject(json('POST', '/api/users', { email: 'anna@example.com', name: 'Anna', password: PW, grants: { Docs: 'read' } }, { cookie: admin }))
  ).json();
  const signIn = async (password: string) =>
    String((await app.inject(json('POST', '/api/login', { email: 'anna@example.com', password }, {}))).headers['set-cookie']).split(';')[0];
  const mint = async (cookie: string) => (await app.inject(json('POST', '/api/app-passwords', { name: 'phone' }, { cookie }))).json() as AppPasswordCreated;
  // a refused secret throttles its address, so each check comes from its own
  let from = 20;
  const works = async (secret: string) =>
    (await app.inject({ url: '/api/me', headers: bearer(secret), remoteAddress: `198.51.100.${from++}` })).statusCode === 200;

  // own change, default: the apps go with the other sessions
  let cookie = await signIn(PW);
  let token = await mint(cookie);
  const changed = await app.inject(json('POST', '/api/account/password', { current: PW, password: 'second long password' }, { cookie }));
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json(), { ok: true, appPasswordsRevoked: 1 });
  assert.equal(await works(token.secret), false, 'the app password is gone');

  // own change, keeping them
  token = await mint(cookie);
  const kept = await app.inject(
    json('POST', '/api/account/password', { current: 'second long password', password: 'third long password', revokeAppPasswords: false }, { cookie }),
  );
  assert.deepEqual(kept.json(), { ok: true, appPasswordsRevoked: 0 });
  assert.equal(await works(token.secret), true, 'kept on request');

  // an admin reset: whoever held the account loses its apps too
  const reset = await app.inject(json('PATCH', `/api/users/${anna.id}`, { password: 'reset by the admin' }, { cookie: admin }));
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(await works(token.secret), false, 'revoked by the reset');
  cookie = await signIn('reset by the admin');
  assert.deepEqual((await app.inject({ url: '/api/app-passwords', headers: { cookie } })).json(), []);
});
