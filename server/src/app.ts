/** Builds the Fastify app (also used by the tests through `app.inject`). */
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { Config } from './config.ts';
import { createAuth, registerAuth, routePath } from './auth.ts';
import { SsoProvider, registerSso, resolveSso } from './sso.ts';
import { Locations } from './locations.ts';
import { openDb } from './db.ts';
import { Users } from './users.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerAccountRoutes } from './routes/account.ts';
import { Settings } from './settings.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAppPasswordRoutes } from './routes/app-passwords.ts';
import { registerDavRoutes } from './routes/dav.ts';
import { Connectors } from './connectors.ts';
import { registerConnectorRoutes } from './routes/connectors.ts';
import { registerOpRoutes } from './routes/ops.ts';
import { registerUploadRoutes, sweepStaleUploads, Uploads } from './routes/uploads.ts';
import { Access } from './access.ts';
import { Ops } from './ops.ts';
import { detectPdf, detectVideo, Thumbs } from './thumbs.ts';
import { registerExtraRoutes } from './routes/extras.ts';
import { detectPdfText } from './search.ts';
import { registerShareRoutes } from './routes/shares.ts';
import { registerUserShareRoutes } from './routes/user-shares.ts';
import { registerVersionRoutes } from './routes/versions.ts';
import { seedDemo, seedDemoUsers } from './demo.ts';
import { HttpError } from './errors.ts';
import { NasClient } from './nas.ts';
import { migrateShareAccess, registerNasMonitorRoute, registerNasRoutes } from './routes/nas.ts';
import { registerSsoSettingsRoutes } from './routes/sso-settings.ts';

/** What the browser may load for the app itself (the file endpoint has its own, stricter, rules). */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Mutations the demo drive refuses (see the hook below). */
const DEMO_LOCKED = [
  /^\/api\/account(\/password)?$/,
  /^\/api\/settings\/(name|sso)$/,
  /^\/api\/users(\/|$)/,
  /^\/api\/connectors(\/|$)/,
  /^\/api\/sessions(\/|$)/,
  /^\/api\/app-passwords\/[^/]+$/,
];

export async function createApp(cfg: Config, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // trustProxy stays off: auth.ts derives the client address itself (Cloudflare header, or X-Forwarded-For from a trusted proxy only)
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
  });

  const db = openDb(cfg.dbFile);
  const users = new Users(db);
  const settings = new Settings(db);
  users.purgeExpiredSessions();
  if (users.count() === 0 && cfg.adminEmail && cfg.adminPassword) {
    const admin = await users.create({ email: cfg.adminEmail, name: cfg.adminEmail.split('@')[0], role: 'admin', password: cfg.adminPassword });
    users.audit({ userId: admin.id, email: admin.email, action: 'setup', detail: 'bootstrapped from DRIVE_ADMIN_EMAIL' });
    app.log.info(`created the admin account ${admin.email} from the environment`);
  }

  if (cfg.demo) {
    const demo = await seedDemo(cfg);
    cfg.locations = [{ name: demo.name, path: demo.path, mode: 'rw', hide: [] }, ...cfg.locations];
    await seedDemoUsers(users);
    app.log.warn('DEMO MODE: sample data under the data dir is recreated on every start');
  }
  const locations = new Locations(cfg);
  await locations.init();
  const connectors = new Connectors(db, locations, cfg.dataDir);
  await connectors.init(app.log);
  const auth = createAuth(cfg, users);
  const access = new Access(locations, users, db);
  const ops = new Ops(db);
  const uploads = new Uploads(db);
  const thumbs = new Thumbs(cfg.thumbDir, cfg.thumbCacheMb, cfg.ffmpeg, cfg.pdftocairo);
  const ffmpeg = await detectVideo(cfg.ffmpeg);
  if (ffmpeg) app.log.info(`video thumbnails: ${ffmpeg}`);
  else app.log.info(`video thumbnails off (no ${cfg.ffmpeg}; set DRIVE_FFMPEG or install it)`);
  const pdf = await detectPdf(cfg.pdftocairo);
  if (pdf) app.log.info(`PDF thumbnails: ${pdf}`);
  else app.log.info(`PDF thumbnails off (no ${cfg.pdftocairo}; set DRIVE_PDFTOCAIRO or install poppler)`);
  const pdfText = await detectPdfText(cfg.pdftotext);
  if (pdfText) app.log.info(`search inside PDFs: ${pdfText}`);
  else app.log.info(`search inside PDFs off (no ${cfg.pdftotext}; set DRIVE_PDFTOTEXT or install poppler)`);

  // Cross-site request forgery: the session cookie is SameSite=Lax, so a cross-site
  // POST cannot carry it; belt and braces, refuse anything a browser marks cross-site
  // and anything that is not JSON (an HTML form cannot send JSON without CORS).
  app.addHook('onRequest', async (req, reply) => {
    if (!MUTATING.has(req.method) || !(routePath(req) ?? '/api/').startsWith('/api/')) return;
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site') return reply.code(403).send({ ok: false, message: 'cross-site request refused' });
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > 0 && type !== 'application/json' && type !== 'application/octet-stream') return reply.code(415).send({ ok: false, message: 'send JSON' });
  });

  // the provider comes from the environment or the Settings page, read on every use; none set up leaves the routes refusing
  const sso = new SsoProvider(() => resolveSso(cfg, settings)?.conf ?? null, app.log);
  await sso.connect(); // best effort: a provider that is still booting is retried on the first login

  registerAuth(app, auth);
  if (cfg.demo) {
    // The demo account is shared by everyone who visits: what one visitor changes, the next one
    // meets. Files, folders, share links and minting an app password (the iOS app's sign-in) stay
    // open; the account itself, other visitors' sessions and tokens, people, locations and
    // connectors are fixed until the nightly reset.
    app.addHook('onRequest', async (req, reply) => {
      // the route that matched, not the raw URL: `/api/%61ccount/password` is the same route
      const path = routePath(req);
      if (MUTATING.has(req.method) && (path === null || DEMO_LOCKED.some((r) => r.test(path)))) {
        return reply.code(403).send({
          ok: false,
          message:
            'Not on the demo drive: accounts, passwords, people, locations and connectors stay as they are. Files, folders and share links are all yours.',
        });
      }
    });
  }
  let nas: NasClient | null = null;
  if (cfg.nasSocket) {
    nas = new NasClient(cfg.nasSocket);
    registerNasRoutes(app, nas, locations, users);
    // shares from before per-share SMB lists become admins-only, once the server is up; not awaited, the agent may not
    // answer yet (GET /api/nas/shares does it again)
    const agent = nas;
    app.addHook('onListen', async () => {
      migrateShareAccess(agent, users, { userId: null, email: 'mk-drive' }).catch((e: Error) =>
        app.log.warn(`SMB share lists not checked at startup: ${e.message}`),
      );
    });
    if (cfg.nasMonitorToken.length >= 32) registerNasMonitorRoute(app, nas, cfg.nasMonitorToken, auth.throttle, cfg.trustedProxies);
    else if (cfg.nasMonitorToken) app.log.warn('DRIVE_NAS_MONITOR_TOKEN is shorter than 32 characters: the monitor route stays off');
    app.log.info(`NAS mode: storage section over ${cfg.nasSocket}`);
  }
  registerAccountRoutes(app, cfg, auth, users, sso, nas, settings);
  registerAppPasswordRoutes(app, users);
  registerSso(app, cfg, users, sso);
  registerSsoSettingsRoutes(app, cfg, users, settings, sso);
  registerFileRoutes(app, access, locations, users);
  registerAdminRoutes(app, users, locations);
  registerOpRoutes(app, access, locations, users, ops);
  registerUploadRoutes(app, access, locations, users, uploads);
  registerExtraRoutes(app, access, locations, thumbs, db, users);
  registerShareRoutes(app, cfg, access, locations, users, ops, thumbs, auth.throttle, db, uploads);
  registerUserShareRoutes(app, access, locations, users, db);
  registerVersionRoutes(app, access, users);
  registerDavRoutes(app, access, locations, users, ops);
  registerConnectorRoutes(app, connectors, users);

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if ((routePath(req) ?? '').startsWith('/api/') && String(reply.getHeader('content-type') ?? '').includes('application/json'))
      reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    // an HttpError is ours and says something safe (e.g. "the NAS agent is not running"); anything else stays vague
    reply.code(status).send({ ok: false, message: status >= 500 && !(err instanceof HttpError) ? 'internal error' : err.message });
  });

  if (cfg.staticDir && existsSync(cfg.staticDir)) {
    // wildcard: files are resolved per request (a rebuilt client works without a restart);
    // anything that is not a file and not /api falls back to the SPA's index.html.
    await app.register(fastifyStatic, { root: cfg.staticDir, prefix: '/', wildcard: true, index: false, maxAge: '1h' });
    const sendIndex = (reply: FastifyReply) => reply.header('Cache-Control', 'no-cache').header('Content-Security-Policy', APP_CSP).sendFile('index.html');
    app.get('/', async (_req, reply) => sendIndex(reply));
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.code(404).send({ ok: false, message: 'not found' });
      return sendIndex(reply);
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ ok: false, message: 'not found' }));
    if (cfg.staticDir) app.log.warn(`no static dir at ${cfg.staticDir}; serving the API only`);
  }

  // housekeeping: stale upload parts and trash older than the retention
  let closing = false;
  const sweep = async () => {
    const dropped = await sweepStaleUploads(uploads, locations).catch(() => 0);
    await thumbs.sweep().catch(() => 0);
    if (closing) return; // the app went away while the first sweep was in flight (short-lived test apps)
    if (dropped) app.log.info(`dropped ${dropped} stale upload(s)`);
    for (const entry of ops.expired(cfg.trashDays)) {
      try {
        await ops.purge(locations.get(entry.location), entry);
      } catch (e) {
        app.log.warn(`could not purge ${entry.original}: ${(e as Error).message}`);
      }
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), 3_600_000);
  timer.unref();

  app.addHook('onClose', async () => {
    closing = true;
    clearInterval(timer);
    db.close();
  });

  const names = locations.names;
  if (names.length === 0) app.log.warn(`no locations: set DRIVE_LOCATIONS or mount directories under ${cfg.locationsDir}`);
  else app.log.info(`locations: ${names.join(', ')}`);
  if (auth.verifier) app.log.info(`Cloudflare Access enforced (${auth.verifier.issuer})`);
  if (users.count() === 0) app.log.warn('no users yet: open the app to create the admin account');

  return app;
}
