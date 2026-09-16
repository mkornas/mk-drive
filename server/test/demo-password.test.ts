import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../src/demo.ts';
import type { Meta } from '../../shared/types.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
after(async () => {
  for (const a of apps) await a.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function demoApp(demoPassword: string): Promise<{ app: FastifyInstance; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'mk-drive-demo-pw-'));
  dirs.push(base);
  const dataDir = join(base, 'data');
  const cfg: Config = { ...config, staticDir: '', dbFile: ':memory:', dataDir, adminEmail: '', adminPassword: '', locations: [], accessAud: '', demo: true, demoSeed: '', demoPassword };
  const app = await createApp(cfg, { logger: false });
  apps.push(app);
  return { app, dataDir };
}

const login = (app: FastifyInstance, password: string) =>
  app.inject({ method: 'POST', url: '/api/login', payload: JSON.stringify({ email: DEMO_EMAIL, password }), headers: { 'content-type': 'application/json' } });

test('no DRIVE_DEMO_PASSWORD: the demo account is the well-known one and the pages may print it', async () => {
  const { app, dataDir } = await demoApp('');
  const meta = (await app.inject({ url: '/api/meta' })).json<Meta>();
  assert.equal(meta.demo, true);
  assert.deepEqual(meta.demoAccount, { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  assert.equal((await login(app, DEMO_PASSWORD)).statusCode, 200);
  assert.match(await readFile(join(dataDir, 'demo', 'README.md'), 'utf8'), new RegExp(DEMO_PASSWORD));
});

test("DRIVE_DEMO_PASSWORD: only whoever was told it gets in, and nothing shows it", async () => {
  const mine = 'told-to-the-app-review-only';
  const { app, dataDir } = await demoApp(mine);
  const meta = (await app.inject({ url: '/api/meta' })).json<Meta>();
  assert.equal(meta.demo, true);
  assert.equal(meta.demoAccount, undefined, 'the sign-in page has no account to print');
  assert.equal(JSON.stringify(meta).includes(mine), false, 'meta never carries the password');
  assert.equal((await login(app, mine)).statusCode, 200);
  // after a wrong one the throttle makes the caller wait, so this comes last: 401 or 429, never a session
  assert.notEqual((await login(app, DEMO_PASSWORD)).statusCode, 200, 'the well-known password is not the demo account');
  const readme = await readFile(join(dataDir, 'demo', 'README.md'), 'utf8');
  assert.equal(readme.includes(mine), false);
  assert.equal(readme.includes(DEMO_PASSWORD), false);
  assert.match(readme, /the password you were given/);
});
