import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.ts';
import { config, type Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { beat, heartbeatUrl, readHeartbeat, writeHeartbeat } from '../src/heartbeat.ts';
import { Settings } from '../src/settings.ts';
import type { Heartbeat } from '../../shared/types.ts';

test('the address: http or https, nothing secret in front of the host, empty turns it off', () => {
  assert.equal(heartbeatUrl('https://hc.example.com/ping/abc'), 'https://hc.example.com/ping/abc');
  assert.equal(heartbeatUrl(' http://192.0.2.7:3001/api/push/xyz?status=up '), 'http://192.0.2.7:3001/api/push/xyz?status=up', 'a monitor on the LAN is fine');
  for (const off of ['', null, undefined]) assert.equal(heartbeatUrl(off), null);
  for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'not an address', 'https://user:pw@example.com/x', 42, 'https://example.com/' + 'x'.repeat(2000)])
    assert.throws(() => heartbeatUrl(bad), /url:/, String(bad));
});

test('a beat is one GET; what came back is remembered, and a failure is a result, not a throw', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-drive-beat-'));
  const db = openDb(join(dir, 'drive.db'));
  const settings = new Settings(db);
  const calls: { url: string; method?: string }[] = [];
  let answer: () => Response = () => new Response('OK');
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return answer();
  }) as typeof fetch;
  try {
    assert.deepEqual(await beat(settings, fetcher), { url: null, everyMinutes: 5, lastAt: null, lastOk: null, lastError: null });
    assert.equal(calls.length, 0, 'no address, no request');

    writeHeartbeat(settings, 'https://hc.example.com/ping/abc');
    const t = Date.parse('2026-11-11T12:00:00Z');
    assert.deepEqual(await beat(settings, fetcher, t), { url: 'https://hc.example.com/ping/abc', everyMinutes: 5, lastAt: '2026-11-11T12:00:00.000Z', lastOk: true, lastError: null });
    assert.deepEqual(calls, [{ url: 'https://hc.example.com/ping/abc', method: 'GET' }]);

    answer = () => new Response('gone', { status: 404 });
    assert.deepEqual([(await beat(settings, fetcher, t)).lastOk, readHeartbeat(settings).lastError], [false, 'answered 404']);
    answer = () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    };
    assert.equal((await beat(settings, fetcher, t)).lastError, 'ENOTFOUND');

    assert.equal(writeHeartbeat(settings, 'https://hc.example.com/ping/other').lastAt, null, 'a new address has no result yet');
    assert.deepEqual(writeHeartbeat(settings, ''), { url: null, everyMinutes: 5, lastAt: null, lastOk: null, lastError: null });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the route: admins from a real session; saving tries the address at once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-drive-beat-route-'));
  await mkdir(join(dir, 'docs'), { recursive: true });
  let hits = 0;
  const other = createServer((_req, res) => {
    hits++;
    res.end('OK');
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}/ping`;
  const PW = 'correct horse battery';
  const cfg: Config = { ...config, staticDir: '', dbFile: ':memory:', dataDir: join(dir, 'data'), adminEmail: 'alex@example.com', adminPassword: PW, accessAud: '', locations: [{ name: 'Docs', path: join(dir, 'docs'), mode: 'rw', hide: [] }] };
  const app: FastifyInstance = await createApp(cfg, { logger: false });
  const json = { 'content-type': 'application/json' };
  try {
    assert.equal((await app.inject({ url: '/api/heartbeat' })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: json, payload: { email: 'alex@example.com', password: PW } });
    const cookie = ([] as string[]).concat((login.headers['set-cookie'] as string | string[]) ?? [])[0].split(';')[0];
    assert.equal((await app.inject({ url: '/api/heartbeat', headers: { cookie } })).json<Heartbeat>().url, null);

    assert.equal((await app.inject({ method: 'PUT', url: '/api/heartbeat', headers: { cookie, ...json }, payload: { url: 'file:///etc/passwd' } })).statusCode, 400);
    const set = await app.inject({ method: 'PUT', url: '/api/heartbeat', headers: { cookie, ...json }, payload: { url } });
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual([set.json<Heartbeat>().url, set.json<Heartbeat>().lastOk], [url, true]);
    assert.equal(hits, 1, 'tried as it was saved');

    const off = await app.inject({ method: 'PUT', url: '/api/heartbeat', headers: { cookie, ...json }, payload: { url: '' } });
    assert.equal(off.json<Heartbeat>().url, null);
    assert.equal(hits, 1);
  } finally {
    await app.close();
    await new Promise((r) => other.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
