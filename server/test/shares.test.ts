import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { snapshotTime } from '../src/routes/versions.ts';
import type { Listing, Share, ShareInfo, Version } from '../../shared/types.ts';

let base: string;
let app: FastifyInstance;
let admin = '';
const PW = 'correct horse battery';

function cfgWith(): Config {
  return { ...config, staticDir: '', dbFile: ':memory:', thumbDir: join(base, 'thumbs'), adminEmail: 'alex@example.com', adminPassword: PW, locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: ['.ssh'] }], accessAud: '' };
}
const json = (method: InjectOptions['method'], url: string, payload: unknown, cookie = admin): InjectOptions => ({ method, url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-shares-'));
  await mkdir(join(base, 'docs', 'album', 'sub'), { recursive: true });
  await mkdir(join(base, 'docs', '.ssh'), { recursive: true });
  await writeFile(join(base, 'docs', 'album', 'a.txt'), 'AAA');
  await writeFile(join(base, 'docs', 'album', 'sub', 'b.txt'), 'BB');
  await writeFile(join(base, 'docs', 'album', '.secret'), 'no');
  await writeFile(join(base, 'docs', 'report.pdf'), '%PDF');
  await writeFile(join(base, 'docs', '.ssh', 'key'), 'k');
  // a fake ZFS snapshot tree
  await mkdir(join(base, 'docs', '.zfs', 'snapshot', 'auto-docs-2026-09-09_03-30', 'album'), { recursive: true });
  await writeFile(join(base, 'docs', '.zfs', 'snapshot', 'auto-docs-2026-09-09_03-30', 'album', 'a.txt'), 'A');
  await mkdir(join(base, 'docs', '.zfs', 'snapshot', 'auto-docs-2026-09-10_03-30', 'album'), { recursive: true });
  await writeFile(join(base, 'docs', '.zfs', 'snapshot', 'auto-docs-2026-09-10_03-30', 'album', 'a.txt'), 'AAA');
  const same = new Date(2026, 8, 9, 12, 0, 0); // an unchanged file keeps its mtime across snapshots
  await utimes(join(base, 'docs', 'album', 'a.txt'), same, same);
  await utimes(join(base, 'docs', '.zfs', 'snapshot', 'auto-docs-2026-09-10_03-30', 'album', 'a.txt'), same, same);
  app = await createApp(cfgWith(), { logger: false });
  const login = await app.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }, ''));
  admin = String(login.headers['set-cookie']).split(';')[0];
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('share a file: public info, stream, hit count, no browsing', async () => {
  const created = await app.inject(json('POST', '/api/shares', { path: 'Docs/report.pdf' }));
  assert.equal(created.statusCode, 201);
  const share = created.json() as Share;
  assert.equal(share.kind, 'file');
  assert.equal(share.locked, false);

  const info = (await app.inject({ url: `/api/s/${share.id}` })).json() as ShareInfo;
  assert.equal(info.name, 'report.pdf');
  assert.equal(info.open, true);
  const file = await app.inject({ url: `/api/s/${share.id}/file` });
  assert.equal(file.statusCode, 200);
  assert.equal(file.body, '%PDF');
  assert.equal(file.headers['content-type'], 'application/pdf');
  assert.equal((await app.inject({ url: `/api/s/${share.id}/ls` })).statusCode, 403, 'a file link cannot be browsed');
  assert.equal((await app.inject({ url: `/api/s/${share.id}/file?path=../.ssh/key` })).statusCode, 400);
  const mine = (await app.inject({ url: '/api/shares', headers: { cookie: admin } })).json() as Share[];
  assert.equal(mine[0].hits, 1);
  assert.equal((await app.inject({ url: '/api/s/nope' })).statusCode, 404);
});

test('share a folder with a password: locked until unlocked, listing hides dotfiles, zip works, escape refused', async () => {
  const share = (await app.inject(json('POST', '/api/shares', { path: 'Docs/album', password: 'open sesame', expiresAt: Date.now() + 60_000 }))).json() as Share;
  assert.equal(share.locked, true);
  const info = (await app.inject({ url: `/api/s/${share.id}` })).json() as ShareInfo;
  assert.equal(info.open, false);
  assert.equal((await app.inject({ url: `/api/s/${share.id}/ls` })).statusCode, 401);
  assert.equal((await app.inject(json('POST', `/api/s/${share.id}/unlock`, { password: 'wrong' }, ''))).statusCode, 401);
  await new Promise((r) => setTimeout(r, 1100));
  const unlocked = await app.inject(json('POST', `/api/s/${share.id}/unlock`, { password: 'open sesame' }, ''));
  assert.equal(unlocked.statusCode, 200);
  const cookie = String(unlocked.headers['set-cookie']).split(';')[0];
  assert.match(cookie, /^mkdrive_share_/);

  const ls = (await app.inject({ url: `/api/s/${share.id}/ls`, headers: { cookie } })).json() as Listing;
  assert.deepEqual(
    ls.entries.map((e) => `${e.kind}:${e.path}`),
    ['dir:sub', 'file:a.txt'],
    'paths are relative to the share, dotfiles hidden',
  );
  const deeper = (await app.inject({ url: `/api/s/${share.id}/ls?path=sub`, headers: { cookie } })).json() as Listing;
  assert.deepEqual(deeper.entries.map((e) => e.path), ['sub/b.txt']);
  assert.equal((await app.inject({ url: `/api/s/${share.id}/file?path=sub/b.txt`, headers: { cookie } })).body, 'BB');
  assert.equal((await app.inject({ url: `/api/s/${share.id}/file?path=.secret`, headers: { cookie } })).statusCode, 200, 'direct dotfile fetch inside the share is fine');
  assert.equal((await app.inject({ url: `/api/s/${share.id}/file?path=../report.pdf`, headers: { cookie } })).statusCode, 400);
  const zip = await app.inject({ url: `/api/s/${share.id}/zip`, headers: { cookie } });
  assert.equal(zip.statusCode, 200);
  assert.ok(zip.rawPayload.includes(Buffer.from('album/sub/b.txt')));
  assert.ok(!zip.rawPayload.includes(Buffer.from('.secret')));
});

test('download-only folder links, expiry, deletion', async () => {
  const dl = (await app.inject(json('POST', '/api/shares', { path: 'Docs/album', mode: 'download' }))).json() as Share;
  assert.equal((await app.inject({ url: `/api/s/${dl.id}/ls` })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/s/${dl.id}/zip` })).statusCode, 200);
  assert.equal((await app.inject(json('POST', '/api/shares', { path: 'Docs/album', expiresAt: Date.now() - 1 }))).statusCode, 400);
  assert.equal((await app.inject(json('POST', '/api/shares', { path: 'Docs' }))).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/shares/${dl.id}`, headers: { cookie: admin } })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/s/${dl.id}` })).statusCode, 404);
});

test('file requests: visitors add files and see nothing; a taken name is kept beside; files only into folders', async () => {
  assert.equal((await app.inject(json('POST', '/api/shares', { path: 'Docs/report.pdf', mode: 'upload' }))).statusCode, 400);
  const req = (await app.inject(json('POST', '/api/shares', { path: 'Docs/album', mode: 'upload' }))).json() as Share;
  assert.equal(req.mode, 'upload');
  const info = (await app.inject({ url: `/api/s/${req.id}` })).json() as ShareInfo;
  assert.equal(info.mode, 'upload');
  // nothing comes out
  assert.equal((await app.inject({ url: `/api/s/${req.id}/ls` })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/s/${req.id}/zip` })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/s/${req.id}/file?path=a.txt` })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/s/${req.id}/thumb?path=a.txt` })).statusCode, 403);
  // a browse link does not take files in
  const browse = (await app.inject(json('POST', '/api/shares', { path: 'Docs/album' }))).json() as Share;
  assert.equal((await app.inject(json('POST', `/api/s/${browse.id}/uploads`, { name: 'x.txt', size: 1 }, ''))).statusCode, 403);
  // the visitor sends a file in two pieces, with a name that is already taken
  const begin = (await app.inject(json('POST', `/api/s/${req.id}/uploads`, { name: 'a.txt', size: 5 }, ''))).json() as { id: string; exists: boolean };
  assert.equal(begin.exists, false);
  const piece = (offset: number, body: string) => app.inject({ method: 'PATCH', url: `/api/s/${req.id}/uploads/${begin.id}`, payload: body, headers: { 'content-type': 'application/octet-stream', 'upload-offset': String(offset) } });
  assert.equal((await piece(0, 'hel')).json().received, 3);
  assert.equal((await piece(3, 'lo')).json().received, 5);
  // the owner's own upload routes do not know it, nor does another link
  assert.equal((await app.inject({ url: `/api/uploads/${begin.id}`, headers: { cookie: admin } })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/s/${browse.id}/uploads/${begin.id}` })).statusCode, 403);
  const done = (await app.inject(json('POST', `/api/s/${req.id}/uploads/${begin.id}/complete`, {}, ''))).json() as { name: string };
  assert.notEqual(done.name, 'a.txt');
  assert.equal(await readFile(join(base, 'docs', 'album', done.name), 'utf8'), 'hello');
  assert.equal(await readFile(join(base, 'docs', 'album', 'a.txt'), 'utf8'), 'AAA');
  await rm(join(base, 'docs', 'album', done.name)); // the versions test counts the siblings of a.txt
  const mine = ((await app.inject({ url: '/api/shares/for?path=Docs/album', headers: { cookie: admin } })).json() as Share[]).find((s) => s.id === req.id)!;
  assert.equal(mine.hits, 1);
  // dotfiles and reserved names are refused up front
  assert.equal((await app.inject(json('POST', `/api/s/${req.id}/uploads`, { name: '.hidden', size: 1 }, ''))).statusCode, 400);
  assert.equal((await app.inject(json('POST', `/api/s/${req.id}/uploads`, { name: '../x', size: 1 }, ''))).statusCode, 400);
});

test('versions from a snapshot tree: listed newest first, duplicates of the current file skipped, restore keeps both', async () => {
  assert.equal(snapshotTime('auto-docs-2026-09-09_03-30'), new Date(2026, 8, 9, 3, 30).getTime());
  assert.equal(snapshotTime('manual'), 0);
  const versions = (await app.inject({ url: '/api/versions?path=' + encodeURIComponent('Docs/album/a.txt'), headers: { cookie: admin } })).json() as Version[];
  assert.deepEqual(
    versions.map((v) => [v.snapshot, v.size]),
    [['auto-docs-2026-09-09_03-30', 1]],
    'the 09-10 snapshot equals the current file and is skipped',
  );
  const old = await app.inject({ url: '/api/versions/file?path=' + encodeURIComponent('Docs/album/a.txt') + '&snapshot=auto-docs-2026-09-09_03-30', headers: { cookie: admin } });
  assert.equal(old.body, 'A');
  const restored = await app.inject(json('POST', '/api/versions/restore', { path: 'Docs/album/a.txt', snapshot: 'auto-docs-2026-09-09_03-30' }));
  assert.equal(restored.json().path, 'Docs/album/a (2).txt');
  assert.equal(await readFile(join(base, 'docs', 'album', 'a (2).txt'), 'utf8'), 'A');
  const replaced = await app.inject(json('POST', '/api/versions/restore', { path: 'Docs/album/a.txt', snapshot: 'auto-docs-2026-09-09_03-30', onConflict: 'replace' }));
  assert.equal(replaced.json().path, 'Docs/album/a.txt');
  assert.equal(await readFile(join(base, 'docs', 'album', 'a.txt'), 'utf8'), 'A');
  const locs = (await app.inject({ url: '/api/locations', headers: { cookie: admin } })).json();
  assert.equal(locs[0].capabilities.versions, true);
});
