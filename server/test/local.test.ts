import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalProvider } from '../src/storage/local.ts';

let base: string;
let root: string;

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-'));
  root = join(base, 'root');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'hello.txt'), 'hello world');
  await writeFile(join(root, 'sub', 'a.json'), '{}');
  await writeFile(join(base, 'outside.txt'), 'secret');
  await symlink(join(base, 'outside.txt'), join(root, 'escape'));
  await symlink(join(root, 'sub'), join(root, 'inside'));
});
after(() => rm(base, { recursive: true, force: true }));

test('list: files and dirs, symlink out of root omitted, symlink inside kept', async () => {
  const p = new LocalProvider(root);
  const names = (await p.list([])).map((e) => `${e.kind}:${e.name}`).sort();
  assert.deepEqual(names, ['dir:inside', 'dir:sub', 'file:hello.txt']);
});

test('list dirsOnly skips files without stat', async () => {
  const p = new LocalProvider(root);
  const names = (await p.list([], { dirsOnly: true })).map((e) => e.name).sort();
  assert.deepEqual(names, ['inside', 'sub']);
});

test('stat + resolve refuse to leave the root', async () => {
  const p = new LocalProvider(root);
  assert.equal(await p.stat(['escape']), null);
  assert.equal(await p.resolve(['..', 'outside.txt']), null);
  assert.equal(await p.stat(['nope']), null);
  const s = await p.stat(['hello.txt']);
  assert.equal(s?.kind, 'file');
  assert.equal(s?.size, 11);
});

test('read: whole file and a byte range', async () => {
  const p = new LocalProvider(root);
  const whole = await text(await p.read(['hello.txt']));
  assert.equal(whole, 'hello world');
  const part = await text(await p.read(['hello.txt'], { start: 6, end: 10 }));
  assert.equal(part, 'world');
});

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk.toString();
  return out;
}
