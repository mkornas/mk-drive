import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipInCidr, isLocalRequest, LoginThrottle, resolvePasswordLogin } from '../src/auth.ts';

test('cidr matching', () => {
  assert.ok(ipInCidr('192.168.1.11', '192.168.0.0/16'));
  assert.ok(!ipInCidr('10.0.0.1', '192.168.0.0/16'));
  assert.ok(ipInCidr('::ffff:127.0.0.1', '127.0.0.0/8'));
  assert.ok(ipInCidr('::1', '::1/128'));
});

test('throttle backs off after failures and resets on success', () => {
  const t = new LoginThrottle();
  assert.equal(t.retryAfter('1.2.3.4', 0), 0);
  t.failed('1.2.3.4', 0);
  assert.equal(t.retryAfter('1.2.3.4', 500), 500);
  t.failed('1.2.3.4', 1000);
  assert.equal(t.retryAfter('1.2.3.4', 1000), 2000);
  t.succeeded('1.2.3.4');
  assert.equal(t.retryAfter('1.2.3.4', 1000), 0);
});

test('throttle: one attempt per key at a time, failures forgotten after a quiet spell, a bounded map', () => {
  const t = new LoginThrottle(3);
  assert.equal(t.begin(['ip', 'email:a'], 0), 0);
  assert.ok(t.begin(['ip2', 'email:a'], 0) > 0, 'a second attempt on a key in flight waits');
  t.failed('ip', 0);
  t.failed('email:a', 0);
  t.end(['ip', 'email:a']);
  assert.equal(t.begin(['ip3', 'email:b'], 0), 0, 'other keys are free');
  t.end(['ip3', 'email:b']);
  assert.equal(t.retryAfter('email:a', 500), 500);

  t.failed('x', 0);
  t.failed('x', 1000);
  t.failed('x', 60 * 60_000);
  assert.equal(t.retryAfter('x', 60 * 60_000), 1000, 'an hour later the count starts over');

  for (const k of ['k1', 'k2', 'k3', 'k4']) t.failed(k, 60 * 60_000);
  assert.equal(t.retryAfter('k1', 60 * 60_000), 0, 'the oldest key is dropped past the cap');
  assert.ok(t.retryAfter('k4', 60 * 60_000) > 0);
});

test('isLocalRequest: loopback, private and link-local only; headers believed only from a trusted proxy; never through Cloudflare', () => {
  const trusted = ['127.0.0.0/8', '::1/128', '172.31.88.1/32'];
  const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as never;
  for (const ip of [
    '127.0.0.1',
    '::1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.7',
    '169.254.1.1',
    'fd12::1',
    'fe80::1',
    '::ffff:192.168.1.7',
    '::ffff:127.0.0.1',
  ])
    assert.ok(isLocalRequest(req(ip), trusted), ip);
  for (const ip of ['203.0.113.5', '100.64.0.1', '100.127.255.254', '172.32.0.1', '11.0.0.1', '2001:db8::1', '::ffff:203.0.113.5', ''])
    assert.ok(!isLocalRequest(req(ip), trusted), ip || 'no address');

  // a trusted proxy (a local reverse proxy) passes the real address on, either way
  assert.ok(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.7' }), trusted));
  assert.ok(!isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.4, 127.0.0.1' }), trusted));
  // spoofing: an untrusted peer's headers are ignored, its socket address decides
  assert.ok(!isLocalRequest(req('203.0.113.5', { 'x-forwarded-for': '192.168.1.7' }), trusted));
  assert.ok(isLocalRequest(req('192.168.1.9', { 'x-forwarded-for': '198.51.100.4' }), trusted), 'a LAN client naming a public address is still on the LAN');
  assert.ok(!isLocalRequest(req('203.0.113.5', { 'cf-connecting-ip': '10.0.0.1' }), trusted));
  // through Cloudflare: never local, whatever address the header names and whether or not the connector is trusted
  assert.ok(!isLocalRequest(req('172.31.88.1', { 'cf-connecting-ip': '198.51.100.4' }), trusted));
  assert.ok(!isLocalRequest(req('172.31.88.1', { 'cf-connecting-ip': '192.168.1.7' }), trusted));
  assert.ok(!isLocalRequest(req('172.18.0.1', { 'cf-connecting-ip': '192.168.1.7' }), trusted), 'a tunnel missing from the trusted proxies');
  assert.ok(!isLocalRequest(req('127.0.0.1', { 'cf-ray': '8f00000000000000-WAW' }), trusted));
});

test('resolvePasswordLogin: the environment, else the saved choice, else on', () => {
  const saved = (v: string | null) => ({ get: () => v }) as never;
  assert.deepEqual(resolvePasswordLogin({ passwordLogin: 'off' }, saved('local')), { mode: 'off', source: 'env' });
  assert.deepEqual(resolvePasswordLogin({ passwordLogin: '' }, saved('local')), { mode: 'local', source: 'settings' });
  assert.deepEqual(resolvePasswordLogin({ passwordLogin: '' }, saved('nonsense')), { mode: 'on', source: 'settings' });
  assert.deepEqual(resolvePasswordLogin({ passwordLogin: '' }, null), { mode: 'on', source: 'settings' });
});
