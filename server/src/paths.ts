/**
 * Drive paths: `<location>/<segment>/<segment>`. Parsing is strict — no empty,
 * `.` or `..` segments, no NUL, no backslashes — so a parsed path can be
 * joined onto a location root without further thought.
 */
import { badRequest } from './errors.ts';

export interface DrivePath {
  location: string;
  segments: string[];
  /** Normalised drive path (`location` alone for the root). */
  path: string;
}

const BAD_SEGMENT = /[\0\\]/;

export function parseDrivePath(raw: string | undefined): DrivePath {
  if (typeof raw !== 'string') throw badRequest('path is required');
  const parts = raw.split('/').filter((s) => s !== '');
  if (parts.length === 0) throw badRequest('path is required');
  for (const p of parts) {
    if (p === '.' || p === '..' || BAD_SEGMENT.test(p)) throw badRequest(`invalid path segment "${p}"`);
    if (p.length > 255) throw badRequest('path segment too long');
  }
  const [location, ...segments] = parts;
  return { location, segments, path: parts.join('/') };
}

export function joinDrivePath(location: string, segments: readonly string[]): string {
  return [location, ...segments].join('/');
}

/** Parent drive path, or null at a location root. */
export function parentDrivePath(p: DrivePath): string | null {
  if (p.segments.length === 0) return null;
  return joinDrivePath(p.location, p.segments.slice(0, -1));
}
