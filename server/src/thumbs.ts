/**
 * Lazily generated WebP thumbnails, cached under the data dir and capped in
 * size. The key includes the file's etag, so a changed file gets a new thumb
 * and the old one ages out of the cache.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { StorageProvider } from './storage/provider.ts';

const run = promisify(execFile);

export const THUMB_WIDTHS = [160, 320, 640, 1280];
const THUMBABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/tiff', 'image/svg+xml']);

/** Set once at start, after `detectVideo()` / `detectPdf()`: video and PDF thumbnails are only advertised when their tool is there. */
let videoThumbs = false;
let pdfThumbs = false;

export function canThumb(mime: string): boolean {
  return THUMBABLE.has(mime) || (videoThumbs && mime.startsWith('video/')) || (pdfThumbs && mime === 'application/pdf');
}

/** Ask poppler's pdftocairo for its version; missing or broken switches PDF thumbnails off. */
export async function detectPdf(pdftocairo: string): Promise<string | null> {
  try {
    const { stderr, stdout } = await run(pdftocairo, ['-v'], { timeout: 5000 });
    pdfThumbs = true;
    return (stderr || stdout).split('\n')[0].trim();
  } catch {
    pdfThumbs = false;
    return null;
  }
}

/** Ask ffmpeg to say hello; a missing or broken binary switches video thumbnails off. */
export async function detectVideo(ffmpeg: string): Promise<string | null> {
  try {
    const { stdout } = await run(ffmpeg, ['-version'], { timeout: 5000 });
    videoThumbs = true;
    return stdout.split('\n')[0].trim();
  } catch {
    videoThumbs = false;
    return null;
  }
}

export class Thumbs {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly inflight = new Map<string, Promise<string>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  private readonly ffmpeg: string;
  private readonly pdftocairo: string;

  constructor(dir: string, maxMb: number, ffmpeg = 'ffmpeg', pdftocairo = 'pdftocairo') {
    this.dir = dir;
    this.maxBytes = maxMb * 1024 * 1024;
    this.ffmpeg = ffmpeg;
    this.pdftocairo = pdftocairo;
  }

  key(location: string, path: string, etag: string, width: number): string {
    return createHash('sha1').update(`${location}|${path}|${etag}|${width}`).digest('hex');
  }

  /** Absolute path of the cached thumbnail, generating it first when needed. */
  async get(provider: StorageProvider, segments: readonly string[], key: string, width: number, mime = ''): Promise<string> {
    const file = join(this.dir, `${key}.webp`);
    try {
      await stat(file);
      return file;
    } catch {
      /* not cached yet */
    }
    let p = this.inflight.get(key);
    if (!p) {
      const make = mime.startsWith('video/') ? this.generateVideo(provider, segments, file, width) : mime === 'application/pdf' ? this.generatePdf(provider, segments, file, width) : this.generate(provider, segments, file, width);
      p = make.finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async generate(provider: StorageProvider, segments: readonly string[], file: string, width: number): Promise<string> {
    await this.slot();
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      const source = await provider.read(segments);
      const resize = sharp({ limitInputPixels: 80_000_000, animated: false }).rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78, effort: 3 });
      await pipeline(source, resize, createWriteStream(tmp));
      await rename(tmp, file);
      return file;
    } finally {
      this.release();
    }
  }

  /** A poster frame: ffmpeg grabs one frame a second in (or the first, for very short clips), sharp makes the WebP. */
  private async generateVideo(provider: StorageProvider, segments: readonly string[], file: string, width: number): Promise<string> {
    const local = await provider.localPath?.(segments);
    if (!local) throw new Error('video thumbnails need a local file');
    await this.slot();
    try {
      await mkdir(this.dir, { recursive: true });
      const frame = async (seek: string) => {
        const { stdout } = await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', seek, '-i', local, '-frames:v', '1', '-vf', `scale='min(${width * 2},iw)':-2`, '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
        if (!stdout.length) throw new Error('no frame');
        return stdout;
      };
      const png = await frame('1').catch(() => frame('0'));
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, await sharp(png, { limitInputPixels: 80_000_000 }).resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78, effort: 3 }).toBuffer());
      await rename(tmp, file);
      return file;
    } finally {
      this.release();
    }
  }

  /** The first page of a PDF, rendered by pdftocairo at twice the width (it can write to stdout; pdftoppm cannot) and shrunk by sharp. */
  private async generatePdf(provider: StorageProvider, segments: readonly string[], file: string, width: number): Promise<string> {
    const local = await provider.localPath?.(segments);
    if (!local) throw new Error('PDF thumbnails need a local file');
    await this.slot();
    try {
      await mkdir(this.dir, { recursive: true });
      const { stdout } = await run(this.pdftocairo, ['-f', '1', '-l', '1', '-singlefile', '-png', '-scale-to', String(width * 2), local, '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
      if (!stdout.length) throw new Error('no page');
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, await sharp(stdout, { limitInputPixels: 80_000_000 }).flatten({ background: '#ffffff' }).resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78, effort: 3 }).toBuffer());
      await rename(tmp, file);
      return file;
    } finally {
      this.release();
    }
  }

  private slot(): Promise<void> {
    if (this.running < 2) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => (this.running++, resolve())));
  }

  private release(): void {
    this.running--;
    this.waiting.shift()?.();
  }

  /** Delete the oldest files until the cache fits its cap. */
  async sweep(): Promise<number> {
    let files: { name: string; size: number; mtime: number }[] = [];
    try {
      const names = await readdir(this.dir);
      files = (await Promise.all(names.map(async (name) => {
        const s = await stat(join(this.dir, name)).catch(() => null);
        return s && s.isFile() ? { name, size: s.size, mtime: s.mtimeMs } : null;
      }))).filter((f): f is { name: string; size: number; mtime: number } => !!f);
    } catch {
      return 0;
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    files.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const f of files) {
      if (total <= this.maxBytes && !f.name.endsWith('.tmp')) break;
      await rm(join(this.dir, f.name), { force: true });
      total -= f.size;
      removed++;
    }
    return removed;
  }
}
