import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, lstat, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { LocalProvider } from '../src/storage/local.ts';
import { SANDBOX_CSP } from '../src/serve-headers.ts';
import { BEGIN_PER_MINUTE, LINK_MAX_BYTES, LINK_MAX_FILES } from '../src/routes/shares.ts';
import type { AppPasswordCreated, Listing, Share } from '../../shared/types.ts';

const PW = 'correct horse battery';
const SNAP = 'auto-docs-2026-09-10_03-30';
let base: string;
let app: FastifyInstance;
let admin = '';
let member = '';
let basic: Record<string, string>;

const json = (method: InjectOptions['method'], url: string, payload: unknown, cookie = admin, extra: Partial<InjectOptions> = {}): InjectOptions => ({
  method,
  url,
  payload: JSON.stringify(payload),
  ...extra,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
});
const gone = (p: string) =>
  access(p).then(
    () => false,
    () => true,
  );

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-sec-'));
  const docs = join(base, 'docs');
  for (const d of ['inbox', 'team', 'private', '.ssh']) await mkdir(join(docs, d), { recursive: true });
  await mkdir(join(base, 'other'), { recursive: true });
  await mkdir(join(base, 'outside'), { recursive: true });
  await writeFile(join(base, 'outside', 'secret.txt'), 'TOP SECRET');
  await writeFile(join(docs, 'page.html'), '<script>alert(document.domain)</script>');
  await writeFile(join(docs, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  await writeFile(join(docs, 'feed.xml'), '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>');
  await writeFile(join(docs, 'photo.png'), 'png');
  await writeFile(join(docs, 'doc.pdf'), '%PDF');
  await writeFile(join(docs, 'private', 'salary.txt'), 'SALARY');
  await writeFile(join(docs, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
  await writeFile(join(base, 'other', 'dangling.txt'), 'from the other location');
  // links out of the location, dangling, and inside it past a grant or a hidden name
  await symlink(join(base, 'outside', 'secret.txt'), join(docs, 'link.txt'));
  await symlink(join(base, 'outside', 'planted.txt'), join(docs, 'dangling.txt'));
  await symlink(join(base, 'outside', 'planted2.txt'), join(docs, 'dangling2.txt'));
  await symlink('../private', join(docs, 'team', 'priv'));
  await symlink('../.ssh', join(docs, 'team', 'keys'));
  // a fake ZFS snapshot with an XHTML file and links out of the location
  const snap = join(docs, '.zfs', 'snapshot', SNAP);
  await mkdir(snap, { recursive: true });
  await writeFile(join(snap, 'feed.xml'), '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>');
  await symlink(join(base, 'outside', 'secret.txt'), join(snap, 'leak.txt'));
  await symlink(join(base, 'outside'), join(snap, 'dirlink'));
  const cfg: Config = {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    thumbDir: join(base, 'thumbs'),
    adminEmail: 'alex@example.com',
    adminPassword: PW,
    locations: [
      { name: 'Docs', path: docs, mode: 'rw', hide: ['.ssh'] },
      { name: 'Other', path: join(base, 'other'), mode: 'rw', hide: [] },
    ],
    accessAud: '',
  };
  app = await createApp(cfg, { logger: false });
  admin = String((await app.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }, ''))).headers['set-cookie']).split(';')[0];
  await app.inject(json('POST', '/api/users', { email: 'mal@example.com', name: 'Mal', password: PW, grants: {} }));
  member = String((await app.inject(json('POST', '/api/login', { email: 'mal@example.com', password: PW }, ''))).headers['set-cookie']).split(';')[0];
  assert.equal((await app.inject(json('POST', '/api/user-shares', { path: 'Docs/team', email: 'mal@example.com', level: 'write' }))).statusCode, 201);
  const t = (await app.inject(json('POST', '/api/app-passwords', { name: 'finder' }))).json() as AppPasswordCreated;
  basic = { authorization: `Basic ${Buffer.from(`alex@example.com:${t.secret}`).toString('base64')}` };
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('raw file bytes never run as a page on the drive origin; passive previews stay inline', async () => {
  // WebDAV: always a sandboxed download
  for (const name of ['page.html', 'pic.svg', 'feed.xml', 'photo.png']) {
    const r = await app.inject({ url: `/dav/Docs/${name}`, headers: basic });
    assert.equal(r.statusCode, 200, name);
    assert.equal(r.headers['content-security-policy'], SANDBOX_CSP, name);
    assert.match(String(r.headers['content-disposition']), /^attachment;/, name);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', name);
  }
  // the app's inline preview: active types sandboxed, passive ones untouched
  for (const name of ['page.html', 'pic.svg', 'feed.xml']) {
    const r = await app.inject({ url: `/api/file?path=Docs/${name}`, headers: { cookie: admin } });
    assert.equal(r.headers['content-security-policy'], SANDBOX_CSP, name);
    const d = await app.inject({ url: `/api/file?path=Docs/${name}&download=1`, headers: { cookie: admin } });
    assert.match(String(d.headers['content-disposition']), /^attachment;/, name);
  }
  for (const name of ['photo.png', 'doc.pdf']) {
    const r = await app.inject({ url: `/api/file?path=Docs/${name}`, headers: { cookie: admin } });
    assert.equal(r.headers['content-security-policy'], undefined, name);
    assert.match(String(r.headers['content-disposition']), /^inline;/, name);
  }
  // an earlier version is no preview: an XHTML file is a sandboxed download
  const v = await app.inject({ url: `/api/versions/file?path=Docs/feed.xml&snapshot=${SNAP}`, headers: { cookie: admin } });
  assert.equal(v.statusCode, 200);
  assert.equal(v.headers['content-security-policy'], SANDBOX_CSP);
  assert.match(String(v.headers['content-disposition']), /^attachment;/);
  // a public link
  const s = (await app.inject(json('POST', '/api/shares', { path: 'Docs/pic.svg' }))).json() as Share;
  const p = await app.inject({ url: `/api/s/${s.id}/file` });
  assert.equal(p.statusCode, 200);
  assert.equal(p.headers['content-security-policy'], SANDBOX_CSP);
});

test('versions do not follow a symlink out of the location', async () => {
  for (const path of ['Docs/leak.txt', 'Docs/dirlink/secret.txt']) {
    const r = await app.inject({ url: `/api/versions/file?path=${path}&snapshot=${SNAP}`, headers: { cookie: admin } });
    assert.equal(r.statusCode, 404, path);
    assert.doesNotMatch(r.body, /TOP SECRET/);
  }
  assert.deepEqual((await app.inject({ url: '/api/versions?path=Docs/leak.txt', headers: { cookie: admin } })).json(), []);
  const restore = await app.inject(json('POST', '/api/versions/restore', { path: 'Docs/leak.txt', snapshot: SNAP }));
  assert.equal(restore.statusCode, 404);
  assert.equal(await gone(join(base, 'docs', 'leak (2).txt')), true);
});

test('writes never go through a symlink, dangling or not', async () => {
  const put = await app.inject({ method: 'PUT', url: '/dav/Docs/link.txt', payload: 'OVERWRITTEN', headers: { ...basic, 'content-type': 'text/plain' } });
  assert.equal(put.statusCode, 409);
  assert.equal(await readFile(join(base, 'outside', 'secret.txt'), 'utf8'), 'TOP SECRET');
  const dangling = await app.inject({ method: 'PUT', url: '/dav/Docs/dangling.txt', payload: 'PLANTED', headers: { ...basic, 'content-type': 'text/plain' } });
  assert.equal(dangling.statusCode, 409);
  const lock = await app.inject({ method: 'LOCK' as InjectOptions['method'], url: '/dav/Docs/dangling.txt', headers: basic });
  assert.equal(lock.statusCode, 409);
  // a copy from another location lands through the provider's write
  await app.inject(json('POST', '/api/copy', { paths: ['Other/dangling.txt'], to: 'Docs' }));
  assert.deepEqual(await readdir(join(base, 'outside')), ['secret.txt']);
  // an upload's commit replaces the link itself (rename), never its target
  const b = (await app.inject(json('POST', '/api/uploads', { dir: 'Docs', name: 'dangling2.txt', size: 3 }))).json();
  const piece = await app.inject({
    method: 'PATCH',
    url: `/api/uploads/${b.id}`,
    payload: 'new',
    headers: { cookie: admin, 'content-type': 'application/octet-stream', 'upload-offset': '0' },
  });
  assert.equal(piece.statusCode, 200);
  assert.equal((await app.inject(json('POST', `/api/uploads/${b.id}/complete`, { onConflict: 'replace' }))).statusCode, 200);
  assert.equal((await lstat(join(base, 'docs', 'dangling2.txt'))).isSymbolicLink(), false);
  assert.deepEqual(await readdir(join(base, 'outside')), ['secret.txt']);
});

test('grants and hidden names hold through symlinks inside a location; delete acts on nothing behind a link', async () => {
  for (const path of ['Docs/team/priv/salary.txt', 'Docs/team/keys/id_ed25519', 'Docs/link.txt']) {
    const r = await app.inject({ url: `/api/file?path=${path}`, headers: { cookie: path === 'Docs/link.txt' ? admin : member } });
    assert.equal(r.statusCode, 404, path);
  }
  const ls = (await app.inject({ url: '/api/ls?path=Docs/team', headers: { cookie: member } })).json() as Listing;
  assert.deepEqual(
    ls.entries.map((e) => e.name),
    [],
  );
  await app.inject(json('POST', '/api/delete', { paths: ['Docs/team/priv'] }, member));
  assert.equal(await readFile(join(base, 'docs', 'private', 'salary.txt'), 'utf8'), 'SALARY');
  await app.inject(json('POST', '/api/rename', { path: 'Docs/team/priv', name: 'moved' }, member));
  assert.equal(await gone(join(base, 'docs', 'team', 'moved')), true);
  assert.equal(await readFile(join(base, 'docs', 'private', 'salary.txt'), 'utf8'), 'SALARY');
});

test('an upload piece must say its length and cannot send more', async () => {
  const b = (await app.inject(json('POST', '/api/uploads', { dir: 'Docs', name: 'piece.bin', size: 10 }))).json();
  const url = `/api/uploads/${b.id}`;
  const headers = { cookie: admin, 'content-type': 'application/octet-stream', 'upload-offset': '0' };
  const noLength = await app.inject({ method: 'PATCH', url, payload: Readable.from([Buffer.alloc(10, 65)]), headers });
  assert.equal(noLength.statusCode, 411);
  const lying = await app.inject({ method: 'PATCH', url, payload: Readable.from([Buffer.alloc(10, 65)]), headers: { ...headers, 'content-length': '5' } });
  assert.equal(lying.statusCode, 413);
  const s = (await app.inject({ url, headers: { cookie: admin } })).json();
  assert.ok(s.received <= 5);
  const ok = await app.inject({
    method: 'PATCH',
    url,
    payload: Buffer.alloc(10 - s.received, 65),
    headers: { ...headers, 'upload-offset': String(s.received) },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject(json('POST', `${url}/complete`, {}))).statusCode, 200);
});

test('a file-request link: size, space, rate and count limits', async () => {
  const share = (await app.inject(json('POST', '/api/shares', { path: 'Docs/inbox', mode: 'upload' }))).json() as Share;
  const begin = (size: number, ip = '192.0.2.1') => app.inject(json('POST', `/api/s/${share.id}/uploads`, { name: 'f.bin', size }, '', { remoteAddress: ip }));
  assert.equal((await begin(LINK_MAX_BYTES + 1)).statusCode, 413);
  const space = LocalProvider.prototype.space;
  LocalProvider.prototype.space = async () => ({ free: 1024, total: 1024 ** 3 });
  try {
    assert.equal((await begin(1000)).statusCode, 507);
  } finally {
    LocalProvider.prototype.space = space;
  }
  // starts per address and link, per minute (two are spent above)
  for (let i = 2; i < BEGIN_PER_MINUTE; i++) assert.equal((await begin(0)).statusCode, 201);
  const limited = await begin(0);
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  // the files a link takes, pending ones included, whatever the address
  let n = BEGIN_PER_MINUTE - 2;
  for (let ip = 2; n < LINK_MAX_FILES; ip++)
    for (let i = 0; i < BEGIN_PER_MINUTE && n < LINK_MAX_FILES; i++, n++) assert.equal((await begin(0, `192.0.2.${ip}`)).statusCode, 201);
  assert.equal((await begin(0, '198.51.100.1')).statusCode, 413);
});

test('a link password: a pool of addresses guesses no faster than one', async () => {
  const locked = (await app.inject(json('POST', '/api/shares', { path: 'Docs/photo.png', password: 'abcd' }))).json() as Share;
  const other = (await app.inject(json('POST', '/api/shares', { path: 'Docs/doc.pdf', password: 'abcd' }))).json() as Share;
  const unlock = (id: string, password: string, ip: string) => app.inject(json('POST', `/api/s/${id}/unlock`, { password }, '', { remoteAddress: ip }));
  assert.equal((await unlock(locked.id, 'wrong', '203.0.113.1')).statusCode, 401);
  assert.equal((await unlock(locked.id, 'wrong', '203.0.113.2')).statusCode, 429);
  // another link keeps its own budget
  assert.equal((await unlock(other.id, 'wrong', '203.0.113.2')).statusCode, 401);
});

test('a link password: a concurrent burst is judged one guess at a time', async () => {
  const locked = (await app.inject(json('POST', '/api/shares', { path: 'Docs/page.html', password: 'abcd' }))).json() as Share;
  const burst = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      app.inject(json('POST', `/api/s/${locked.id}/unlock`, { password: i === 11 ? 'abcd' : `wrong-${i}` }, '', { remoteAddress: `203.0.113.${i + 10}` })),
    ),
  );
  const codes = burst.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 429).length, 11, codes.join(','));
  assert.ok(burst.filter((r) => r.statusCode === 429).every((r) => Number(r.headers['retry-after']) > 0));
});
