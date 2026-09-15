import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { detectVideo } from '../src/thumbs.ts';
import type { Listing } from '../../shared/types.ts';

const PW = 'correct horse battery';
let base: string;
let app: FastifyInstance;
let admin = '';

const cfgWith = (ffmpeg: string): Config => ({
  ...config,
  staticDir: '',
  dbFile: ':memory:',
  thumbDir: join(base, 'thumbs'),
  thumbCacheMb: 1,
  adminEmail: 'alex@example.com',
  adminPassword: PW,
  locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }],
  accessAud: '',
  ffmpeg,
});

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-video-'));
  await mkdir(join(base, 'docs'), { recursive: true });
  await writeFile(join(base, 'docs', 'clip.mp4'), 'not really a video');
  // a stand-in ffmpeg: answers -version, and for anything else prints a PNG frame to stdout
  await writeFile(
    join(base, 'frame.png'),
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#0e7c7b' } })
      .png()
      .toBuffer(),
  );
  await writeFile(join(base, 'ffmpeg'), `#!/bin/sh\ncase "$1" in -version) echo "ffmpeg version 7.1-fake"; exit 0;; esac\ncat "${join(base, 'frame.png')}"\n`);
  await chmod(join(base, 'ffmpeg'), 0o755);
});
after(async () => {
  await app?.close();
  await rm(base, { recursive: true, force: true });
});

test('without ffmpeg a video is just a file', async () => {
  app = await createApp(cfgWith(join(base, 'no-such-ffmpeg')), { logger: false });
  admin = String(
    (
      await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: JSON.stringify({ email: 'alex@example.com', password: PW }),
        headers: { 'content-type': 'application/json' },
      })
    ).headers['set-cookie'],
  ).split(';')[0];
  const ls = (await app.inject({ url: '/api/ls?path=Docs', headers: { cookie: admin } })).json() as Listing;
  assert.equal(ls.entries[0].thumb, undefined);
  assert.equal((await app.inject({ url: '/api/thumb?path=Docs/clip.mp4', headers: { cookie: admin } })).statusCode, 415);
  await app.close();
});

test('with ffmpeg the listing advertises a thumbnail and /api/thumb serves the poster frame', async () => {
  assert.match((await detectVideo(join(base, 'ffmpeg'))) ?? '', /7\.1-fake/);
  app = await createApp(cfgWith(join(base, 'ffmpeg')), { logger: false });
  admin = String(
    (
      await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: JSON.stringify({ email: 'alex@example.com', password: PW }),
        headers: { 'content-type': 'application/json' },
      })
    ).headers['set-cookie'],
  ).split(';')[0];
  const ls = (await app.inject({ url: '/api/ls?path=Docs', headers: { cookie: admin } })).json() as Listing;
  assert.equal(ls.entries[0].thumb, true);
  const res = await app.inject({ url: '/api/thumb?path=Docs/clip.mp4&w=160', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  const meta = await sharp(res.rawPayload).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 160);
});
