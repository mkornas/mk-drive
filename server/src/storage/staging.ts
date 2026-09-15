/**
 * Chunked-upload staging for providers whose storage is somewhere else: the
 * pieces land in a local temp file under the data dir, and commit streams the
 * whole thing to the remote in one go. Mirrors the upload half of
 * `StorageProvider`, so a remote provider just delegates to it.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { OffsetError } from './local.ts';

export class Staging {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad upload id');
    return join(this.dir, id);
  }

  async begin(id: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await pipeline(Readable.from([]), createWriteStream(this.path(id), { flags: 'wx' }));
  }

  async append(id: string, offset: number, data: Readable): Promise<number> {
    const p = this.path(id);
    const current = (await stat(p)).size;
    if (current !== offset) throw new OffsetError(current);
    await pipeline(data, createWriteStream(p, { flags: 'r+', start: offset }));
    return (await stat(p)).size;
  }

  async size(id: string): Promise<number | null> {
    try {
      return (await stat(this.path(id))).size;
    } catch {
      return null;
    }
  }

  /** The staged bytes as a stream plus their length (remotes usually need Content-Length). */
  async take(id: string): Promise<{ stream: Readable; size: number }> {
    const p = this.path(id);
    return { stream: createReadStream(p), size: (await stat(p)).size };
  }

  async abort(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
}
