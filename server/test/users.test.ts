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

test('authenticate: no account, a disabled one and a wrong password all cost one scrypt, so the time does not say which emails exist', async () => {
  const users = new Users(openDb(':memory:'));
  await users.create({ email: 'real@example.com', name: 'Real', role: 'admin', password: 'correct horse battery' });
  const off = await users.create({ email: 'off@example.com', name: 'Off', role: 'member', password: 'correct horse battery' });
  users.update(off.id, { disabled: true });
  assert.equal((await users.authenticate('real@example.com', 'correct horse battery'))?.email, 'real@example.com');
  assert.equal(await users.authenticate('off@example.com', 'correct horse battery'), null, 'disabled stays refused with the right password');
  assert.equal(await users.authenticate('nobody@example.com', 'correct horse battery'), null);
  const time = async (email: string) => {
    const t = performance.now();
    for (let i = 0; i < 3; i++) await users.authenticate(email, 'a wrong password');
    return performance.now() - t;
  };
  const known = await time('real@example.com');
  // before: 0 ms against ~60 ms. Half is a wide margin for a busy machine
  assert.ok((await time('nobody@example.com')) > known / 2, 'no account answers as slowly as a wrong password');
  assert.ok((await time('off@example.com')) > known / 2, 'a disabled account too');
});
