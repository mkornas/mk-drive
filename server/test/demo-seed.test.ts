import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../src/demo.ts';

let base: string;
let app: FastifyInstance | null = null;

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-demo-seed-'));
  await mkdir(join(base, 'seed', 'Photos', 'Trip'), { recursive: true });
  await writeFile(join(base, 'seed', 'Photos', 'Trip', 'pier.txt'), 'not really a photo');
  const old = new Date('2025-06-12T10:00:00Z');
  await utimes(join(base, 'seed', 'Photos', 'Trip', 'pier.txt'), old, old);
});
after(async () => {
  await app?.close();
  await rm(base, { recursive: true, force: true });
});

async function demoApp(demoSeed: string): Promise<FastifyInstance> {
  const cfg: Config = { ...config, staticDir: '', dbFile: ':memory:', dataDir: join(base, 'data'), adminEmail: '', adminPassword: '', locations: [], accessAud: '', demo: true, demoSeed };
  return createApp(cfg, { logger: false });
}

test('the seed directory is copied into the demo location, timestamps kept, next to the generated files', async () => {
  app = await demoApp(join(base, 'seed'));
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }), headers: { 'content-type': 'application/json' } });
  assert.equal(login.statusCode, 200);
  const cookie = (login.headers['set-cookie'] as string).split(';')[0];
  const ls = await app.inject({ url: '/api/ls?path=Demo/Photos/Trip', headers: { cookie } });
  assert.equal(ls.statusCode, 200);
  const names = ls.json<{ entries: { name: string; mtime: number }[] }>().entries.map((e) => e.name);
  assert.deepEqual(names, ['pier.txt']);
  const copied = await stat(join(base, 'data', 'demo', 'Photos', 'Trip', 'pier.txt'));
  assert.equal(Math.floor(copied.mtimeMs / 1000), Math.floor(new Date('2025-06-12T10:00:00Z').getTime() / 1000));
  const generated = await app.inject({ url: '/api/ls?path=Demo/Photos', headers: { cookie } });
  assert.ok(generated.json<{ entries: { name: string }[] }>().entries.some((e) => e.name === 'harbour.jpg'), 'the generated photos are still there');
});

test('a seed path that is not a directory refuses to start', async () => {
  await assert.rejects(demoApp(join(base, 'nope')), /DRIVE_DEMO_SEED is not a directory/);
});
