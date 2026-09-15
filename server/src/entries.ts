/** Entry shape shared by listings, search, stars and recent. */
import { mimeOf } from './mime.ts';
import { canThumb } from './thumbs.ts';
import { joinDrivePath } from './paths.ts';
import type { StorageStat } from './storage/provider.ts';
import type { Entry } from '../../shared/types.ts';

export function etagOf(s: StorageStat): string {
  return `W/"${s.size.toString(16)}-${s.mtime.toString(16)}"`;
}

export function entryOf(location: string, segments: readonly string[], s: StorageStat): Entry {
  const name = segments.length ? segments[segments.length - 1] : location;
  return {
    name,
    path: joinDrivePath(location, segments),
    kind: s.kind,
    size: s.size,
    mtime: s.mtime,
    mime: s.kind === 'dir' ? '' : mimeOf(name),
    etag: etagOf(s),
    hidden: name.startsWith('.'),
    ...(s.kind === 'file' && canThumb(mimeOf(name)) ? { thumb: true } : {}),
  };
}
