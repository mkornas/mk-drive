import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { detectPdf } from '../src/thumbs.ts';
import type { Listing } from '../../shared/types.ts';

const PW = 'correct horse battery';
/** A complete one-page PDF with a filled rectangle — small enough to write by hand. */
const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >> endobj
4 0 obj << /Length 44 >> stream
0.1 0.5 0.5 rg 20 20 160 260 re f
endstream
endobj
trailer << /Root 1 0 R >>
`;
let base: string;
let app: FastifyInstance | null = null;
let admin = '';

const cfgWith = (pdftocairo: string): Config => ({
  ...config,
  staticDir: '',
  dbFile: ':memory:',
  thumbDir: join(base, 'thumbs'),
  thumbCacheMb: 1,
  adminEmail: 'alex@example.com',
  adminPassword: PW,
  locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: [] }],
  accessAud: '',
  ffmpeg: join(base, 'no-ffmpeg'),
  pdftocairo,
});
const login = async (a: FastifyInstance) =>
  String(
    (
      await a.inject({
        method: 'POST',
        url: '/api/login',
        payload: JSON.stringify({ email: 'alex@example.com', password: PW }),
        headers: { 'content-type': 'application/json' },
      })
    ).headers['set-cookie'],
  ).split(';')[0];

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-pdf-'));
  await mkdir(join(base, 'docs'), { recursive: true });
  await writeFile(join(base, 'docs', 'invoice.pdf'), PDF);
  // a stand-in pdftocairo for machines without poppler: answers -v and prints a PNG "page"
  await writeFile(
    join(base, 'page.png'),
    await sharp({ create: { width: 400, height: 600, channels: 3, background: '#1a8080' } })
      .png()
      .toBuffer(),
  );
  await writeFile(join(base, 'pdftocairo'), `#!/bin/sh\ncase "$1" in -v) echo "pdftocairo version 0.0-fake" >&2; exit 0;; esac\ncat "${join(base, 'page.png')}"\n`);
  await chmod(join(base, 'pdftocairo'), 0o755);
});
after(async () => {
  await app?.close();
  await rm(base, { recursive: true, force: true });
});

async function expectThumb(a: FastifyInstance, cookie: string): Promise<void> {
  const ls = (await a.inject({ url: '/api/ls?path=Docs', headers: { cookie } })).json() as Listing;
  assert.equal(ls.entries[0].thumb, true, 'a PDF advertises a thumbnail');
  const res = await a.inject({ url: '/api/thumb?path=Docs/invoice.pdf&w=160', headers: { cookie } });
  assert.equal(res.statusCode, 200, res.body);
  const meta = await sharp(res.rawPayload).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.height, 160, 'portrait page: the height is the long side');
}

test('without pdftocairo a PDF is just a file', async () => {
  app = await createApp(cfgWith(join(base, 'no-such-pdftocairo')), { logger: false });
  admin = await login(app);
  assert.equal(((await app.inject({ url: '/api/ls?path=Docs', headers: { cookie: admin } })).json() as Listing).entries[0].thumb, undefined);
  assert.equal((await app.inject({ url: '/api/thumb?path=Docs/invoice.pdf', headers: { cookie: admin } })).statusCode, 415);
  await app.close();
  app = null;
});

test('with a (stand-in) pdftocairo the first page becomes the thumbnail', async () => {
  assert.match((await detectPdf(join(base, 'pdftocairo'))) ?? '', /fake/);
  app = await createApp(cfgWith(join(base, 'pdftocairo')), { logger: false });
  admin = await login(app);
  await expectThumb(app, admin);
  await app.close();
  app = null;
});

test('with the real poppler, when this machine has it', async (t) => {
  if (!(await detectPdf('pdftocairo'))) return t.skip('no pdftocairo here');
  await rm(join(base, 'thumbs'), { recursive: true, force: true });
  app = await createApp(cfgWith('pdftocairo'), { logger: false });
  admin = await login(app);
  await expectThumb(app, admin);
});
