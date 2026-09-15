/**
 * Headers for every response that carries a file's bytes. The drive's origin
 * also serves the app, so nothing a user uploaded may run as a page there:
 * the type is never sniffed, and anything a browser could render actively
 * (HTML, SVG, XML, … — whatever is not on the short list of passive types)
 * gets a CSP sandbox with no sources, and is a download unless the endpoint is
 * an explicit inline preview.
 */
import type { FastifyReply } from 'fastify';
import { isText, mimeOf } from './mime.ts';

/** `Content-Disposition` with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const SANDBOX_CSP = "default-src 'none'; sandbox";

/** Types a browser only ever shows passively (no script, no document on our origin). */
export function isPassive(mime: string): boolean {
  if (mime === 'image/svg+xml' || mime.endsWith('+xml')) return false;
  return mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/pdf' || mime === 'text/plain';
}

/**
 * Content-Type (`charset=utf-8` on text unless `bareType`), nosniff, disposition and — for anything not passive — the sandbox.
 * `inline` is honoured only for passive types unless the endpoint is a `preview` (the app's own
 * inline view, where the sandbox keeps the page inert); `sandboxAll` sandboxes every type (WebDAV).
 */
export function fileHeaders(
  reply: FastifyReply,
  name: string,
  opts: { disposition: 'inline' | 'attachment'; preview?: boolean; sandboxAll?: boolean; bareType?: boolean },
): string {
  const mime = mimeOf(name);
  const passive = isPassive(mime);
  reply.header('Content-Type', isText(mime) && !opts.bareType ? `${mime}; charset=utf-8` : mime);
  reply.header('X-Content-Type-Options', 'nosniff');
  const kind = opts.disposition === 'inline' && (passive || opts.preview) ? 'inline' : 'attachment';
  reply.header('Content-Disposition', contentDisposition(kind, name));
  if (!passive || opts.sandboxAll) reply.header('Content-Security-Policy', SANDBOX_CSP);
  return mime;
}
