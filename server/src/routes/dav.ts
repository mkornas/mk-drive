/**
 * WebDAV at `/dav/<location>/<path>`: the same files, grants and trash as the
 * web app, for Finder, Explorer, iOS Files and every other client that speaks
 * it. Class 1 plus LOCK/UNLOCK (advisory tokens, not enforced — the desktop
 * clients refuse to write without them). Sign in with an app password
 * (`Authorization: Basic email:secret`). Deletes go to the trash like in the
 * app. Every path goes through `Access.resolve()`; hidden names stay hidden.
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Access } from '../access.ts';
import type { Locations, Mounted } from '../locations.ts';
import { ExistsError } from '../storage/provider.ts';
import type { Ops } from '../ops.ts';
import type { Users } from '../users.ts';
import { type DrivePath, parseDrivePath } from '../paths.ts';
import { etagOf } from '../entries.ts';
import { mimeOf } from '../mime.ts';
import { fileHeaders } from '../serve-headers.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { parseRange } from './files.ts';
import type { ConflictPolicy } from '../../../shared/types.ts';

export const DAV_METHODS = ['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'] as const;
const NON_STANDARD = ['PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'] as const;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const href = (segments: readonly string[], dir: boolean) => '/dav/' + segments.map(encodeURIComponent).join('/') + (dir && segments.length ? '/' : '');

interface Node {
  segments: readonly string[];
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
  etag?: string;
  quota?: { free: number; total: number } | null;
}

function propstat(n: Node): string {
  const props = [
    `<D:displayname>${xml(n.name)}</D:displayname>`,
    n.dir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
    `<D:getlastmodified>${new Date(n.mtime).toUTCString()}</D:getlastmodified>`,
    `<D:creationdate>${new Date(n.mtime).toISOString()}</D:creationdate>`,
    n.dir ? '' : `<D:getcontentlength>${n.size}</D:getcontentlength><D:getcontenttype>${xml(mimeOf(n.name))}</D:getcontenttype>`,
    n.etag ? `<D:getetag>${xml(n.etag)}</D:getetag>` : '',
    '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>',
    n.quota ? `<D:quota-available-bytes>${n.quota.free}</D:quota-available-bytes><D:quota-used-bytes>${n.quota.total - n.quota.free}</D:quota-used-bytes>` : '',
  ].join('');
  return `<D:response><D:href>${xml(href(n.segments, n.dir))}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

const multistatus = (body: string) => `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`;

export function registerDavRoutes(app: FastifyInstance, access: Access, locations: Locations, users: Users, ops: Ops): void {
  for (const m of NON_STANDARD) app.addHttpMethod(m, { hasBody: true });

  const who = (req: FastifyRequest) => ({ id: req.identity.id, email: req.identity.email });
  const audit = (req: FastifyRequest, action: string, path: string, detail: unknown = 'webdav') =>
    users.audit({ userId: req.identity.id, email: req.identity.email, action, path, detail });

  /** The drive path behind a `/dav/...` URL (`null` = the root that lists the locations). */
  const pathOf = (raw: string | undefined): string | null => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw ?? '');
    } catch {
      throw badRequest('bad path encoding');
    }
    const trimmed = decoded.replace(/\/+$/, '');
    return trimmed ? trimmed : null;
  };

  /** Locations the caller may enter, as root-level collections. */
  const roots = async (req: FastifyRequest): Promise<Node[]> => {
    const user = users.get(req.identity.id);
    if (!user) return [];
    const out: Node[] = [];
    for (const name of locations.names) {
      const loc = locations.get(name);
      if (access.levelForUser(user, loc, { location: name, segments: [], path: name }) === 'none') continue;
      out.push({ segments: [name], name, dir: true, size: 0, mtime: Date.now(), quota: await loc.provider.space().catch(() => null) });
    }
    return out;
  };

  const nodeOf = async (loc: Mounted, dp: DrivePath): Promise<Node> => {
    const st = await loc.provider.stat(dp.segments);
    if (!st) throw notFound();
    const name = dp.segments[dp.segments.length - 1] ?? dp.location;
    return {
      segments: [dp.location, ...dp.segments],
      name,
      dir: st.kind === 'dir',
      size: st.size,
      mtime: st.mtime,
      etag: st.kind === 'dir' ? undefined : etagOf(st),
      quota: dp.segments.length === 0 ? await loc.provider.space().catch(() => null) : undefined,
    };
  };

  const send207 = (reply: FastifyReply, body: string) => reply.code(207).header('Content-Type', 'application/xml; charset=utf-8').send(multistatus(body));

  const options = (reply: FastifyReply) => reply.header('DAV', '1, 2').header('MS-Author-Via', 'DAV').header('Allow', DAV_METHODS.join(', ')).code(200).send();

  /** `Destination` of COPY/MOVE as a drive path (same server, under /dav/). */
  const destination = (req: FastifyRequest): string => {
    const raw = req.headers.destination;
    if (typeof raw !== 'string') throw badRequest('Destination header required');
    let path: string;
    try {
      path = new URL(raw, `http://${req.headers.host ?? 'localhost'}`).pathname;
    } catch {
      throw badRequest('bad Destination');
    }
    if (!path.startsWith('/dav/')) throw new HttpError(502, 'Destination must be on this drive');
    const p = pathOf(path.slice('/dav/'.length));
    if (!p) throw new HttpError(403, 'cannot write to the root');
    return p;
  };

  /** The name is not free although `stat` saw nothing there: a symlink, which is never written through. */
  const linkInTheWay = (e: unknown): never => {
    if (e instanceof ExistsError) throw new HttpError(409, 'that name is taken by a link');
    throw e;
  };

  const overwrite = (req: FastifyRequest): ConflictPolicy =>
    typeof req.headers.overwrite === 'string' && req.headers.overwrite.trim().toUpperCase() === 'F' ? 'fail' : 'replace';

  const lockResponse = (reply: FastifyReply, hrefOf: string, token: string, timeout: string) => {
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:timeout>${timeout}</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken><D:lockroot><D:href>${xml(hrefOf)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
    return reply.header('Lock-Token', `<${token}>`).header('Content-Type', 'application/xml; charset=utf-8').send(body);
  };

  app.register(async (dav) => {
    // any body is a stream to the provider (PUT), or a small XML document nobody needs parsed strictly
    dav.removeAllContentTypeParsers();
    dav.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    const handler = async (req: FastifyRequest<{ Params: { '*'?: string } }>, reply: FastifyReply) => {
      const method = req.method.toUpperCase();
      const path = pathOf(req.params['*']);
      if (method === 'OPTIONS') return options(reply);

      // ---- the root: the locations the caller may see ----
      if (path === null) {
        if (method === 'PROPFIND') {
          const self: Node = { segments: [], name: 'mk-drive', dir: true, size: 0, mtime: Date.now() };
          const depth = String(req.headers.depth ?? 'infinity');
          const nodes = depth === '0' ? [self] : [self, ...(await roots(req))];
          return send207(reply, nodes.map(propstat).join(''));
        }
        if (method === 'GET' || method === 'HEAD')
          return reply.type('text/plain').send(method === 'HEAD' ? '' : 'mk-drive WebDAV — mount this address in Finder, Explorer or Files\n');
        if (method === 'LOCK' || method === 'PROPPATCH') throw new HttpError(403, 'the root is read-only');
        throw new HttpError(405, 'not allowed on the root');
      }

      switch (method) {
        case 'PROPFIND': {
          const { loc, dp } = access.resolve(req, path);
          const self = await nodeOf(loc, dp);
          const nodes = [self];
          const depth = String(req.headers.depth ?? 'infinity');
          if (self.dir && depth !== '0') {
            for (const e of await loc.provider.list(dp.segments)) {
              if (locations.isHidden(loc, [...dp.segments, e.name])) continue;
              nodes.push({
                segments: [...self.segments, e.name],
                name: e.name,
                dir: e.kind === 'dir',
                size: e.size,
                mtime: e.mtime,
                etag: e.kind === 'dir' ? undefined : etagOf(e),
              });
            }
          }
          return send207(reply, nodes.map(propstat).join(''));
        }
        case 'GET':
        case 'HEAD': {
          const { loc, dp } = access.resolve(req, path);
          const st = await loc.provider.stat(dp.segments);
          if (!st) throw notFound();
          if (st.kind === 'dir') return send207(reply, propstat(await nodeOf(loc, dp)));
          const etag = etagOf(st);
          reply.header('ETag', etag).header('Last-Modified', new Date(st.mtime).toUTCString()).header('Accept-Ranges', 'bytes');
          // WebDAV clients ignore both; a browser that opens this URL gets a download, never a page on the drive's origin
          fileHeaders(reply, dp.segments[dp.segments.length - 1], { disposition: 'attachment', sandboxAll: true, bareType: true });
          if (req.headers['if-none-match'] === etag) return reply.code(304).send();
          const range = parseRange(req.headers.range, st.size);
          if (range === null) {
            reply.header('Content-Range', `bytes */${st.size}`);
            throw new HttpError(416, 'range not satisfiable');
          }
          if (method === 'HEAD') return reply.header('Content-Length', String(st.size)).send();
          if (range)
            return reply
              .code(206)
              .header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`)
              .header('Content-Length', String(range.end - range.start + 1))
              .send(await loc.provider.read(dp.segments, range));
          return reply.header('Content-Length', String(st.size)).send(await loc.provider.read(dp.segments));
        }
        case 'PUT': {
          const { loc, dp } = access.resolve(req, path, 'write');
          if (dp.segments.length === 0) throw new HttpError(405, 'cannot overwrite a location');
          const parent = await loc.provider.stat(dp.segments.slice(0, -1));
          if (!parent || parent.kind !== 'dir') throw new HttpError(409, 'the parent folder does not exist');
          const before = await loc.provider.stat(dp.segments);
          if (before?.kind === 'dir') throw new HttpError(405, 'is a folder');
          const body = req.body instanceof Readable ? req.body : Readable.from(req.body == null ? [] : [Buffer.from(String(req.body))]);
          await loc.provider.write(dp.segments, body, { replace: true }).catch(linkInTheWay);
          const st = await loc.provider.stat(dp.segments);
          audit(req, 'upload', dp.path, { size: st?.size ?? 0, via: 'webdav' });
          if (st) reply.header('ETag', etagOf(st));
          return reply.code(before ? 204 : 201).send();
        }
        case 'MKCOL': {
          if (req.headers['content-length'] && req.headers['content-length'] !== '0') throw new HttpError(415, 'MKCOL takes no body');
          const { loc, dp } = access.resolve(req, path, 'write');
          if (dp.segments.length === 0) throw new HttpError(405, 'exists');
          const parent = await loc.provider.stat(dp.segments.slice(0, -1));
          if (!parent || parent.kind !== 'dir') throw new HttpError(409, 'the parent folder does not exist');
          try {
            await ops.mkdir(loc, dp.segments.slice(0, -1), dp.segments[dp.segments.length - 1], 'fail');
          } catch (e) {
            if (e instanceof ExistsError || (e as { statusCode?: number }).statusCode === 409) throw new HttpError(405, 'exists');
            throw e;
          }
          audit(req, 'mkdir', dp.path);
          return reply.code(201).send();
        }
        case 'DELETE': {
          const { loc, dp } = access.resolve(req, path, 'write');
          if (dp.segments.length === 0) throw new HttpError(405, 'cannot delete a location');
          if (!(await loc.provider.stat(dp.segments))) throw notFound();
          const entry = await ops.trash(loc, dp.segments, who(req));
          audit(req, 'delete', dp.path, { trash: entry.id, via: 'webdav' });
          return reply.code(204).send();
        }
        case 'COPY':
        case 'MOVE': {
          const moving = method === 'MOVE';
          const src = access.resolve(req, path, moving ? 'write' : 'read');
          if (src.dp.segments.length === 0) throw new HttpError(403, 'a location cannot be moved or copied');
          if (!(await src.loc.provider.stat(src.dp.segments))) throw notFound();
          const dst = access.resolve(req, destination(req), 'write');
          if (dst.dp.segments.length === 0) throw new HttpError(403, 'cannot replace a location');
          const dstDir = dst.dp.segments.slice(0, -1);
          const dstName = dst.dp.segments[dst.dp.segments.length - 1];
          const parent = await dst.loc.provider.stat(dstDir);
          if (!parent || parent.kind !== 'dir') throw new HttpError(409, 'the destination folder does not exist');
          const existed = (await dst.loc.provider.stat(dst.dp.segments)) !== null;
          const policy = overwrite(req);
          if (existed && policy === 'fail') throw new HttpError(412, 'destination exists and Overwrite is F');
          const sameDir = src.loc === dst.loc && src.dp.segments.slice(0, -1).join('/') === dstDir.join('/');
          try {
            if (moving && sameDir) await ops.rename(src.loc, src.dp.segments, dstName, policy);
            else if (dstName === src.dp.segments[src.dp.segments.length - 1])
              await (moving ? ops.move : ops.copy).call(ops, src.loc, src.dp.segments, dst.loc, dstDir, policy);
            else {
              // a different name in a different folder: go through the destination's parent with a temporary name
              await (moving ? ops.move : ops.copy).call(ops, src.loc, src.dp.segments, dst.loc, dstDir, policy);
              const landed = [...dstDir, src.dp.segments[src.dp.segments.length - 1]];
              await dst.loc.provider.rename(landed, dst.dp.segments, { replace: policy === 'replace' });
              if (moving) ops.relink([dst.dp.location, ...landed].join('/'), dst.dp.path);
            }
          } catch (e) {
            if (e instanceof ExistsError || (e as { statusCode?: number }).statusCode === 409) throw new HttpError(412, 'destination exists');
            throw e;
          }
          audit(req, moving ? (sameDir ? 'rename' : 'move') : 'copy', src.dp.path, { to: dst.dp.path, via: 'webdav' });
          return reply.code(existed ? 204 : 201).send();
        }
        case 'LOCK': {
          const { loc, dp } = access.resolve(req, path, 'write');
          if (dp.segments.length === 0) throw new HttpError(403, 'a location cannot be locked');
          const st = await loc.provider.stat(dp.segments);
          let code = 200;
          if (!st) {
            // RFC 4918 §7.3: locking an unmapped URL creates an empty resource (Finder locks before it uploads)
            await loc.provider.write(dp.segments, Readable.from([]), { replace: false }).catch(linkInTheWay);
            code = 201;
          }
          const timeout = typeof req.headers.timeout === 'string' && /^Second-\d+$/.test(req.headers.timeout) ? req.headers.timeout : 'Second-3600';
          const token = `opaquelocktoken:${randomUUID()}`;
          return lockResponse(reply.code(code), href([dp.location, ...dp.segments], st?.kind === 'dir'), token, timeout);
        }
        case 'UNLOCK': {
          access.resolve(req, path, 'write');
          return reply.code(204).send();
        }
        case 'PROPPATCH': {
          // nothing is writable, but saying so politely keeps Explorer and Finder going (they set Win32/Apple timestamps)
          const { loc, dp } = access.resolve(req, path, 'write');
          if (!(await loc.provider.stat(dp.segments))) throw notFound();
          const text = req.body instanceof Readable ? (await req.body.toArray()).join('') : String(req.body ?? '');
          const names = [...text.matchAll(/<(?:[\w.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?prop>/g)].flatMap((m) =>
            [...m[1].matchAll(/<([\w.-]+:)?([\w.-]+)[\s/>]/g)].map((x) => x[2]),
          );
          const props = names.map((n) => `<${xml(n)} xmlns=""/>`).join('') || '<D:displayname/>';
          return send207(
            reply,
            `<D:response><D:href>${xml(href([dp.location, ...dp.segments], false))}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat></D:response>`,
          );
        }
        default:
          throw new HttpError(405, 'method not allowed');
      }
    };

    dav.route({ method: [...DAV_METHODS], url: '/dav', handler: (req, reply) => handler(req as FastifyRequest<{ Params: { '*'?: string } }>, reply) });
    dav.route({ method: [...DAV_METHODS], url: '/dav/*', handler });
  });
}
