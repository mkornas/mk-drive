import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { AppPasswordCreated, Connector, Listing, Location, TrashEntry } from '../../shared/types.ts';

const PW = 'correct horse battery';
let base: string;
let app: FastifyInstance; // the drive under test
let remote: FastifyInstance; // a second mk-drive, reached over WebDAV
let s3: FastifyInstance; // a tiny S3 stand-in
let admin = '';
let remoteUrl = '';
let s3Url = '';

const json = (method: InjectOptions['method'], url: string, payload: unknown, cookie: string): InjectOptions => ({
  method,
  url,
  payload: JSON.stringify(payload),
  headers: { 'content-type': 'application/json', cookie },
});
const login = async (a: FastifyInstance) =>
  String((await a.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }, ''))).headers['set-cookie']).split(';')[0];
const cfgFor = (dir: string, extra: Partial<Config> = {}): Config => ({
  ...config,
  staticDir: '',
  dbFile: ':memory:',
  dataDir: dir,
  thumbDir: join(dir, 'thumbs'),
  adminEmail: 'alex@example.com',
  adminPassword: PW,
  locations: [{ name: 'Docs', path: join(dir, 'docs'), mode: 'rw', hide: [] }],
  accessAud: '',
  ...extra,
});

/** Just enough S3 to be a location: objects in a Map, ListObjectsV2 with prefix/delimiter, HEAD/GET/PUT/DELETE, copy. Signatures are accepted, not checked. */
function fakeS3(): FastifyInstance {
  const objects = new Map<string, { body: Buffer; mtime: number }>();
  const f = Fastify({ logger: false });
  f.removeAllContentTypeParsers();
  f.addContentTypeParser('*', { parseAs: 'buffer' }, (_r, body, done) => done(null, body));
  const keyOf = (url: string) => decodeURIComponent(url.split('?')[0].replace(/^\/bucket\/?/, ''));
  f.route({
    method: ['GET', 'HEAD', 'PUT', 'DELETE'],
    url: '/bucket',
    handler: async (req, reply) => {
      const q = req.query as Record<string, string>;
      const prefix = q.prefix ?? '';
      const delim = q.delimiter;
      const contents: string[] = [];
      const prefixes = new Set<string>();
      for (const [key, o] of [...objects.entries()].sort()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (delim && rest.includes(delim)) prefixes.add(prefix + rest.slice(0, rest.indexOf(delim) + 1));
        else
          contents.push(`<Contents><Key>${key}</Key><Size>${o.body.length}</Size><LastModified>${new Date(o.mtime).toISOString()}</LastModified></Contents>`);
      }
      return reply
        .type('application/xml')
        .send(
          `<ListBucketResult><IsTruncated>false</IsTruncated>${contents.join('')}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`,
        );
    },
  });
  f.route({
    method: ['GET', 'HEAD', 'PUT', 'DELETE'],
    url: '/bucket/*',
    handler: async (req, reply) => {
      const key = keyOf(req.url);
      const o = objects.get(key);
      if (req.method === 'PUT') {
        const src = req.headers['x-amz-copy-source'] as string | undefined;
        if (src) {
          const from = objects.get(decodeURIComponent(src.replace(/^\/bucket\//, '')));
          if (!from) return reply.code(404).send();
          objects.set(key, { body: from.body, mtime: Date.now() });
        } else objects.set(key, { body: (req.body as Buffer) ?? Buffer.alloc(0), mtime: Date.now() });
        return reply.code(200).send();
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return reply.code(204).send();
      }
      if (!o) return reply.code(404).send();
      reply.header('content-length', String(o.body.length)).header('last-modified', new Date(o.mtime).toUTCString());
      if (req.method === 'HEAD') return reply.send();
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range) {
        const s = Number(range[1]);
        const e = range[2] ? Number(range[2]) : o.body.length - 1;
        return reply
          .code(206)
          .header('content-length', String(e - s + 1))
          .send(o.body.subarray(s, e + 1));
      }
      return reply.send(o.body);
    },
  });
  return f;
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-conn-'));
  await mkdir(join(base, 'docs'), { recursive: true });
  await mkdir(join(base, 'remote', 'docs', 'notes'), { recursive: true });
  await writeFile(join(base, 'remote', 'docs', 'hello.txt'), 'hello from afar');
  await writeFile(join(base, 'remote', 'docs', 'notes', 'todo.md'), '- milk');
  remote = await createApp(cfgFor(join(base, 'remote')), { logger: false });
  await remote.listen({ port: 0, host: '127.0.0.1' });
  remoteUrl = `http://127.0.0.1:${(remote.server.address() as { port: number }).port}/dav/Docs/`;
  s3 = fakeS3();
  await s3.listen({ port: 0, host: '127.0.0.1' });
  s3Url = `http://127.0.0.1:${(s3.server.address() as { port: number }).port}`;
  app = await createApp(cfgFor(base), { logger: false });
  admin = await login(app);
});
after(async () => {
  await Promise.all([app?.close(), remote?.close(), s3?.close()]);
  await rm(base, { recursive: true, force: true });
});

let davPassword = '';

test('adding a WebDAV connector: validated, tested, then a location like any other', async () => {
  const remoteAdmin = await login(remote);
  davPassword = ((await remote.inject(json('POST', '/api/app-passwords', { name: 'drive' }, remoteAdmin))).json() as AppPasswordCreated).secret;
  assert.equal((await app.inject(json('POST', '/api/connectors', { name: 'Cloud', type: 'webdav', config: { url: 'not a url' } }, admin))).statusCode, 400);
  const bad = await app.inject(
    json('POST', '/api/connectors', { name: 'Cloud', type: 'webdav', config: { url: remoteUrl, username: 'alex@example.com', password: 'wrong' } }, admin),
  );
  assert.equal(bad.statusCode, 400, 'a refused connection is not saved');
  assert.match(bad.json().message, /could not connect: the server refused/);
  await new Promise((r) => setTimeout(r, 1100)); // the remote throttles the address after a bad secret
  const ok = await app.inject(
    json(
      'POST',
      '/api/connectors',
      { name: 'Cloud', type: 'webdav', icon: 'cloud', config: { url: remoteUrl, username: 'alex@example.com', password: davPassword } },
      admin,
    ),
  );
  assert.equal(ok.statusCode, 201);
  const c = ok.json() as Connector;
  assert.deepEqual(c.config, { url: remoteUrl, username: 'alex@example.com' }, 'no secret comes back');
  assert.equal(
    (await app.inject(json('POST', '/api/connectors', { name: 'Cloud', type: 'webdav', config: { url: remoteUrl } }, admin))).statusCode,
    400,
    'names are unique',
  );
  const locs = (await app.inject({ url: '/api/locations', headers: { cookie: admin } })).json() as Location[];
  assert.deepEqual(
    locs.map((l) => `${l.name}:${l.source}:${l.access}`),
    ['Docs:mount:write', 'Cloud:webdav:write'],
  );
});

test('a WebDAV location: list, read, write through the upload API, folders, rename, trash', async () => {
  const ls = (await app.inject({ url: '/api/ls?path=Cloud', headers: { cookie: admin } })).json() as Listing;
  assert.deepEqual(
    ls.entries.map((e) => `${e.name}:${e.kind}:${e.size}`),
    ['notes:dir:0', 'hello.txt:file:15'],
  );
  assert.equal((await app.inject({ url: '/api/file?path=Cloud/hello.txt', headers: { cookie: admin } })).body, 'hello from afar');
  assert.equal((await app.inject({ url: '/api/file?path=Cloud/hello.txt', headers: { cookie: admin, range: 'bytes=6-9' } })).body, 'from');
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Cloud', name: 'photos' }, admin))).statusCode, 200);
  const begin = (await app.inject(json('POST', '/api/uploads', { dir: 'Cloud/photos', name: 'a.txt', size: 5 }, admin))).json() as { id: string };
  const piece = await app.inject({
    method: 'PATCH',
    url: `/api/uploads/${begin.id}`,
    payload: Buffer.from('abcde'),
    headers: { cookie: admin, 'content-type': 'application/octet-stream', 'upload-offset': '0' },
  });
  assert.equal(piece.statusCode, 200);
  assert.equal((await app.inject(json('POST', `/api/uploads/${begin.id}/complete`, {}, admin))).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/file?path=Cloud/photos/a.txt', headers: { cookie: admin } })).body, 'abcde');
  assert.equal((await app.inject(json('POST', '/api/rename', { path: 'Cloud/photos/a.txt', name: 'b.txt' }, admin))).statusCode, 200);
  // this remote is another mk-drive, which hides .mk-drive — so it cannot hold our trash; the delete must say so, not delete for good
  const del = await app.inject(json('POST', '/api/delete', { paths: ['Cloud/photos/b.txt'] }, admin));
  assert.equal(del.statusCode, 200);
  const [first] = del.json() as { ok: boolean; error?: string }[];
  assert.equal(first.ok, false);
  assert.match(String(first.error), /cannot keep a trash folder/);
  assert.equal((await app.inject({ url: '/api/file?path=Cloud/photos/b.txt', headers: { cookie: admin } })).body, 'abcde', 'still there');
});

test('an S3 connector: folders are prefixes, uploads spool locally, copies and moves are key copies', async () => {
  const res = await app.inject(
    json(
      'POST',
      '/api/connectors',
      { name: 'Bucket', type: 's3', config: { endpoint: s3Url, bucket: 'bucket', prefix: 'drive', accessKey: 'AK', secretKey: 'SK' } },
      admin,
    ),
  );
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((await app.inject({ url: '/api/ls?path=Bucket', headers: { cookie: admin } })).json().entries.length, 0);
  assert.equal((await app.inject(json('POST', '/api/mkdir', { path: 'Bucket', name: 'photos' }, admin))).statusCode, 200);
  const begin = (await app.inject(json('POST', '/api/uploads', { dir: 'Bucket/photos', name: 'cat.txt', size: 3 }, admin))).json() as { id: string };
  await app.inject({
    method: 'PATCH',
    url: `/api/uploads/${begin.id}`,
    payload: Buffer.from('meo'),
    headers: { cookie: admin, 'content-type': 'application/octet-stream', 'upload-offset': '0' },
  });
  assert.equal((await app.inject(json('POST', `/api/uploads/${begin.id}/complete`, {}, admin))).statusCode, 200);
  const ls = (await app.inject({ url: '/api/ls?path=Bucket', headers: { cookie: admin } })).json() as Listing;
  assert.deepEqual(
    ls.entries.map((e) => `${e.name}:${e.kind}`),
    ['photos:dir'],
  );
  assert.deepEqual(
    ((await app.inject({ url: '/api/ls?path=Bucket/photos', headers: { cookie: admin } })).json() as Listing).entries.map((e) => `${e.name}:${e.size}`),
    ['cat.txt:3'],
  );
  assert.equal((await app.inject({ url: '/api/file?path=Bucket/photos/cat.txt', headers: { cookie: admin, range: 'bytes=1-2' } })).body, 'eo');
  assert.equal((await app.inject(json('POST', '/api/copy', { paths: ['Bucket/photos'], to: 'Bucket', onConflict: 'rename' }, admin))).statusCode, 200);
  assert.equal((await app.inject(json('POST', '/api/rename', { path: 'Bucket/photos', name: 'pictures' }, admin))).statusCode, 200);
  const after = (await app.inject({ url: '/api/ls?path=Bucket', headers: { cookie: admin } })).json() as Listing;
  assert.deepEqual(after.entries.map((e) => e.name).sort(), ['photos (2)', 'pictures']);
  assert.equal((await app.inject({ url: '/api/file?path=Bucket/pictures/cat.txt', headers: { cookie: admin } })).body, 'meo');
  assert.equal((await app.inject(json('POST', '/api/delete', { paths: ['Bucket/pictures'] }, admin))).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/ls?path=Bucket', headers: { cookie: admin } })).json().entries.length, 1);
  // the trash is a prefix in the bucket; restore brings the folder back
  const trash = (await app.inject({ url: '/api/trash?location=Bucket', headers: { cookie: admin } })).json() as TrashEntry[];
  assert.deepEqual(
    trash.map((t) => [t.original, t.kind]),
    [['Bucket/pictures', 'dir']],
  );
  assert.equal((await app.inject(json('POST', `/api/trash/${trash[0].id}/restore`, {}, admin))).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/file?path=Bucket/pictures/cat.txt', headers: { cookie: admin } })).body, 'meo');
});

test('a connector whose remote refuses it shows an error on its row; the other locations stay up', async () => {
  const remoteAdmin = await login(remote);
  const tokens = (await remote.inject({ url: '/api/app-passwords', headers: { cookie: remoteAdmin } })).json() as { id: number }[];
  for (const t of tokens) await remote.inject({ method: 'DELETE', url: `/api/app-passwords/${t.id}`, headers: { cookie: remoteAdmin } });
  const res = await app.inject({ url: '/api/locations', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  const locs = res.json() as Location[];
  assert.equal(locs.find((l) => l.name === 'Docs')?.error, undefined);
  assert.match(String(locs.find((l) => l.name === 'Cloud')?.error), /refused the credentials/);
  assert.equal((await app.inject({ url: '/api/ls?path=Cloud', headers: { cookie: admin } })).statusCode, 500, 'inside it, the failure surfaces per request');
});

test('removing a connector drops the location and its grants; members never saw the admin page', async () => {
  const anna = await app.inject(json('POST', '/api/users', { email: 'anna@example.com', name: 'Anna', password: PW, grants: { Cloud: 'read' } }, admin));
  assert.equal(anna.statusCode, 201);
  const annaCookie = String((await app.inject(json('POST', '/api/login', { email: 'anna@example.com', password: PW }, ''))).headers['set-cookie']).split(
    ';',
  )[0];
  assert.equal((await app.inject({ url: '/api/connectors', headers: { cookie: annaCookie } })).statusCode, 403);
  assert.equal(((await app.inject({ url: '/api/locations', headers: { cookie: annaCookie } })).json() as Location[]).map((l) => l.name).join(), 'Cloud');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/connectors/Cloud', headers: { cookie: admin } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/ls?path=Cloud', headers: { cookie: admin } })).statusCode, 404);
  assert.deepEqual((await app.inject({ url: '/api/locations', headers: { cookie: annaCookie } })).json(), []);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/connectors/Cloud', headers: { cookie: admin } })).statusCode, 404);
});
