/**
 * The one seam between the API and where bytes live. v1 ships `LocalProvider`
 * (a directory); SMB / S3 / WebDAV providers would implement the same
 * interface. Paths are relative segments already validated by `paths.ts`.
 */
import type { Readable } from 'node:stream';
import type { EntryKind } from '../../../shared/types.ts';

export interface StorageStat {
  kind: EntryKind;
  size: number;
  /** Epoch milliseconds. */
  mtime: number;
}

export interface StorageEntry extends StorageStat {
  name: string;
}

export interface ReadOptions {
  /** Inclusive byte range. */
  start?: number;
  end?: number;
}

/** Thrown by write operations when the destination already exists. */
export class ExistsError extends Error {
  constructor(what: string) {
    super(`${what} already exists`);
    this.name = 'ExistsError';
  }
}

export interface StorageProvider {
  /** `null` when the path does not exist (or escapes the root). */
  stat(segments: readonly string[]): Promise<StorageStat | null>;
  /** Direct children of a directory. `dirsOnly` skips stat() on files — cheap on network filesystems. */
  list(segments: readonly string[], opts?: { dirsOnly?: boolean }): Promise<StorageEntry[]>;
  /** A readable stream of a file (or a byte range of it). */
  read(segments: readonly string[], opts?: ReadOptions): Promise<Readable>;
  /** Free / total bytes of the filesystem behind the root, when the provider knows. */
  space(): Promise<{ free: number; total: number } | null>;
  /** Whether the root supports point-in-time versions (e.g. a visible `.zfs/snapshot`). */
  hasVersions(): Promise<boolean>;
  /** Snapshots that contain `segments`, newest first. Empty when unsupported. */
  versions(segments: readonly string[]): Promise<{ snapshot: string; stat: StorageStat }[]>;
  /** Read a file as it was in `snapshot`. */
  readVersion(snapshot: string, segments: readonly string[], opts?: ReadOptions): Promise<Readable>;
  /** Where the bytes are on this machine, when they are (local disk, host mount) — for tools that cannot read a stream, like ffmpeg. */
  localPath?(segments: readonly string[]): Promise<string | null>;

  // ---- writes ----
  /** Create a directory (parents must exist). Throws ExistsError. */
  mkdir(segments: readonly string[]): Promise<void>;
  /** Move/rename within this provider. Throws ExistsError unless `replace`. */
  rename(from: readonly string[], to: readonly string[], opts?: { replace?: boolean }): Promise<void>;
  /** Recursive copy within this provider. Throws ExistsError unless `replace`. */
  copy(from: readonly string[], to: readonly string[], opts?: { replace?: boolean }): Promise<void>;
  /** Remove a file or a whole directory. No error when already gone. */
  remove(segments: readonly string[]): Promise<void>;
  /** Write a whole file from a stream (used for cross-location copies). Throws ExistsError unless `replace`. */
  write(segments: readonly string[], data: Readable, opts?: { replace?: boolean; mtime?: number }): Promise<void>;
  /** Set the modification time when the provider can. */
  touch(segments: readonly string[], mtime: number): Promise<void>;

  // ---- chunked uploads: a temporary object the provider owns until commit ----
  uploadBegin(id: string): Promise<void>;
  /** Append `data` at `offset` (must equal the bytes already received). Returns the new total. */
  uploadAppend(id: string, offset: number, data: Readable): Promise<number>;
  uploadSize(id: string): Promise<number | null>;
  /** Move the finished upload to its final place. Throws ExistsError unless `replace`. */
  uploadCommit(id: string, dest: readonly string[], opts?: { replace?: boolean; mtime?: number }): Promise<void>;
  uploadAbort(id: string): Promise<void>;
}
