/** Extension → MIME type for the kinds of files a drive usually holds. Unknown = application/octet-stream. */
const TYPES: Record<string, string> = {
  // text & code
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', toml: 'text/plain', ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain', env: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', scss: 'text/x-scss', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java', kt: 'text/x-kotlin', swift: 'text/x-swift', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++', cs: 'text/x-csharp', php: 'text/x-php', sh: 'text/x-shellscript', bash: 'text/x-shellscript', sql: 'text/x-sql', dockerfile: 'text/plain',
  // images
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  // audio / video
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo', ts_video: 'video/mp2t',
  // documents
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation', rtf: 'application/rtf', epub: 'application/epub+zip',
  // archives & binaries
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', bz2: 'application/x-bzip2', xz: 'application/x-xz', zst: 'application/zstd', tar: 'application/x-tar', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', iso: 'application/x-iso9660-image', dmg: 'application/x-apple-diskimage', deb: 'application/vnd.debian.binary-package', apk: 'application/vnd.android.package-archive', exe: 'application/vnd.microsoft.portable-executable',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
};

export function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name.toLowerCase() === 'dockerfile' ? 'text/plain' : 'application/octet-stream';
  const ext = name.slice(dot + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

/** Whether a MIME type is safe and useful to send with `charset=utf-8`. */
export function isText(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime === 'application/yaml';
}
