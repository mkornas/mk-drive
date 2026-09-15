import type { Entry } from '../../../../shared/types';

export type FileKind = 'dir' | 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'json' | 'text' | 'archive' | 'document' | 'other';

const ARCHIVES = new Set(['application/zip', 'application/gzip', 'application/x-tar', 'application/x-bzip2', 'application/x-xz', 'application/zstd', 'application/vnd.rar', 'application/x-7z-compressed', 'application/x-iso9660-image']);

export function kindOf(e: Pick<Entry, 'kind' | 'mime'>): FileKind {
  if (e.kind === 'dir') return 'dir';
  const m = e.mime;
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/markdown') return 'markdown';
  if (m === 'application/json') return 'json';
  if (m.startsWith('text/') || m === 'application/xml' || m === 'application/yaml') return 'text';
  if (ARCHIVES.has(m)) return 'archive';
  if (m.includes('officedocument') || m.includes('msword') || m.includes('ms-excel') || m.includes('ms-powerpoint') || m.includes('opendocument') || m === 'application/rtf' || m === 'application/epub+zip') return 'document';
  return 'other';
}

const ICONS: Record<FileKind, string> = {
  dir: 'folder',
  image: 'file-image',
  video: 'video',
  audio: 'headphones',
  pdf: 'file-text',
  markdown: 'file-text',
  json: 'file-json',
  text: 'file-code',
  archive: 'archive',
  document: 'file-text',
  other: 'file',
};

export function iconFor(e: Pick<Entry, 'kind' | 'mime'>): string {
  return ICONS[kindOf(e)];
}

/** Whether the preview pane can show this kind inline. */
export function previewable(k: FileKind): boolean {
  return k !== 'dir' && k !== 'archive' && k !== 'document' && k !== 'other';
}
