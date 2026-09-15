import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { config, type Config } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import type { Arrival, FolderStats, Listing, MarkedEntry, PhotoPage, SearchResult } from '../../shared/types.ts';

let base: string;
let app: FastifyInstance;
let admin = '';
const PW = 'correct horse battery';

function cfgWith(): Config {
  return { ...config, staticDir: '', dbFile: ':memory:', thumbDir: join(base, 'thumbs'), thumbCacheMb: 1, adminEmail: 'alex@example.com', adminPassword: PW, locations: [{ name: 'Docs', path: join(base, 'docs'), mode: 'rw', hide: ['.ssh'] }], accessAud: '' };
}
const json = (method: InjectOptions['method'], url: string, payload: unknown): InjectOptions => ({ method, url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', cookie: admin } });

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-drive-extras-'));
  await mkdir(join(base, 'docs', 'photos', 'deep'), { recursive: true });
  await mkdir(join(base, 'docs', '.ssh'), { recursive: true });
  await writeFile(join(base, 'docs', 'photos', 'sunset.jpg'), await sharp({ create: { width: 800, height: 500, channels: 3, background: '#d06030' } }).jpeg().toBuffer());
  await writeFile(join(base, 'docs', 'photos', 'deep', 'Sunset-notes.txt'), 'x');
  await writeFile(join(base, 'docs', 'readme.md'), '# hi');
  await writeFile(join(base, 'docs', 'photos', 'deep', 'notes.txt'), 'Faktura VAT 2026/09/12 dla firmy Kowalski\nkwota 1200 zł');
  await writeFile(join(base, 'docs', 'photos', 'deep', 'binary.bin'), 'Kowalski hidden in a binary');
  await writeFile(join(base, 'docs', 'invoice.pdf'), minimalPdf('Umowa z firma Kowalski i syn'));
  await writeFile(join(base, 'docs', '.ssh', 'notes.txt'), 'Kowalski secret');
  await writeFile(join(base, 'docs', '.ssh', 'sunset-key'), 'k');
  app = await createApp(cfgWith(), { logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: JSON.stringify({ email: 'alex@example.com', password: PW }), headers: { 'content-type': 'application/json' } });
  admin = String(login.headers['set-cookie']).split(';')[0];
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('thumbnail: webp, cached, etag, refused for non-images', async () => {
  const url = '/api/thumb?path=' + encodeURIComponent('Docs/photos/sunset.jpg') + '&w=160';
  const res = await app.inject({ url, headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  const meta = await sharp(res.rawPayload).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 160);
  assert.equal((await readdir(join(base, 'thumbs'))).length, 1);
  const cached = await app.inject({ url, headers: { cookie: admin, 'if-none-match': String(res.headers['etag']) } });
  assert.equal(cached.statusCode, 304);
  assert.equal((await app.inject({ url: '/api/thumb?path=Docs/readme.md', headers: { cookie: admin } })).statusCode, 415);
  const listing = (await app.inject({ url: '/api/ls?path=Docs/photos', headers: { cookie: admin } })).json();
  assert.equal(listing.entries.find((e: { name: string }) => e.name === 'sunset.jpg').thumb, true);
});

/** A one-page, uncompressed PDF that says `text` — enough for pdftotext. */
function minimalPdf(text: string): string {
  const content = `BT /F1 18 Tf 40 700 Td (${text}) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

test('search inside files: text files and PDFs, a snippet per hit, binaries and hidden names skipped', async () => {
  const res = await app.inject({ url: '/api/search?path=Docs&q=kowalski&in=content', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  const r = res.json() as SearchResult;
  const byPath = Object.fromEntries(r.entries.map((e) => [e.path, e.snippet]));
  assert.match(byPath['Docs/photos/deep/notes.txt'] ?? '', /firmy Kowalski kwota 1200/);
  assert.equal(byPath['Docs/photos/deep/binary.bin'], undefined);
  assert.equal(byPath['Docs/.ssh/notes.txt'], undefined);
  const pdf = await import('node:child_process').then((cp) => new Promise<boolean>((ok) => cp.execFile('pdftotext', ['-v'], (err) => ok(!err))));
  if (pdf) assert.match(byPath['Docs/invoice.pdf'] ?? '', /firma Kowalski i syn/);
  assert.equal(r.truncated, false);
  assert.ok((r.scanned ?? 0) >= 2);
  assert.equal((await app.inject({ url: '/api/search?path=Docs&q=k&in=content', headers: { cookie: admin } })).statusCode, 400);
});

test('folder details: bytes, counts, newest change, largest files; hidden names skipped; files refused', async () => {
  const res = await app.inject({ url: '/api/du?path=Docs', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  const d = res.json() as FolderStats;
  assert.equal(d.path, 'Docs');
  assert.ok(d.files >= 5 && d.dirs >= 2, `files ${d.files} dirs ${d.dirs}`);
  assert.ok(d.bytes > 1000, 'the jpeg counts');
  assert.equal(d.largest[0].path, 'Docs/photos/sunset.jpg');
  assert.ok(d.largest.length <= 5 && d.largest.every((e, i, a) => i === 0 || a[i - 1].size >= e.size));
  assert.ok(d.newest > 0 && !d.truncated);
  assert.ok(!d.largest.some((e) => e.path.startsWith('Docs/.ssh')));
  assert.equal((await app.inject({ url: '/api/du?path=Docs/readme.md', headers: { cookie: admin } })).statusCode, 400);
});

test('arrivals: the newest uploads the caller may see, deduplicated, gone files dropped', async () => {
  const send = async (name: string, body: string) => {
    const begin = (await app.inject({ method: 'POST', url: '/api/uploads', payload: JSON.stringify({ dir: 'Docs/photos', name, size: body.length }), headers: { 'content-type': 'application/json', cookie: admin } })).json() as { id: string };
    await app.inject({ method: 'PATCH', url: `/api/uploads/${begin.id}`, payload: body, headers: { 'content-type': 'application/octet-stream', 'upload-offset': '0', cookie: admin } });
    return (await app.inject({ method: 'POST', url: `/api/uploads/${begin.id}/complete`, payload: JSON.stringify({ onConflict: 'replace' }), headers: { 'content-type': 'application/json', cookie: admin } })).json() as { path: string };
  };
  await send('arrived.txt', 'one');
  await send('arrived.txt', 'two'); // replaced: one row on the home page, not two
  await send('gone.txt', 'x');
  await rm(join(base, 'docs', 'photos', 'gone.txt'));
  const res = await app.inject({ url: '/api/arrivals', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  const list = res.json() as Arrival[];
  assert.deepEqual(list.map((a) => a.path), ['Docs/photos/arrived.txt']);
  assert.equal(list[0].by.email, 'alex@example.com');
  assert.equal(list[0].viaLink, false);
  assert.equal(list[0].size, 3);
});

test('search without a path covers every location the caller may open', async () => {
  const names = (await app.inject({ url: '/api/search?q=sunset', headers: { cookie: admin } })).json() as SearchResult;
  assert.deepEqual(names.entries.map((e) => e.path).sort(), ['Docs/photos/deep/Sunset-notes.txt', 'Docs/photos/sunset.jpg']);
  const inside = (await app.inject({ url: '/api/search?q=kowalski&in=content', headers: { cookie: admin } })).json() as SearchResult;
  assert.ok(inside.entries.some((e) => e.path === 'Docs/photos/deep/notes.txt'));
  assert.ok((inside.scanned ?? 0) >= 1);
});

test('search: case-insensitive, recursive, skips hidden names', async () => {
  const res = await app.inject({ url: '/api/search?path=Docs&q=SUNSET', headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  const r = res.json() as SearchResult;
  assert.deepEqual(
    r.entries.map((e) => e.path).sort(),
    ['Docs/photos/deep/Sunset-notes.txt', 'Docs/photos/sunset.jpg'],
  );
  assert.equal(r.truncated, false);
  assert.equal((await app.inject({ url: '/api/search?path=Docs&q=', headers: { cookie: admin } })).statusCode, 400);
});

test('stars and recent: per user, checked against the filesystem', async () => {
  assert.equal((await app.inject(json('POST', '/api/stars', { path: 'Docs/readme.md' }))).statusCode, 200);
  assert.equal((await app.inject(json('POST', '/api/stars', { path: 'Docs/photos' }))).statusCode, 200);
  assert.equal((await app.inject(json('POST', '/api/stars', { path: 'Docs/.ssh' }))).statusCode, 404);
  let stars = (await app.inject({ url: '/api/stars', headers: { cookie: admin } })).json() as MarkedEntry[];
  assert.deepEqual(stars.map((s) => s.path), ['Docs/photos', 'Docs/readme.md']);
  await rm(join(base, 'docs', 'readme.md'));
  stars = (await app.inject({ url: '/api/stars', headers: { cookie: admin } })).json() as MarkedEntry[];
  assert.deepEqual(stars.map((s) => s.path), ['Docs/photos'], 'a deleted file drops out');
  await app.inject({ method: 'DELETE', url: '/api/stars?path=Docs/photos', headers: { cookie: admin } });
  assert.equal(((await app.inject({ url: '/api/stars', headers: { cookie: admin } })).json() as MarkedEntry[]).length, 0);

  await app.inject(json('POST', '/api/recent', { path: 'Docs/photos/sunset.jpg' }));
  const recent = (await app.inject({ url: '/api/recent', headers: { cookie: admin } })).json() as MarkedEntry[];
  assert.equal(recent[0].name, 'sunset.jpg');
  assert.ok(recent[0].at > 0);
});

test('photos: every image and video under a location, newest first, paged by mtime', async () => {
  await writeFile(join(base, 'docs', 'photos', 'deep', 'clip.mp4'), 'not a video, but named like one');
  await writeFile(join(base, 'docs', 'photos', 'old.png'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer());
  const { utimes } = await import('node:fs/promises');
  await utimes(join(base, 'docs', 'photos', 'old.png'), new Date('2020-01-01'), new Date('2020-01-01'));
  const first = (await app.inject({ url: '/api/photos?location=Docs&limit=2', headers: { cookie: admin } })).json() as PhotoPage;
  assert.equal(first.total, 3);
  assert.equal(first.entries.length, 2);
  assert.ok(first.next, 'more to come');
  assert.ok(first.entries.every((e) => e.mime.startsWith('image/') || e.mime.startsWith('video/')));
  assert.ok(first.entries[0].mtime >= first.entries[1].mtime, 'newest first');
  const rest = (await app.inject({ url: `/api/photos?location=Docs&limit=2&before=${first.next}`, headers: { cookie: admin } })).json() as PhotoPage;
  assert.deepEqual(rest.entries.map((e) => e.name), ['old.png']);
  assert.equal(rest.next, null);
  assert.equal((await app.inject({ url: '/api/photos?location=Docs/photos', headers: { cookie: admin } })).statusCode, 400, 'a location, not a folder');
  assert.equal((await app.inject({ url: '/api/photos?location=Nope', headers: { cookie: admin } })).statusCode, 404);
});

test('photos: the date taken (EXIF) orders the timeline ahead of the modification time, cached per file version', async () => {
  const { utimes } = await import('node:fs/promises');
  await writeFile(join(base, 'docs', 'photos', 'holiday.jpg'), await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123' } }).jpeg().withExif({ IFD0: { DateTime: '2024:01:01 12:00:00' }, IFD2: { DateTimeOriginal: '2019:07:14 09:30:00' } }).toBuffer());
  await utimes(join(base, 'docs', 'photos', 'holiday.jpg'), new Date(), new Date()); // just modified, but shot in 2019
  const page = (await app.inject({ url: '/api/photos?location=Docs&limit=10&fresh=1', headers: { cookie: admin } })).json() as PhotoPage;
  const holiday = page.entries.find((e) => e.name === 'holiday.jpg')!;
  assert.equal(new Date(holiday.taken!).getFullYear(), 2019);
  assert.equal(page.entries[page.entries.length - 2].name, 'old.png', 'old.png is 2020 by mtime');
  assert.equal(page.entries[page.entries.length - 1].name, 'holiday.jpg', 'just modified, but shot in 2019 — so last');
  const listing = (await app.inject({ url: '/api/ls?path=Docs/photos', headers: { cookie: admin } })).json() as Listing;
  assert.equal(listing.entries.find((e) => e.name === 'holiday.jpg')?.taken, undefined, 'listings stay cheap; only the timeline reads EXIF');
});
