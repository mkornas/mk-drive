import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { Listing, User, UserShare } from '../../shared/types.ts';

const PW = 'correct horse battery';
let base: string;
let app: FastifyInstance;
let admin = '';
let anna = '';
let bob = '';
let annaId = 0;

const json = (method: InjectOptions['method'], url: string, payload: unknown, cookie: string): InjectOptions => ({
  method,
  url,
  payload: JSON.stringify(payload),
  headers: { 'content-type': 'application/json', cookie },
});
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];
const login = async (email: string) => cookieOf(await app.inject(json('POST', '/api/login', { email, password: PW }, '')));

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-ushare-'));
  await mkdir(join(base, 'docs', 'family', 'photos'), { recursive: true });
  await mkdir(join(base, 'docs', 'private'), { recursive: true });
  await writeFile(join(base, 'docs', 'family', 'list.txt'), 'milk');
  await writeFile(join(base, 'docs', 'private', 'secret.txt'), 'shh');
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
  admin = await login('alex@example.com');
  const a = (await app.inject(json('POST', '/api/users', { email: 'anna@example.com', name: 'Anna', password: PW, grants: {} }, admin))).json() as User;
  annaId = a.id;
  await app.inject(json('POST', '/api/users', { email: 'bob@example.com', name: 'Bob', password: PW, grants: { Docs: 'read' } }, admin));
  anna = await login('anna@example.com');
  bob = await login('bob@example.com');
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('without a share Anna sees nothing', async () => {
  assert.deepEqual((await app.inject({ url: '/api/locations', headers: { cookie: anna } })).json(), []);
  assert.equal((await app.inject({ url: '/api/ls?path=Docs/family', headers: { cookie: anna } })).statusCode, 404);
  assert.deepEqual((await app.inject({ url: '/api/shared-with-me', headers: { cookie: anna } })).json(), []);
});

test('sharing rules: no whole locations, real accounts, not yourself, only what you have', async () => {
  assert.equal((await app.inject(json('POST', '/api/user-shares', { path: 'Docs', email: 'anna@example.com' }, admin))).statusCode, 400);
  assert.equal((await app.inject(json('POST', '/api/user-shares', { path: 'Docs/family', email: 'nobody@example.com' }, admin))).statusCode, 400);
  assert.equal((await app.inject(json('POST', '/api/user-shares', { path: 'Docs/family', email: 'alex@example.com' }, admin))).statusCode, 400);
  // Bob only reads Docs, so he cannot hand out write access
  assert.equal((await app.inject(json('POST', '/api/user-shares', { path: 'Docs/family', email: 'anna@example.com', level: 'write' }, bob))).statusCode, 403);
  // Anna has nothing in Docs, so she cannot share it at all
  assert.equal((await app.inject(json('POST', '/api/user-shares', { path: 'Docs/family', email: 'bob@example.com' }, anna))).statusCode, 404);
});

test('a read share opens exactly that subtree', async () => {
  const res = await app.inject(json('POST', '/api/user-shares', { path: 'Docs/family', email: 'Anna@example.com', level: 'read' }, admin));
  assert.equal(res.statusCode, 201);
  const s = res.json() as UserShare;
  assert.equal(s.level, 'read');
  assert.equal(s.user.id, annaId);
  assert.equal(s.owner.email, 'alex@example.com');

  const ls = await app.inject({ url: '/api/ls?path=Docs/family', headers: { cookie: anna } });
  assert.equal(ls.statusCode, 200);
  assert.equal((ls.json() as Listing).access, 'read');
  assert.equal((await app.inject({ url: '/api/ls?path=Docs/family/photos', headers: { cookie: anna } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/file?path=Docs/family/list.txt', headers: { cookie: anna } })).body, 'milk');
  assert.equal((await app.inject({ url: '/api/ls?path=Docs', headers: { cookie: anna } })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/ls?path=Docs/private', headers: { cookie: anna } })).statusCode, 404);
  assert.equal(
    (await app.inject({ url: '/api/ls?path=Docs/familyx', headers: { cookie: anna } })).statusCode,
    404,
    'a sibling with the same prefix is not inside',
  );
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Docs/family', name: 'new' }, anna))).statusCode, 403);
  // the location itself stays invisible; the share shows up under "shared with me"
  assert.deepEqual((await app.inject({ url: '/api/locations', headers: { cookie: anna } })).json(), []);
  const mine = (await app.inject({ url: '/api/shared-with-me', headers: { cookie: anna } })).json() as UserShare[];
  assert.deepEqual(
    mine.map((m) => `${m.path}:${m.level}:${m.owner.name}`),
    ['Docs/family:read:alex'],
  );
  // the owner sees it on the folder
  const on = (await app.inject({ url: '/api/user-shares?path=Docs/family', headers: { cookie: admin } })).json() as UserShare[];
  assert.deepEqual(
    on.map((x) => x.user.email),
    ['anna@example.com'],
  );
});

test('upgrading to write, and a public link made by the recipient', async () => {
  const res = await app.inject(json('POST', '/api/user-shares', { path: 'Docs/family', email: 'anna@example.com', level: 'write' }, admin));
  assert.equal(res.statusCode, 201);
  assert.equal((await app.inject({ url: '/api/user-shares?path=Docs/family', headers: { cookie: admin } })).json().length, 1, 'same person + path = one share');
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Docs/family', name: 'new' }, anna))).statusCode, 200);
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Docs/private', name: 'new' }, anna))).statusCode, 404);
  const link = await app.inject(json('POST', '/api/shares', { path: 'Docs/family/photos' }, anna));
  assert.equal(link.statusCode, 201);
  assert.equal((await app.inject({ url: `/api/s/${link.json().id}` })).statusCode, 200);
});

test('a single file can be shared: readable, previewable, its parent still invisible', async () => {
  const res = await app.inject(json('POST', '/api/user-shares', { path: 'Docs/private/secret.txt', email: 'anna@example.com' }, admin));
  assert.equal(res.statusCode, 201);
  assert.equal((await app.inject({ url: '/api/file?path=Docs/private/secret.txt', headers: { cookie: anna } })).body, 'shh');
  assert.equal((await app.inject({ url: '/api/ls?path=Docs/private', headers: { cookie: anna } })).statusCode, 404);
  const mine = (await app.inject({ url: '/api/shared-with-me', headers: { cookie: anna } })).json() as UserShare[];
  const file = mine.find((m) => m.path === 'Docs/private/secret.txt')!;
  assert.equal(file.kind, 'file');
  assert.equal(file.size, 3);
  assert.equal(file.mime, 'text/plain');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/user-shares/${file.id}`, headers: { cookie: admin } })).statusCode, 200);
});

test("the share dies with the owner's grant and with removal", async () => {
  const alex = (await app.inject({ url: '/api/users', headers: { cookie: admin } })).json() as User[];
  const bobRow = alex.find((u) => u.email === 'bob@example.com')!;
  // Bob shares (read) too, then loses his own grant: his share stops working, Alex's keeps going
  assert.equal((await app.inject(json('POST', '/api/user-shares', { path: 'Docs/family/photos', email: 'anna@example.com' }, bob))).statusCode, 201);
  await app.inject(json('PATCH', `/api/users/${bobRow.id}`, { grants: {} }, admin));
  const mine = (await app.inject({ url: '/api/shared-with-me', headers: { cookie: anna } })).json() as UserShare[];
  assert.deepEqual(
    mine.map((m) => m.path),
    ['Docs/family'],
  );
  assert.equal((await app.inject({ url: '/api/ls?path=Docs/family/photos', headers: { cookie: anna } })).statusCode, 200, "still inside the admin's share");

  const [share] = (await app.inject({ url: '/api/user-shares?path=Docs/family', headers: { cookie: admin } })).json() as UserShare[];
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/user-shares/${share.id}`, headers: { cookie: bob } })).statusCode, 404, "not Bob's to remove");
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/user-shares/${share.id}`, headers: { cookie: anna } })).statusCode,
    200,
    'the recipient may leave',
  );
  assert.equal((await app.inject({ url: '/api/ls?path=Docs/family', headers: { cookie: anna } })).statusCode, 404);
});
