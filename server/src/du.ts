/**
 * What is under a folder: bytes, counts, the newest change and the largest
 * files, from a bounded breadth-first walk (a time and entry budget, like the
 * search). Hidden names are skipped the way listings skip them.
 */
import type { Mounted } from './locations.ts';
import { entryOf } from './entries.ts';
import type { Entry, FolderStats } from '../../shared/types.ts';

export async function folderStats(loc: Mounted, start: readonly string[], opts: { hidden: (segments: readonly string[]) => boolean; showDotfiles: boolean; budgetMs?: number; maxVisited?: number; largest?: number }): Promise<FolderStats> {
  const deadline = Date.now() + (opts.budgetMs ?? 10_000);
  const maxVisited = opts.maxVisited ?? 200_000;
  const keep = opts.largest ?? 5;
  const queue: (readonly string[])[] = [start];
  const top: Entry[] = [];
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  let newest = 0;
  let visited = 0;
  let truncated = false;
  while (queue.length) {
    if (Date.now() > deadline || visited > maxVisited) {
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
      if (c.mtime > newest) newest = c.mtime;
      if (c.kind === 'dir') {
        dirs++;
        queue.push(segments);
        continue;
      }
      files++;
      bytes += c.size;
      if (top.length < keep || c.size > top[top.length - 1].size) {
        top.push(entryOf(loc.cfg.name, segments, c));
        top.sort((a, b) => b.size - a.size);
        if (top.length > keep) top.length = keep;
      }
    }
  }
  return { path: [loc.cfg.name, ...start].join('/'), bytes, files, dirs, newest, largest: top, truncated };
}
