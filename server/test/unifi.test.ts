import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { Settings } from '../src/settings.ts';
import { apiKey, consoleUrl, Unifi } from '../src/unifi.ts';

const KEY = 'k'.repeat(32);

/** A console as the drive sees it: its own certificate, the key in a header, pages of sites and clients. */
async function fakeConsole(dir: string, name: string, seen: string[]): Promise<{ server: Server; url: string }> {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=unifi.local', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`)], { stdio: 'ignore' });
  const clients = [
    { type: 'WIRED', id: 'a', name: 'Workstation', ipAddress: '192.0.2.20' },
    { type: 'WIRELESS', id: 'b', name: ' Alex’s phone ', ipAddress: '192.0.2.21' },
    { type: 'WIRED', id: 'c', name: '', ipAddress: '192.0.2.22' },
    { type: 'VPN', id: 'd', name: 'No address' },
  ];
  const server = createServer({ key: await readFile(join(dir, `${name}.key`)), cert: await readFile(join(dir, `${name}.crt`)) }, (req, res) => {
    seen.push(`${name} ${req.headers['x-api-key']} ${req.url}`);
    const u = new URL(req.url ?? '/', 'https://x');
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers['x-api-key'] !== KEY) return json(401, { error: { code: 401, message: 'Unauthorized' } });
    const page = (data: unknown[]) => {
      const offset = Number(u.searchParams.get('offset'));
      // two at a time, whatever was asked: the reader has to follow the pages
      const slice = data.slice(offset, offset + 2);
      json(200, { offset, limit: 2, count: slice.length, totalCount: data.length, data: slice });
    };
    if (u.pathname === '/proxy/network/integration/v1/sites') return page([{ id: 'site-1', internalReference: 'default', name: 'Home' }]);
    if (u.pathname === '/proxy/network/integration/v1/sites/site-1/clients') return page(clients);
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `https://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('the address is the console itself over https; a key looks like a key', () => {
  assert.equal(consoleUrl('192.0.2.1'), 'https://192.0.2.1');
  assert.equal(consoleUrl(' https://unifi.example.com:8443/network/default/dashboard '), 'https://unifi.example.com:8443');
  for (const bad of ['http://192.0.2.1', 'https://admin:pw@192.0.2.1', '', 42, 'ftp://x']) assert.throws(() => consoleUrl(bad), /url:/, String(bad));
  assert.equal(apiKey(` ${KEY} `), KEY);
  for (const bad of ['short', 'has spaces in the middle of it', 'line\nbreak-line-break-line', undefined]) assert.throws(() => apiKey(bad), /key:/);
});

test('names by address from a console with its own certificate; the key goes only to the certificate that was saved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-drive-unifi-'));
  const db = openDb(join(dir, 'drive.db'));
  const settings = new Settings(db);
  const seen: string[] = [];
  const first = await fakeConsole(dir, 'first', seen);
  let second: { server: Server; url: string } | null = null;
  try {
    const unifi = new Unifi(settings);
    assert.deepEqual(unifi.read(), { url: null, hasKey: false, fingerprint: null, sites: [], clients: null, lastAt: null, lastOk: null, lastError: null });
    assert.deepEqual(await unifi.names(), new Map(), 'not set up: no names, no request');

    await assert.rejects(unifi.save({ url: first.url, key: 'x'.repeat(32) }), /refused the API key/);
    assert.equal(unifi.read().url, null, 'nothing is saved until the console answered');
    await assert.rejects(unifi.save({ url: first.url }), /an API key from the console is needed/);

    const t0 = Date.parse('2026-11-11T12:00:00Z');
    const state = await unifi.save({ url: first.url, key: KEY }, t0);
    assert.equal(state.url, first.url);
    assert.equal(state.hasKey, true);
    assert.match(state.fingerprint ?? '', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'the certificate it showed is pinned');
    assert.deepEqual([state.sites, state.clients, state.lastOk], [['Home'], 2, true]);
    assert.ok(!JSON.stringify(state).includes(KEY), 'the key is never sent back');

    const names = await unifi.names(t0 + 1000);
    assert.deepEqual([...names], [['192.0.2.20', 'Workstation'], ['192.0.2.21', 'Alex’s phone']], 'no name or no address: left out');
    const before = seen.length;
    await unifi.names(t0 + 30_000);
    assert.equal(seen.length, before, 'asked at most once a minute');
    await unifi.names(t0 + 61_000);
    assert.ok(seen.length > before);

    // the same address, another certificate: someone else answering, or a console that was reset
    const port = Number(new URL(first.url).port);
    await new Promise((r) => first.server.close(r));
    seen.length = 0;
    const key2 = await fakeConsole(dir, 'second', seen);
    await new Promise((r) => key2.server.close(r));
    second = { server: createServer({ key: await readFile(join(dir, 'second.key')), cert: await readFile(join(dir, 'second.crt')) }, (req, res) => (seen.push(`second ${req.headers['x-api-key']}`), res.end('{}'))), url: first.url };
    await new Promise<void>((r) => second!.server.listen(port, '127.0.0.1', r));
    assert.deepEqual([...(await unifi.names(t0 + 200_000))], [...names], 'the last list stays in use');
    assert.deepEqual(seen, [], 'the key was not sent to the other certificate');
    assert.match(unifi.read().lastError ?? '', /certificate is not the one that was saved/);
    assert.equal(unifi.read().lastOk, false);

    assert.deepEqual(unifi.remove(), { url: null, hasKey: false, fingerprint: null, sites: [], clients: null, lastAt: null, lastOk: null, lastError: null });
    assert.deepEqual(await unifi.names(), new Map());
  } finally {
    db.close();
    first.server.close();
    second?.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
