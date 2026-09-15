import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { AppPasswordCreated, TrashEntry } from '../../shared/types.ts';

const PW = 'correct horse battery';
let base: string;
let app: FastifyInstance;
let admin = '';
let basic: Record<string, string>;

const json = (method: InjectOptions['method'], url: string, payload: unknown, cookie: string): InjectOptions => ({
  method,
  url,
  payload: JSON.stringify(payload),
  headers: { 'content-type': 'application/json', cookie },
});
const dav = (method: string, url: string, extra: Partial<InjectOptions> = {}): InjectOptions => ({
  method: method as InjectOptions['method'],
  url,
  ...extra,
  headers: { ...basic, ...(extra.headers ?? {}) },
});
const hrefs = (body: string) => [...body.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-dav-'));
  await mkdir(join(base, 'docs', 'notes'), { recursive: true });
  await mkdir(join(base, 'docs', '.ssh'), { recursive: true });
  await mkdir(join(base, 'media'), { recursive: true });
  await writeFile(join(base, 'docs', 'hello.txt'), 'hello dav');
  await writeFile(join(base, 'docs', '.dotfile'), 'dot');
  await writeFile(join(base, 'media', 'a.jpg'), 'jpg');
  const cfg: Config = {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: 'alex@example.com',
    adminPassword: PW,
    locations: [
      { name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: ['.ssh'] },
      { name: 'Media', path: join(base, 'media'), mode: 'ro', hide: [] },
    ],
    accessAud: '',
  };
  app = await createApp(cfg, { logger: false });
  admin = String((await app.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }, ''))).headers['set-cookie']).split(';')[0];
  const t = (await app.inject(json('POST', '/api/app-passwords', { name: 'finder' }, admin))).json() as AppPasswordCreated;
  basic = { authorization: `Basic ${Buffer.from(`alex@example.com:${t.secret}`).toString('base64')}` };
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('OPTIONS answers without credentials; everything else wants an app password', async () => {
  const opt = await app.inject({ method: 'OPTIONS', url: '/dav/' });
  assert.equal(opt.statusCode, 200);
  assert.equal(opt.headers['dav'], '1, 2');
  assert.match(String(opt.headers['allow']), /PROPFIND/);
  const anon = await app.inject({ method: 'PROPFIND' as never, url: '/dav/' });
  assert.equal(anon.statusCode, 401);
  assert.match(String(anon.headers['www-authenticate']), /^Basic realm=/);
  // a bad secret counts against the address, so keep it off the one the rest of the file uses
  const wrong = await app.inject({
    method: 'PROPFIND' as never,
    url: '/dav/',
    remoteAddress: '203.0.113.7',
    headers: { authorization: `Basic ${Buffer.from('alex@example.com:nope').toString('base64')}` },
  });
  assert.equal(wrong.statusCode, 401);
});

test('PROPFIND: the root lists locations, a folder lists its children, hidden names stay out', async () => {
  const root = await app.inject(dav('PROPFIND', '/dav/', { headers: { depth: '1' } }));
  assert.equal(root.statusCode, 207);
  assert.match(String(root.headers['content-type']), /xml/);
  assert.deepEqual(hrefs(root.body), ['/dav/', '/dav/Docs/', '/dav/Media/']);
  assert.match(root.body, /quota-available-bytes/);
  const docs = await app.inject(dav('PROPFIND', '/dav/Docs/', { headers: { depth: '1' } }));
  assert.deepEqual(
    hrefs(docs.body).sort(),
    ['/dav/Docs/', '/dav/Docs/.dotfile', '/dav/Docs/hello.txt', '/dav/Docs/notes/'].sort(),
    'dotfiles yes, hidden names no',
  );
  assert.match(docs.body, /<D:getcontentlength>9<\/D:getcontentlength>/);
  assert.match(docs.body, /<D:getcontenttype>text\/plain<\/D:getcontenttype>/);
  assert.equal(hrefs((await app.inject(dav('PROPFIND', '/dav/Docs/', { headers: { depth: '0' } }))).body).length, 1);
  assert.equal((await app.inject(dav('PROPFIND', '/dav/Docs/.ssh/'))).statusCode, 404);
  assert.equal((await app.inject(dav('PROPFIND', '/dav/Nope/'))).statusCode, 404);
  const file = await app.inject(dav('PROPFIND', '/dav/Docs/hello.txt'));
  assert.deepEqual(hrefs(file.body), ['/dav/Docs/hello.txt']);
  assert.match(file.body, /<D:resourcetype\/>/);
});

test('GET streams with ranges and ETags; HEAD has no body', async () => {
  const full = await app.inject(dav('GET', '/dav/Docs/hello.txt'));
  assert.equal(full.statusCode, 200);
  assert.equal(full.body, 'hello dav');
  assert.equal(full.headers['content-type'], 'text/plain');
  const part = await app.inject(dav('GET', '/dav/Docs/hello.txt', { headers: { range: 'bytes=0-4' } }));
  assert.equal(part.statusCode, 206);
  assert.equal(part.body, 'hello');
  const head = await app.inject(dav('HEAD', '/dav/Docs/hello.txt'));
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-length'], '9');
  assert.equal(head.body, '');
  assert.equal((await app.inject(dav('GET', '/dav/Docs/hello.txt', { headers: { 'if-none-match': String(full.headers['etag']) } }))).statusCode, 304);
});

test('PUT creates and overwrites, with or without a content type; MKCOL makes folders', async () => {
  const made = await app.inject(dav('PUT', '/dav/Docs/notes/todo.txt', { payload: 'milk', headers: { 'content-type': 'text/plain' } }));
  assert.equal(made.statusCode, 201);
  assert.equal(await readFile(join(base, 'docs', 'notes', 'todo.txt'), 'utf8'), 'milk');
  const again = await app.inject(dav('PUT', '/dav/Docs/notes/todo.txt', { payload: 'milk, eggs' }));
  assert.equal(again.statusCode, 204, 'no content type is fine (curl -T)');
  assert.equal(await readFile(join(base, 'docs', 'notes', 'todo.txt'), 'utf8'), 'milk, eggs');
  assert.equal((await app.inject(dav('PUT', '/dav/Docs/missing/x.txt', { payload: 'x' }))).statusCode, 409, 'parent must exist');
  assert.equal((await app.inject(dav('PUT', '/dav/Media/new.jpg', { payload: 'x' }))).statusCode, 403, 'read-only location');
  assert.equal((await app.inject(dav('PUT', '/dav/Docs/.ssh/id', { payload: 'x' }))).statusCode, 404, 'hidden stays hidden');
  assert.equal((await app.inject(dav('MKCOL', '/dav/Docs/photos'))).statusCode, 201);
  assert.ok((await stat(join(base, 'docs', 'photos'))).isDirectory());
  assert.equal((await app.inject(dav('MKCOL', '/dav/Docs/photos'))).statusCode, 405, 'already there');
  assert.equal((await app.inject(dav('MKCOL', '/dav/Docs/a/b'))).statusCode, 409, 'parent must exist');
});

test('COPY and MOVE honour Destination and Overwrite; DELETE goes to the trash', async () => {
  const copy = await app.inject(dav('COPY', '/dav/Docs/hello.txt', { headers: { destination: '/dav/Docs/photos/hello-copy.txt' } }));
  assert.equal(copy.statusCode, 201);
  assert.equal(await readFile(join(base, 'docs', 'photos', 'hello-copy.txt'), 'utf8'), 'hello dav');
  const clash = await app.inject(
    dav('COPY', '/dav/Docs/hello.txt', { headers: { destination: 'http://drive.test/dav/Docs/photos/hello-copy.txt', overwrite: 'F' } }),
  );
  assert.equal(clash.statusCode, 412);
  const over = await app.inject(dav('COPY', '/dav/Docs/notes/todo.txt', { headers: { destination: '/dav/Docs/photos/hello-copy.txt' } }));
  assert.equal(over.statusCode, 204, 'overwritten');
  assert.equal(await readFile(join(base, 'docs', 'photos', 'hello-copy.txt'), 'utf8'), 'milk, eggs');
  const rename = await app.inject(dav('MOVE', '/dav/Docs/photos/hello-copy.txt', { headers: { destination: '/dav/Docs/photos/renamed.txt' } }));
  assert.equal(rename.statusCode, 201);
  const move = await app.inject(dav('MOVE', '/dav/Docs/photos/renamed.txt', { headers: { destination: '/dav/Docs/notes/moved.txt' } }));
  assert.equal(move.statusCode, 201);
  assert.equal(await readFile(join(base, 'docs', 'notes', 'moved.txt'), 'utf8'), 'milk, eggs');
  assert.equal(
    (await app.inject(dav('MOVE', '/dav/Docs/notes/moved.txt', { headers: { destination: '/dav/Media/moved.txt' } }))).statusCode,
    403,
    'read-only destination',
  );
  assert.equal((await app.inject(dav('MOVE', '/dav/Docs/notes/moved.txt', { headers: { destination: 'https://elsewhere.example/x' } }))).statusCode, 502);
  assert.equal((await app.inject(dav('MOVE', '/dav/Docs/notes/moved.txt', {}))).statusCode, 400, 'Destination required');

  const del = await app.inject(dav('DELETE', '/dav/Docs/notes/moved.txt'));
  assert.equal(del.statusCode, 204);
  const trash = (await app.inject({ url: '/api/trash?location=Docs', headers: { cookie: admin } })).json() as TrashEntry[];
  assert.deepEqual(
    trash.map((t) => t.original),
    ['Docs/notes/moved.txt'],
  );
  assert.equal((await app.inject(dav('DELETE', '/dav/Docs/notes/moved.txt'))).statusCode, 404);
  assert.equal((await app.inject(dav('DELETE', '/dav/Docs'))).statusCode, 405, 'a location cannot be deleted');
});

test('LOCK hands out a token (and creates the file Finder is about to upload); UNLOCK and PROPPATCH keep clients going', async () => {
  const lock = await app.inject(
    dav('LOCK', '/dav/Docs/notes/todo.txt', {
      payload: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
      headers: { 'content-type': 'application/xml', timeout: 'Second-600' },
    }),
  );
  assert.equal(lock.statusCode, 200);
  assert.match(String(lock.headers['lock-token']), /^<opaquelocktoken:/);
  assert.match(lock.body, /<D:timeout>Second-600<\/D:timeout>/);
  const fresh = await app.inject(dav('LOCK', '/dav/Docs/notes/new.txt'));
  assert.equal(fresh.statusCode, 201);
  assert.equal(await readFile(join(base, 'docs', 'notes', 'new.txt'), 'utf8'), '');
  assert.equal((await app.inject(dav('UNLOCK', '/dav/Docs/notes/new.txt', { headers: { 'lock-token': String(lock.headers['lock-token']) } }))).statusCode, 204);
  const pp = await app.inject(
    dav('PROPPATCH', '/dav/Docs/notes/new.txt', {
      payload:
        '<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop><Z:Win32LastModifiedTime>x</Z:Win32LastModifiedTime></D:prop></D:set></D:propertyupdate>',
      headers: { 'content-type': 'application/xml' },
    }),
  );
  assert.equal(pp.statusCode, 207);
  assert.match(pp.body, /Win32LastModifiedTime/);
  assert.match(pp.body, /403 Forbidden/);
});

test('the session cookie does not open WebDAV; a member sees only their locations', async () => {
  const viaCookie = await app.inject({ method: 'PROPFIND' as never, url: '/dav/', headers: { cookie: admin, depth: '1' } });
  assert.equal(viaCookie.statusCode, 401);
  await app.inject(json('POST', '/api/users', { email: 'anna@example.com', name: 'Anna', password: PW, grants: { Media: 'read' } }, admin));
  const anna = String((await app.inject(json('POST', '/api/login', { email: 'anna@example.com', password: PW }, ''))).headers['set-cookie']).split(';')[0];
  const t = (await app.inject(json('POST', '/api/app-passwords', { name: 'phone' }, anna))).json() as AppPasswordCreated;
  const annaBasic = { authorization: `Basic ${Buffer.from(`anna@example.com:${t.secret}`).toString('base64')}` };
  const root = await app.inject({ method: 'PROPFIND' as never, url: '/dav/', headers: { ...annaBasic, depth: '1' } });
  assert.deepEqual(hrefs(root.body), ['/dav/', '/dav/Media/']);
  assert.equal((await app.inject({ method: 'PROPFIND' as never, url: '/dav/Docs/', headers: annaBasic })).statusCode, 404);
});
