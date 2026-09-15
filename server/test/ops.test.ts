import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { nextName } from '../src/ops.ts';
import type { Listing, OpResult, TrashEntry, UploadStatus } from '../../shared/types.ts';

let base: string;
let app: FastifyInstance;
let admin = '';
const PW = 'correct horse battery';

function cfgWith(): Config {
  return {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: 'alex@example.com',
    adminPassword: PW,
    locations: [
      { name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] },
      { name: 'Other', path: join(base, 'other'), mode: 'rw', hide: [] },
      { name: 'Media', path: join(base, 'media'), mode: 'ro', hide: [] },
    ],
    accessAud: '',
  };
}

const json = (method: InjectOptions['method'], url: string, payload: unknown): InjectOptions => ({ method, url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', cookie: admin } });
const names = async (path: string) => ((await app.inject({ url: `/api/ls?path=${encodeURIComponent(path)}`, headers: { cookie: admin } })).json() as Listing).entries.map((e) => e.name);

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-ops-'));
  await mkdir(join(base, 'docs', 'a', 'deep'), { recursive: true });
  await mkdir(join(base, 'other'), { recursive: true });
  await mkdir(join(base, 'media'), { recursive: true });
  await writeFile(join(base, 'docs', 'a', 'deep', 'x.txt'), 'xx');
  await writeFile(join(base, 'docs', 'note.md'), 'note');
  await writeFile(join(base, 'media', 'm.jpg'), 'jpg');
  app = await createApp(cfgWith(), { logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: JSON.stringify({ email: 'alex@example.com', password: PW }), headers: { 'content-type': 'application/json' } });
  admin = String(login.headers['set-cookie']).split(';')[0];
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('nextName', async () => {
  const taken = new Set(['a.txt', 'a (2).txt', 'b']);
  assert.equal(await nextName('a.txt', async (n) => taken.has(n)), 'a (3).txt');
  assert.equal(await nextName('b', async (n) => taken.has(n)), 'b (2)');
  assert.equal(await nextName('a (2).txt', async (n) => taken.has(n)), 'a (3).txt');
});

test('mkdir + conflict policies, rename, reserved names, read-only', async () => {
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Docs', name: 'new' }))).statusCode, 200);
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Docs', name: 'new' }))).statusCode, 409);
  const renamed = await app.inject(json('POST', '/api/mkdir', { path: 'Docs', name: 'new', onConflict: 'rename' }));
  assert.equal(renamed.json().path, 'Docs/new (2)');
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Docs', name: '.mk-drive' }))).statusCode, 400);
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Docs', name: 'a/b' }))).statusCode, 400);
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Media', name: 'x' }))).statusCode, 403, 'read-only location');

  const r = await app.inject(json('POST', '/api/rename', { path: 'Docs/new (2)', name: 'renamed' }));
  assert.equal(r.json().path, 'Docs/renamed');
  assert.equal((await app.inject(json('POST', '/api/rename', { path: 'Docs/renamed', name: 'new' }))).statusCode, 409);
  assert.deepEqual(await names('Docs'), ['a', 'new', 'renamed', 'note.md']);
});

test('move within a location, copy, move across locations (copy + remove)', async () => {
  const moved = (await app.inject(json('POST', '/api/move', { paths: ['Docs/note.md'], to: 'Docs/renamed' }))).json() as OpResult[];
  assert.deepEqual(moved, [{ from: 'Docs/note.md', to: 'Docs/renamed/note.md', ok: true }]);
  const copied = (await app.inject(json('POST', '/api/copy', { paths: ['Docs/a'], to: 'Docs/renamed' }))).json() as OpResult[];
  assert.equal(copied[0].to, 'Docs/renamed/a');
  assert.equal(await readFile(join(base, 'docs', 'renamed', 'a', 'deep', 'x.txt'), 'utf8'), 'xx');
  const again = (await app.inject(json('POST', '/api/copy', { paths: ['Docs/a'], to: 'Docs/renamed' }))).json() as OpResult[];
  assert.equal(again[0].code, 'exists');
  const self = (await app.inject(json('POST', '/api/move', { paths: ['Docs/a'], to: 'Docs/a/deep' }))).json() as OpResult[];
  assert.equal(self[0].ok, false, 'cannot move a folder into itself');

  const across = (await app.inject(json('POST', '/api/move', { paths: ['Docs/renamed'], to: 'Other' }))).json() as OpResult[];
  assert.deepEqual(across, [{ from: 'Docs/renamed', to: 'Other/renamed', ok: true }]);
  assert.equal(await readFile(join(base, 'other', 'renamed', 'a', 'deep', 'x.txt'), 'utf8'), 'xx');
  assert.deepEqual(await names('Docs'), ['a', 'new']);
  const ro = (await app.inject(json('POST', '/api/move', { paths: ['Media/m.jpg'], to: 'Docs' }))).json() as OpResult[];
  assert.equal(ro[0].code, 'forbidden');
  const cp = (await app.inject(json('POST', '/api/copy', { paths: ['Media/m.jpg'], to: 'Docs' }))).json() as OpResult[];
  assert.equal(cp[0].to, 'Docs/m.jpg', 'copying out of a read-only location is fine');
});

test('delete → trash → restore / purge', async () => {
  const del = (await app.inject(json('POST', '/api/delete', { paths: ['Docs/a', 'Docs/m.jpg'] }))).json() as OpResult[];
  assert.ok(del.every((r) => r.ok));
  assert.deepEqual(await names('Docs'), ['new']);
  const list = (await app.inject({ url: '/api/trash?location=Docs', headers: { cookie: admin } })).json() as TrashEntry[];
  assert.equal(list.length, 2);
  const folder = list.find((t) => t.name === 'a')!;
  assert.equal(folder.kind, 'dir');
  assert.equal(folder.original, 'Docs/a');

  await writeFile(join(base, 'docs', 'a'), 'a file in the way');
  const blocked = await app.inject(json('POST', `/api/trash/${folder.id}/restore`, {}));
  assert.equal(blocked.statusCode, 409);
  const restored = await app.inject(json('POST', `/api/trash/${folder.id}/restore`, { onConflict: 'rename' }));
  assert.equal(restored.json().path, 'Docs/a (2)');
  assert.equal(await readFile(join(base, 'docs', 'a (2)', 'deep', 'x.txt'), 'utf8'), 'xx');

  const file = list.find((t) => t.name === 'm.jpg')!;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/trash/${file.id}`, headers: { cookie: admin } })).statusCode, 200);
  assert.equal(((await app.inject({ url: '/api/trash?location=Docs', headers: { cookie: admin } })).json() as TrashEntry[]).length, 0);
  assert.deepEqual(await readdir(join(base, 'docs', '.mk-drive', 'trash')), []);
  assert.ok(!(await names('Docs')).includes('.mk-drive'), 'the app folder never shows');
});

test('zip streams a folder and picked files', async () => {
  const res = await app.inject({ url: '/api/zip?path=' + encodeURIComponent('Docs/a (2)') + '&path=' + encodeURIComponent('Docs/new'), headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.match(String(res.headers['content-disposition']), /Docs\.zip/);
  const body = res.rawPayload;
  assert.equal(body.readUInt32LE(0), 0x04034b50, 'local file header signature');
  assert.ok(body.includes(Buffer.from('a (2)/deep/x.txt')));
  assert.ok(body.includes(Buffer.from('new/')));
});

test('chunked upload: begin, pieces, offset mismatch, complete with rename policy', async () => {
  const begin = await app.inject(json('POST', '/api/uploads', { dir: 'Docs', name: 'big.bin', size: 10, mtime: 1_700_000_000_000 }));
  assert.equal(begin.statusCode, 201);
  const up = begin.json() as UploadStatus;
  assert.equal(up.exists, false);
  const piece = (offset: number, data: string) => app.inject({ method: 'PATCH', url: `/api/uploads/${up.id}`, payload: Buffer.from(data), headers: { 'content-type': 'application/octet-stream', 'upload-offset': String(offset), cookie: admin } });
  assert.equal((await piece(0, '01234')).json().received, 5);
  const bad = await piece(3, 'xx');
  assert.equal(bad.statusCode, 409);
  assert.match(bad.json().message, /5 bytes received/);
  assert.equal((await piece(5, '56789')).json().received, 10);
  assert.equal((await piece(10, 'z')).statusCode, 400, 'more than announced');
  const done = await app.inject(json('POST', `/api/uploads/${up.id}/complete`, {}));
  assert.equal(done.json().path, 'Docs/big.bin');
  assert.equal(await readFile(join(base, 'docs', 'big.bin'), 'utf8'), '0123456789');

  // second upload of the same name → conflict → rename
  const again = (await app.inject(json('POST', '/api/uploads', { dir: 'Docs', name: 'big.bin', size: 2 }))).json() as UploadStatus;
  assert.equal(again.exists, true);
  await app.inject({ method: 'PATCH', url: `/api/uploads/${again.id}`, payload: Buffer.from('ab'), headers: { 'content-type': 'application/octet-stream', 'upload-offset': '0', cookie: admin } });
  assert.equal((await app.inject(json('POST', `/api/uploads/${again.id}/complete`, {}))).statusCode, 409);
  const kept = await app.inject(json('POST', `/api/uploads/${again.id}/complete`, { onConflict: 'rename' }));
  assert.equal(kept.json().path, 'Docs/big (2).bin');
  assert.equal((await app.inject({ url: `/api/uploads/${again.id}`, headers: { cookie: admin } })).statusCode, 404, 'record gone after completion');
  assert.deepEqual(await readdir(join(base, 'docs', '.mk-drive', 'uploads')), [], 'no parts left behind');

  const ro = await app.inject(json('POST', '/api/uploads', { dir: 'Media', name: 'x', size: 1 }));
  assert.equal(ro.statusCode, 403);
});
