import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { Users } from '../src/users.ts';
import { resetPassword } from '../src/cli.ts';

test('the CLI resets a password without the old one and leaves an audit row', async () => {
  const users = new Users(openDb(':memory:'));
  await users.create({ email: 'alex@example.com', name: 'Alex', role: 'admin', password: 'forgotten long ago' });
  await assert.rejects(resetPassword(users, 'nobody@example.com', 'a fresh long password'), /no account/);
  await assert.rejects(resetPassword(users, 'alex@example.com', 'short'), /at least/);
  await resetPassword(users, 'Alex@example.com', 'a fresh long password');
  assert.ok(await users.authenticate('alex@example.com', 'a fresh long password'));
  assert.equal(await users.authenticate('alex@example.com', 'forgotten long ago'), null);
  assert.ok(users.auditList(10).some((a) => a.action === 'password.reset' && a.detail === 'cli'));
});
