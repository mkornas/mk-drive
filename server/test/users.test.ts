import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { grantLevel, hashPassword, Users, verifyPassword } from '../src/users.ts';

test('password hashing round-trips and rejects the wrong password', async () => {
  const h = await hashPassword('hunter2hunter2');
  assert.match(h, /^scrypt\$/);
  assert.ok(await verifyPassword('hunter2hunter2', h));
  assert.ok(!(await verifyPassword('hunter2hunter3', h)));
  assert.ok(!(await verifyPassword('x', 'garbage')));
});

test('sessions expire, survive reopening, and die with the user', async () => {
  const users = new Users(openDb(':memory:'));
  const u = await users.create({ email: 'a@b.c', name: 'A', role: 'member', password: 'passwordpassword' });
  const s = users.createSession(u.id, 10);
  assert.ok(users.session(s.id));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(users.session(s.id), null, 'expired');
  const s2 = users.createSession(u.id, 60_000);
  users.remove(u.id);
  assert.equal(users.session(s2.id), null, 'cascade');
});

test('grants: admins get everything, members only what they were given', async () => {
  const users = new Users(openDb(':memory:'));
  const a = await users.create({ email: 'admin@b.c', name: 'A', role: 'admin', password: 'passwordpassword' });
  const m = await users.create({ email: 'm@b.c', name: 'M', role: 'member', password: 'passwordpassword', grants: { Docs: 'read' } });
  assert.equal(grantLevel(a, 'Anything'), 'write');
  assert.equal(grantLevel(m, 'Docs'), 'read');
  assert.equal(grantLevel(m, 'Media'), 'none');
  users.setGrants(m.id, { Media: 'write' });
  assert.deepEqual(users.get(m.id)!.grants, { Media: 'write' });
});
