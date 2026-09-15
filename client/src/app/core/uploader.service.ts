import { Injectable, computed, inject, signal } from '@angular/core';
import type { ConflictPolicy, UploadStatus } from '../../../../shared/types';
import { ApiService, errorMessage } from './api.service';

/** Where the pieces go: the account's `/api/uploads` (the default) or a file-request link's `/api/s/:id/uploads`. */
export interface UploadTransport {
  begin(dir: string, name: string, size: number, mtime?: number): Promise<UploadStatus>;
  status(id: string): Promise<UploadStatus>;
  piece(id: string, offset: number, piece: Blob, signal?: AbortSignal): Promise<UploadStatus>;
  complete(id: string, onConflict: ConflictPolicy): Promise<{ path?: string; name?: string }>;
}

export type JobState = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface UploadJob {
  id: number;
  file: File;
  /** Destination directory (drive path). */
  dir: string;
  /** Name in the destination (may differ from file.name when uploading a folder). */
  name: string;
  state: JobState;
  sent: number;
  error?: string;
  /** Final path once done. */
  path?: string;
}

const CHUNK = 8 * 1024 * 1024;
const PARALLEL = 2;
const RETRIES = 3;

/**
 * Sends one file in pieces and completes it: resumes from what the server has after a failed piece,
 * gives up after a few retries, stops when `signal` aborts. Reports the bytes accepted so far.
 */
export async function sendFile(t: UploadTransport, file: File, dir: string, name: string, policy: ConflictPolicy, signal: AbortSignal, onProgress: (sent: number) => void): Promise<{ path?: string; name?: string }> {
  const status = await t.begin(dir, name, file.size, file.lastModified || undefined);
  let offset = status.received;
  let attempt = 0;
  while (offset < file.size) {
    if (signal.aborted) throw new Error('cancelled');
    const piece = file.slice(offset, Math.min(offset + CHUNK, file.size));
    try {
      const s = await t.piece(status.id, offset, piece, signal);
      offset = s.received;
      attempt = 0;
      onProgress(offset);
    } catch (e) {
      if (signal.aborted) throw new Error('cancelled');
      if (++attempt > RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      offset = (await t.status(status.id)).received; // resume from the truth
    }
  }
  return t.complete(status.id, policy);
}

/** A resumable, chunked upload queue that outlives page navigation. */
@Injectable({ providedIn: 'root' })
export class UploaderService {
  private readonly api = inject(ApiService);
  readonly jobs = signal<UploadJob[]>([]);
  readonly active = computed(() => this.jobs().filter((j) => j.state === 'queued' || j.state === 'uploading'));
  readonly open = signal(false);
  /** Set by the caller before enqueuing: what to do when a name is taken. */
  policy: ConflictPolicy = 'rename';
  /** Called with the destination dir whenever a file lands, so views can refresh. */
  onLanded: ((dir: string) => void) | null = null;
  private seq = 0;
  private running = 0;
  private readonly controllers = new Map<number, AbortController>();

  add(files: { file: File; dir: string; name?: string }[]): void {
    if (!files.length) return;
    const jobs = files.map<UploadJob>(({ file, dir, name }) => ({ id: ++this.seq, file, dir, name: name ?? file.name, state: 'queued', sent: 0 }));
    this.jobs.update((list) => [...list, ...jobs]);
    this.open.set(true);
    this.pump();
  }

  cancel(job: UploadJob): void {
    this.controllers.get(job.id)?.abort();
    this.patch(job.id, { state: 'cancelled' });
  }

  clearFinished(): void {
    this.jobs.update((list) => list.filter((j) => j.state === 'queued' || j.state === 'uploading'));
    if (!this.jobs().length) this.open.set(false);
  }

  private patch(id: number, p: Partial<UploadJob>): void {
    this.jobs.update((list) => list.map((j) => (j.id === id ? { ...j, ...p } : j)));
  }

  private pump(): void {
    while (this.running < PARALLEL) {
      const next = this.jobs().find((j) => j.state === 'queued');
      if (!next) return;
      this.running++;
      void this.run(next).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: UploadJob): Promise<void> {
    const ctrl = new AbortController();
    this.controllers.set(job.id, ctrl);
    this.patch(job.id, { state: 'uploading' });
    try {
      const done = await sendFile(this.api.uploads, job.file, job.dir, job.name, this.policy, ctrl.signal, (sent) => this.patch(job.id, { sent }));
      this.patch(job.id, { state: 'done', sent: job.file.size, path: done.path });
      this.onLanded?.(job.dir);
    } catch (e) {
      const cancelled = (e as Error).message === 'cancelled';
      this.patch(job.id, { state: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : errorMessage(e) });
    } finally {
      this.controllers.delete(job.id);
    }
  }
}

/** Files (and folder trees) out of a drop or paste; entries keep their relative path. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<{ file: File; relativePath: string }[]> {
  const out: { file: File; relativePath: string }[] = [];
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null);
  if (entries.some((e) => e)) {
    for (const entry of entries) if (entry) await walk(entry, '', out);
  } else {
    for (const f of [...dt.files]) out.push({ file: f, relativePath: f.name });
  }
  return out;
}

async function walk(entry: FileSystemEntry, prefix: string, out: { file: File; relativePath: string }[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, relativePath: prefix + entry.name });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
  }
}
