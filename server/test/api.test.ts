import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { parseRange } from '../src/routes/files.ts';
import type { Entry, Identity, Listing, Meta, User } from '../../shared/types.ts';

let base: string;
let app: FastifyInstance;
let admin = '';
let member = '';

const PW = 'correct horse battery';

function cfgWith(over: Partial<Config>): Config {
  return {
    ...config,
    staticDir: '',
    dbFile: ':memory:',
    adminEmail: '',
    adminPassword: '',
    locations: [
      { name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: ['.ssh'] },
      { name: 'Media', path: join(base, 'media'), mode: 'ro', hide: [] },
    ],
    accessAud: '',
    ...over,
  };
}

const json = (method: InjectOptions['method'], url: string, payload: unknown, cookie?: string): InjectOptions => ({
  method,
  url,
  payload: JSON.stringify(payload),
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
});
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-api-'));
  await mkdir(join(base, 'docs', '.ssh'), { recursive: true });
  await mkdir(join(base, 'docs', 'invoices'), { recursive: true });
  await mkdir(join(base, 'media'), { recursive: true });
  await writeFile(join(base, 'docs', '.ssh', 'id_ed25519'), 'PRIVATE');
  await writeFile(join(base, 'docs', '.hidden'), 'x');
  await writeFile(join(base, 'docs', 'readme.md'), '# hi\n');
  await writeFile(join(base, 'docs', 'invoices', 'faktura ż.pdf'), '%PDF-1.4 fake');
  await writeFile(join(base, 'media', 'a.jpg'), 'jpg');
  app = await createApp(cfgWith({}), { logger: false });
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('first run: setup creates the admin, then setup is closed', async () => {
  const meta = (await app.inject({ url: '/api/meta' })).json() as Meta;
  assert.equal(meta.setupRequired, true);
  assert.equal(meta.me, null);
  assert.equal((await app.inject({ url: '/api/locations' })).statusCode, 401);

  const weak = await app.inject(json('POST', '/api/setup', { email: 'a@b.c', name: 'A', password: 'short' }));
  assert.equal(weak.statusCode, 400);
  const res = await app.inject(json('POST', '/api/setup', { email: 'alex@example.com', name: 'Alex', password: PW }));
  assert.equal(res.statusCode, 200);
  const id = res.json() as Identity;
  assert.equal(id.role, 'admin');
  admin = cookieOf(res);
  assert.match(admin, /^mkdrive_session=/);
  assert.equal((await app.inject(json('POST', '/api/setup', { email: 'x@y.z', name: 'X', password: PW }))).statusCode, 403);
  const meta2 = (await app.inject({ url: '/api/meta', headers: { cookie: admin } })).json() as Meta;
  assert.equal(meta2.setupRequired, false);
  assert.equal(meta2.me?.email, 'alex@example.com');
});

test('the drive can be renamed by an admin; the name rides on meta; empty puts the default back', async () => {
  const before = (await app.inject({ url: '/api/meta', headers: { cookie: admin } })).json() as Meta;
  assert.equal(before.name, undefined);
  assert.equal((await app.inject(json('PUT', '/api/settings/name', { name: 'Home' }))).statusCode, 401);
  const ok = await app.inject(json('PUT', '/api/settings/name', { name: '  Family  drive ' }, admin));
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json(), { name: 'Family drive' });
  assert.equal(((await app.inject({ url: '/api/meta' })).json() as Meta).name, 'Family drive', 'visible before signing in too');
  assert.equal((await app.inject(json('PUT', '/api/settings/name', { name: 'x'.repeat(41) }, admin))).statusCode, 400);
  const reset = await app.inject(json('PUT', '/api/settings/name', { name: '' }, admin));
  assert.deepEqual(reset.json(), { name: null });
  assert.equal(((await app.inject({ url: '/api/meta' })).json() as Meta).name, undefined);
});

test('admin sees every location; listing rules; file streaming', async () => {
  const locs = (await app.inject({ url: '/api/locations', headers: { cookie: admin } })).json() as { name: string; access: string }[];
  assert.deepEqual(
    locs.map((l) => `${l.name}:${l.access}`),
    ['Docs:write', 'Media:read'],
  );
  const ls = (await app.inject({ url: '/api/ls?path=Docs', headers: { cookie: admin } })).json() as Listing;
  assert.deepEqual(
    ls.entries.map((e) => e.name),
    ['invoices', 'readme.md'],
  );
  assert.ok(ls.hiddenOmitted);
  const withHidden = (await app.inject({ url: '/api/ls?path=Docs&hidden=1', headers: { cookie: admin } })).json() as Listing;
  assert.deepEqual(
    withHidden.entries.map((e) => e.name),
    ['invoices', '.hidden', 'readme.md'],
  );
  assert.equal((await app.inject({ url: '/api/ls?path=Docs/.ssh', headers: { cookie: admin } })).statusCode, 404);
  // folders only: each folder says whether it has subfolders, hidden ones not counting
  await mkdir(join(base, 'docs', 'tree', 'branch', 'twig'), { recursive: true });
  await mkdir(join(base, 'docs', 'tree', 'leaf', '.git'), { recursive: true });
  await writeFile(join(base, 'docs', 'tree', 'leaf', 'note.txt'), 'x');
  const tree = (await app.inject({ url: '/api/ls?path=Docs/tree&dirs=1', headers: { cookie: admin } })).json() as Listing;
  assert.deepEqual(tree.entries.map((e) => [e.name, e.hasDirs]), [['branch', true], ['leaf', false]]);
  const withHiddenDirs = (await app.inject({ url: '/api/ls?path=Docs/tree&dirs=1&hidden=1', headers: { cookie: admin } })).json() as Listing;
  assert.equal(withHiddenDirs.entries.find((e) => e.name === 'leaf')?.hasDirs, true, 'with hidden shown, .git counts');
  assert.equal((await app.inject({ url: '/api/ls?path=Docs/tree', headers: { cookie: admin } })).json<Listing>().entries[0].hasDirs, undefined, 'plain listings do not pay for it');
  assert.equal((await app.inject({ url: '/api/file?path=Docs/.ssh/id_ed25519', headers: { cookie: admin } })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/ls?path=Docs/../etc', headers: { cookie: admin } })).statusCode, 400);

  const path = encodeURIComponent('Docs/invoices/faktura ż.pdf');
  const full = await app.inject({ url: `/api/file?path=${path}`, headers: { cookie: admin } });
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers['content-type'], 'application/pdf');
  assert.match(String(full.headers['content-disposition']), /^inline; filename="faktura _.pdf"; filename\*=UTF-8''faktura%20%C5%BC\.pdf$/);
  const part = await app.inject({ url: `/api/file?path=${path}`, headers: { cookie: admin, range: 'bytes=0-3' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.body, '%PDF');
  const cached = await app.inject({ url: `/api/file?path=${path}`, headers: { cookie: admin, 'if-none-match': String(full.headers['etag']) } });
  assert.equal(cached.statusCode, 304);
  assert.equal((await app.inject({ url: `/api/file?path=${path}`, headers: { cookie: admin, range: 'bytes=99-' } })).statusCode, 416);
});

test('members only see granted locations; grants are enforced on paths', async () => {
  const created = await app.inject(json('POST', '/api/users', { email: 'Anna@example.com', name: 'Anna', password: PW, grants: { Media: 'read' } }, admin));
  assert.equal(created.statusCode, 201);
  const anna = created.json() as User;
  assert.equal(anna.role, 'member');
  assert.deepEqual(anna.grants, { Media: 'read' });

  const login = await app.inject(json('POST', '/api/login', { email: 'anna@example.com', password: PW }));
  assert.equal(login.statusCode, 200, 'email is case-insensitive');
  member = cookieOf(login);

  const locs = (await app.inject({ url: '/api/locations', headers: { cookie: member } })).json() as { name: string }[];
  assert.deepEqual(
    locs.map((l) => l.name),
    ['Media'],
  );
  assert.equal((await app.inject({ url: '/api/ls?path=Media', headers: { cookie: member } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/ls?path=Docs', headers: { cookie: member } })).statusCode, 404, 'ungranted reads as not found');
  assert.equal((await app.inject({ url: '/api/users', headers: { cookie: member } })).statusCode, 403);

  // grant Docs, then it appears
  const patched = await app.inject(json('PATCH', `/api/users/${anna.id}`, { grants: { Media: 'read', Docs: 'write' } }, admin));
  assert.equal(patched.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/ls?path=Docs', headers: { cookie: member } })).statusCode, 200);

  // disabling kills the session
  await app.inject(json('PATCH', `/api/users/${anna.id}`, { disabled: true }, admin));
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: member } })).statusCode, 401);
  const again = await app.inject(json('POST', '/api/login', { email: 'anna@example.com', password: PW }));
  assert.equal(again.statusCode, 401, 'disabled users cannot log in');
});

test('login throttle, wrong password, sessions, logout', async () => {
  await new Promise((r) => setTimeout(r, 2100)); // the disabled-user attempt above counted against this address
  const wrong = await app.inject(json('POST', '/api/login', { email: 'alex@example.com', password: 'nope' }));
  assert.equal(wrong.statusCode, 401);
  const throttled = await app.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }));
  assert.equal(throttled.statusCode, 429);
  await new Promise((r) => setTimeout(r, Number(throttled.headers['retry-after']) * 1000 + 100));
  const ok = await app.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW }));
  assert.equal(ok.statusCode, 200);
  const second = cookieOf(ok);

  const sessions = (await app.inject({ url: '/api/sessions', headers: { cookie: second } })).json() as { current: boolean }[];
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((s) => s.current).length, 1);

  assert.equal((await app.inject(json('POST', '/api/sessions/revoke-others', {}, second))).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: admin } })).statusCode, 401, 'the first session is gone');
  admin = second;

  const out = await app.inject(json('POST', '/api/logout', {}, second));
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: second } })).statusCode, 401);
  admin = cookieOf(await app.inject(json('POST', '/api/login', { email: 'alex@example.com', password: PW })));
});

test('guards: last admin, self lock-out, cross-site, non-JSON', async () => {
  const me = (await app.inject({ url: '/api/me', headers: { cookie: admin } })).json() as Identity;
  assert.equal((await app.inject(json('PATCH', `/api/users/${me.id}`, { role: 'member' }, admin))).statusCode, 400);
  assert.equal((await app.inject(json('DELETE', `/api/users/${me.id}`, {}, admin))).statusCode, 400);
  const cross = await app.inject({
    ...json('POST', '/api/logout', {}, admin),
    headers: { 'content-type': 'application/json', cookie: admin, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(cross.statusCode, 403);
  const form = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: 'email=a&password=b',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.statusCode, 415);
  const audit = (await app.inject({ url: '/api/audit', headers: { cookie: admin } })).json() as { action: string }[];
  assert.ok(audit.some((a) => a.action === 'setup'));
  assert.ok(audit.some((a) => a.action === 'user.create'));
});

test('headless bootstrap from the environment', async () => {
  const boot = await createApp(cfgWith({ adminEmail: 'boot@example.com', adminPassword: PW }), { logger: false });
  const meta = (await boot.inject({ url: '/api/meta' })).json() as Meta;
  assert.equal(meta.setupRequired, false);
  const login = await boot.inject(json('POST', '/api/login', { email: 'boot@example.com', password: PW }));
  assert.equal(login.statusCode, 200);
  await boot.close();
});

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), null);
  assert.equal(parseRange(undefined, 100), undefined);
});

test('editing a text file in place: If-Match guards against a stale editor', async () => {
  const path = encodeURIComponent('Docs/readme.md');
  const before = (await app.inject({ url: `/api/file?path=${path}`, headers: { cookie: admin } })).headers['etag'] as string;
  const noMatch = await app.inject({
    method: 'PUT',
    url: `/api/file?path=${path}`,
    payload: '# changed\n',
    headers: { cookie: admin, 'content-type': 'application/octet-stream' },
  });
  assert.equal(noMatch.statusCode, 428);
  const stale = await app.inject({
    method: 'PUT',
    url: `/api/file?path=${path}`,
    payload: '# changed\n',
    headers: { cookie: admin, 'content-type': 'application/octet-stream', 'if-match': 'W/"nope"' },
  });
  assert.equal(stale.statusCode, 412);
  const ok = await app.inject({
    method: 'PUT',
    url: `/api/file?path=${path}`,
    payload: '# changed\n',
    headers: { cookie: admin, 'content-type': 'application/octet-stream', 'if-match': before },
  });
  assert.equal(ok.statusCode, 200);
  const saved = ok.json() as Entry;
  assert.equal(saved.size, 10);
  assert.notEqual(saved.etag, before);
  assert.equal((await app.inject({ url: `/api/file?path=${path}`, headers: { cookie: admin } })).body, '# changed\n');
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: `/api/file?path=${encodeURIComponent('Docs/invoices/faktura ż.pdf')}`,
        payload: 'x',
        headers: { cookie: admin, 'content-type': 'application/octet-stream', 'if-match': 'W/"x"' },
      })
    ).statusCode,
    415,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: `/api/file?path=Media/a.jpg`,
        payload: 'x',
        headers: { cookie: admin, 'content-type': 'application/octet-stream', 'if-match': 'W/"x"' },
      })
    ).statusCode,
    403,
    'read-only location',
  );
});
