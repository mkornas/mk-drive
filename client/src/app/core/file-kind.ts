import type { Entry } from '../../../../shared/types';

/**
 * What a file is, for the icon, the preview and the odd decision that depends
 * on it. The type the server reported decides when it says something useful;
 * the extension decides the rest, because `application/octet-stream` is what
 * most interesting files come back as.
 */
export type FileKind =
  | 'dir'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'markdown'
  | 'json'
  | 'code'
  | 'text'
  | 'subtitle'
  | 'ebook'
  | 'font'
  | 'archive'
  | 'disk'
  | 'app'
  | 'database'
  | 'other';

const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-bzip2',
  'application/x-xz',
  'application/zstd',
  'application/vnd.rar',
  'application/x-7z-compressed',
]);

/** Extension → kind, for everything a media type cannot tell us. Lower case, no dot. */
const BY_EXTENSION: Record<string, FileKind> = {};
const put = (kind: FileKind, ...exts: string[]) => exts.forEach((e) => (BY_EXTENSION[e] = kind));
put('doc', 'doc', 'docx', 'odt', 'rtf', 'pages');
put('sheet', 'xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers');
put('slides', 'ppt', 'pptx', 'odp', 'key');
put('ebook', 'epub', 'mobi', 'azw', 'azw3', 'fb2');
put('font', 'ttf', 'otf', 'woff', 'woff2', 'eot');
put('subtitle', 'srt', 'vtt', 'ass', 'ssa', 'sub');
put('archive', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'rar', '7z');
put('disk', 'iso', 'img', 'dmg', 'vhd', 'vhdx', 'qcow2', 'vmdk');
put('app', 'deb', 'rpm', 'apk', 'exe', 'msi', 'pkg', 'appimage', 'flatpak', 'snap');
put('database', 'db', 'sqlite', 'sqlite3', 'mdb', 'accdb');
put('code', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'lua', 'pl', 'r', 'dart', 'ex', 'exs', 'scala', 'clj', 'hs', 'nix', 'dockerfile', 'toml');
put('markdown', 'md', 'markdown', 'mdx');
put('json', 'json', 'jsonc', 'json5');
put('text', 'txt', 'log', 'yml', 'yaml', 'xml', 'ini', 'cfg', 'conf', 'env');
put('pdf', 'pdf');

/** The bit after the last dot, lower case; empty for a name without one (or a dotfile, which has no extension to speak of). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

export function kindOf(e: Pick<Entry, 'kind' | 'mime'> & { name?: string }): FileKind {
  if (e.kind === 'dir') return 'dir';
  const m = e.mime;
  // what the server is sure about
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/epub+zip') return 'ebook';
  if (m.startsWith('font/')) return 'font';
  if (m === 'text/markdown') return 'markdown';
  if (m === 'application/json') return 'json';
  if (/wordprocessingml|msword|opendocument\.text|application\/rtf/.test(m)) return 'doc';
  if (/spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv/.test(m)) return 'sheet';
  if (/presentationml|ms-powerpoint|opendocument\.presentation/.test(m)) return 'slides';
  if (ARCHIVE_MIMES.has(m)) return 'archive';
  if (m === 'application/x-iso9660-image') return 'disk';
  // then the name, because most of the rest arrives as application/octet-stream
  const byExt = BY_EXTENSION[extensionOf(e.name ?? '')];
  if (byExt) return byExt;
  if (m.startsWith('text/') || m === 'application/xml' || m === 'application/yaml') return 'text';
  return 'other';
}

const ICONS: Record<FileKind, string> = {
  dir: 'folder',
  image: 'file-image',
  video: 'video',
  audio: 'headphones',
  pdf: 'file-text',
  doc: 'file-text',
  sheet: 'file-spreadsheet',
  slides: 'presentation',
  markdown: 'file-text',
  json: 'file-json',
  code: 'file-code',
  text: 'file-text',
  subtitle: 'file-text',
  ebook: 'book',
  font: 'type',
  archive: 'archive',
  disk: 'layers',
  app: 'package',
  database: 'database',
  other: 'file',
};

export function iconFor(e: Pick<Entry, 'kind' | 'mime'> & { name?: string }): string {
  return ICONS[kindOf(e)];
}

/**
 * The colour an icon gets, as a class defined once in `styles.scss`. Only where
 * the colour means something people already know — folders, and the document
 * kinds that have had the same colour for thirty years. Everything else keeps
 * the text colour, so a folder of mixed files does not look like a paint box.
 */
const TONES: Partial<Record<FileKind, string>> = {
  dir: 'dir',
  pdf: 'pdf',
  doc: 'doc',
  sheet: 'sheet',
  slides: 'slides',
  image: 'media',
  video: 'media',
  audio: 'media',
};

export function iconClass(e: Pick<Entry, 'kind' | 'mime'> & { name?: string }, base = ''): string {
  const tone = TONES[kindOf(e)];
  return `${base} ficon${tone ? ` ficon--${tone}` : ''}`.trim();
}

/** Whether the preview pane can show this kind inline. */
export function previewable(k: FileKind): boolean {
  return ['image', 'video', 'audio', 'pdf', 'markdown', 'json', 'text', 'code', 'subtitle'].includes(k);
}
