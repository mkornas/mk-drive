import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDrivePath, parentDrivePath } from '../src/paths.ts';

test('parseDrivePath: normalises slashes', () => {
  const p = parseDrivePath('/Docs//a/b/');
  assert.equal(p.location, 'Docs');
  assert.deepEqual(p.segments, ['a', 'b']);
  assert.equal(p.path, 'Docs/a/b');
});

test('parseDrivePath: location alone is the root', () => {
  const p = parseDrivePath('Docs');
  assert.deepEqual(p.segments, []);
  assert.equal(parentDrivePath(p), null);
  assert.equal(parentDrivePath(parseDrivePath('Docs/a/b')), 'Docs/a');
});

test('parseDrivePath: rejects traversal and junk', () => {
  for (const bad of ['', '/', 'Docs/..', 'Docs/../etc', 'Docs/./x', 'Docs/a\0b', 'Docs/a\\b', undefined]) {
    assert.throws(() => parseDrivePath(bad), /path/, `should reject ${JSON.stringify(bad)}`);
  }
});
