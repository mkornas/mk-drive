import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../src/demo.ts';

let base: string;
let app: FastifyInstance;
let cookie: string;
const json = { 'content-type': 'application/json' };

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-demo-lock-'));
  const cfg: Config = {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    dataDir: base,
    adminEmail: '',
    adminPassword: '',
    locations: [],
    accessAud: '',
    demo: true,
    demoSeed: '',
  };
  app = await createApp(cfg, { logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }), headers: json });
  assert.equal(login.statusCode, 200);
  cookie = (login.headers['set-cookie'] as string).split(';')[0];
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { ...json, cookie } });

test('the demo account is a member, and the demo refuses what would hit the next visitor', async () => {
  const me = await app.inject({ url: '/api/me', headers: { cookie } });
  assert.equal(me.json<{ role: string }>().role, 'member');
  assert.equal((await post('/api/account/password', { current: DEMO_PASSWORD, password: 'something-else-entirely' })).statusCode, 403);
  assert.equal(
    (await app.inject({ method: 'PATCH', url: '/api/account', payload: JSON.stringify({ name: 'Mallory' }), headers: { ...json, cookie } })).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'PUT', url: '/api/settings/name', payload: JSON.stringify({ name: 'Pwned' }), headers: { ...json, cookie } })).statusCode,
    403,
  );
  assert.equal((await post('/api/users', { email: 'x@example.com', name: 'X', role: 'member', password: 'long-enough-password' })).statusCode, 403);
  assert.equal((await post('/api/connectors', { name: 'Evil', type: 'webdav', url: 'http://169.254.169.254/' })).statusCode, 403);
  assert.equal((await post('/api/sessions/revoke-others', {})).statusCode, 403);
  const still = await app.inject({ method: 'POST', url: '/api/login', payload: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }), headers: json });
  assert.equal(still.statusCode, 200, 'the demo password is unchanged');
});

test('an encoded, doubled or trailing-slash path is locked the same', async () => {
  for (const url of [
    '/api/%61ccount/password',
    '/api/%41ccount/password',
    '/%61pi/account/password',
    '/api/account/p%61ssword',
    '/api/%73essions/revoke-others',
    '/api/sessions/revoke-%6Fthers',
  ]) {
    const res = await post(url, { current: DEMO_PASSWORD, password: 'something-else-entirely' });
    assert.ok(res.statusCode === 403 || res.statusCode === 404, `${url} → ${res.statusCode}`);
  }
  for (const url of ['/api/%61ccount/password', '/api/account/p%61ssword', '/%61pi/account/password', '/api/%73essions/revoke-others'])
    assert.equal((await post(url, { current: DEMO_PASSWORD, password: 'something-else-entirely' })).statusCode, 403, url);
  for (const url of ['/api//account/password', '/api/account/password/', '/api/account%2Fpassword', '/api/users/', '/api//users', '/api/users%2F'])
    assert.ok([403, 404].includes((await post(url, { email: 'x@example.com', name: 'X', role: 'member', password: 'long-enough-password' })).statusCode), url);
  const minted = await post('/api/app-passwords', { name: 'Another phone' });
  const id = minted.json<{ id: string }>().id;
  for (const url of [`/api/app-p%61sswords/${id}`, `/api/app-passwords/%3${String(id).slice(0, 1)}${String(id).slice(1)}`])
    assert.equal((await app.inject({ method: 'DELETE', url, headers: { cookie } })).statusCode, 403, url);
  const still = await app.inject({ method: 'POST', url: '/api/login', payload: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }), headers: json });
  assert.equal(still.statusCode, 200, 'the demo password is unchanged');
});

test('files, share links and the iOS sign-in flow still work', async () => {
  assert.equal((await post('/api/mkdir', { path: 'Demo', name: 'From a visitor' })).statusCode, 200);
  const minted = await post('/api/app-passwords', { name: 'A reviewer phone' });
  assert.equal(minted.statusCode, 201);
  const id = minted.json<{ id: string }>().id;
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/app-passwords/${id}`, headers: { cookie } })).statusCode,
    403,
    "but nobody revokes another visitor's phone",
  );
});
