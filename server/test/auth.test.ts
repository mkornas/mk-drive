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
