import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { Meta } from '../../shared/types.ts';

const PW = 'correct horse battery';
let base: string;
const apps: FastifyInstance[] = [];

async function appWith(passwordLogin: Config['passwordLogin']): Promise<FastifyInstance> {
  const cfg: Config = {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
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

test('lan: private addresses may use the password, the internet (and anything via Cloudflare) may not', async () => {
  const app = await appWith('lan');
  assert.equal((await meta(app, '192.168.1.7')).passwordLogin, true);
  assert.equal((await login(app, '192.168.1.7')).statusCode, 200);
  assert.equal((await login(app, '::ffff:10.0.0.9')).statusCode, 200);
  assert.equal((await meta(app, '203.0.113.5')).passwordLogin, false);
  assert.equal((await login(app, '203.0.113.5')).statusCode, 403);
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
  assert.equal((await login(app, '127.0.0.1')).statusCode, 403);
});
