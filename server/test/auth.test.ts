import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipInCidr, LoginThrottle } from '../src/auth.ts';

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
