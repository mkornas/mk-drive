/**
 * Bounded searches: breadth-first, case-insensitive, stopping at a time or size
 * budget. `searchNames` matches names; `searchContent` reads text files and
 * PDFs (through poppler's pdftotext, when present) and returns a snippet around
 * the first match. Neither builds an index: the filesystem is the truth.
 */
import { execFile } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Mounted } from './locations.ts';
import { entryOf } from './entries.ts';
import { isText, mimeOf } from './mime.ts';
import type { Entry, SearchHit } from '../../shared/types.ts';

export interface SearchResult {
  entries: SearchHit[];
  /** True when the walk stopped before covering everything. */
  truncated: boolean;
  visited: number;
  scanned?: number;
}

let pdfText: string | null = null;

/** Ask poppler's pdftotext for its version; missing or broken means content search skips PDFs. */
export async function detectPdfText(pdftotext: string): Promise<string | null> {
  try {
    const out = await new Promise<string>((resolve, reject) => execFile(pdftotext, ['-v'], { timeout: 5000 }, (err, stdout, stderr) => (err ? reject(err) : resolve(String(stderr || stdout)))));
    pdfText = pdftotext;
    return out.split('\n')[0].trim();
  } catch {
    pdfText = null;
    return null;
  }
}

/** Sizes worth reading: a text file up to 2 MB, a PDF up to 25 MB (its first pages only). */
const TEXT_MAX = 2 * 1024 * 1024;
const PDF_MAX = 25 * 1024 * 1024;
const PDF_PAGES = 20;
const PDF_TIMEOUT_MS = 8000;

export async function searchNames(loc: Mounted, start: readonly string[], q: string, opts: { hidden: (segments: readonly string[]) => boolean; showDotfiles: boolean; limit?: number; budgetMs?: number; maxVisited?: number }): Promise<SearchResult> {
  const needle = q.trim().toLowerCase();
  const limit = opts.limit ?? 200;
  const deadline = Date.now() + (opts.budgetMs ?? 4000);
  const maxVisited = opts.maxVisited ?? 100_000;
  const entries: Entry[] = [];
  const queue: (readonly string[])[] = [start];
  let visited = 0;
  let truncated = false;
  while (queue.length) {
    if (Date.now() > deadline || visited > maxVisited || entries.length >= limit) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    let children;
    try {
      children = await loc.provider.list(dir);
    } catch {
      continue;
    }
    for (const c of children) {
      const segments = [...dir, c.name];
      if (opts.hidden(segments)) continue;
      if (!opts.showDotfiles && c.name.startsWith('.')) continue;
      visited++;
      if (needle && c.name.toLowerCase().includes(needle)) {
        entries.push(entryOf(loc.cfg.name, segments, c));
        if (entries.length >= limit) break;
      }
      if (c.kind === 'dir') queue.push(segments);
    }
  }
  return { entries, truncated, visited };
}

async function collect(stream: Readable, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream) {
    chunks.push(c as Buffer);
    size += (c as Buffer).length;
    if (size > max) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The text of a PDF's first pages, through pdftotext; empty when it is not installed or the file defeats it. */
async function pdfToText(loc: Mounted, segments: readonly string[]): Promise<string> {
  if (!pdfText) return '';
  const local = await loc.provider.localPath?.(segments);
  return new Promise<string>((resolve) => {
    const child = execFile(pdfText!, ['-q', '-l', String(PDF_PAGES), local ?? '-', '-'], { timeout: PDF_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    if (!local) {
      // a connector: stream the bytes through stdin
      void loc.provider
        .read(segments)
        .then((r) => r.pipe(child.stdin!))
        .catch(() => child.kill());
    }
  });
}

/** `needle` inside `text`, case-insensitively: the surrounding line-ish window, or null. */
export function snippetOf(text: string, needle: string, radius = 70): string | null {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + needle.length + radius);
  const cut = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${cut}${end < text.length ? '…' : ''}`;
}

/** Looks inside files for `q`: text files by extension and PDFs when pdftotext is there; a few files at a time. */
export async function searchContent(loc: Mounted, start: readonly string[], q: string, opts: { hidden: (segments: readonly string[]) => boolean; showDotfiles: boolean; limit?: number; budgetMs?: number; maxVisited?: number; maxBytes?: number }): Promise<SearchResult> {
  const needle = q.trim();
  const limit = opts.limit ?? 50;
  const deadline = Date.now() + (opts.budgetMs ?? 10_000);
  const maxVisited = opts.maxVisited ?? 50_000;
  let budgetBytes = opts.maxBytes ?? 256 * 1024 * 1024;
  const entries: SearchHit[] = [];
  const queue: (readonly string[])[] = [start];
  let visited = 0;
  let scanned = 0;
  let truncated = false;
  const readable = (name: string, size: number): 'text' | 'pdf' | null => {
    const mime = mimeOf(name);
    if (isText(mime)) return size <= TEXT_MAX ? 'text' : null;
    if (mime === 'application/pdf' && pdfText) return size <= PDF_MAX ? 'pdf' : null;
    return null;
  };
  const scan = async (segments: readonly string[], kind: 'text' | 'pdf', e: Parameters<typeof entryOf>[2]): Promise<void> => {
    scanned++;
    budgetBytes -= e.size;
    let text = '';
    try {
      text = kind === 'pdf' ? await pdfToText(loc, segments) : await collect(await loc.provider.read(segments), TEXT_MAX);
    } catch {
      return;
    }
    const snippet = snippetOf(text, needle);
    if (snippet !== null) entries.push({ ...entryOf(loc.cfg.name, segments, e), snippet });
  };
  const pending: Promise<void>[] = [];
  const PARALLEL = 4;
  while (queue.length) {
    if (Date.now() > deadline || visited > maxVisited || entries.length >= limit || budgetBytes < 0) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    let children;
    try {
      children = await loc.provider.list(dir);
    } catch {
      continue;
    }
    for (const c of children) {
      const segments = [...dir, c.name];
      if (opts.hidden(segments)) continue;
      if (!opts.showDotfiles && c.name.startsWith('.')) continue;
      visited++;
      if (c.kind === 'dir') {
        queue.push(segments);
        continue;
      }
      const kind = readable(c.name, c.size);
      if (!kind) continue;
      if (Date.now() > deadline || entries.length >= limit || budgetBytes < 0) {
        truncated = true;
        break;
      }
      const job = scan(segments, kind, c).finally(() => pending.splice(pending.indexOf(job), 1));
      pending.push(job);
      if (pending.length >= PARALLEL) await Promise.race(pending);
    }
    if (truncated) break;
  }
  await Promise.all(pending);
  if (entries.length > limit) entries.length = limit;
  return { entries, truncated, visited, scanned };
}
