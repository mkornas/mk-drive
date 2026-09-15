/*
 * mk-drive's service worker: Angular's ngsw-worker.js for caching and updates,
 * plus one thing it cannot do — receive a Web Share Target. Sharing to the
 * installed app POSTs a multipart form here; the files are parked in a cache
 * and the app opens /share, which uploads them with the user's session.
 */
const INBOX = 'mk-drive-share-inbox';

/*
 * Only the share sheet's own launch of the installed app is taken: a navigation the browser marks `none` (no page
 * started it) or `same-origin`. Any site could otherwise post a form to /share and park files in the inbox, offered
 * for upload on the next visit. Where the worker does not see Sec-Fetch-Site (browsers may add it below the worker),
 * the referrer decides: none, or this origin. A page can hide its referrer, so that fallback is weaker; what is
 * parked is still only uploaded once the user picks a folder and presses Upload. Anything refused goes to the
 * network, which has no POST /share.
 */
function fromShareSheet(request) {
  if (request.mode !== 'navigate') return false;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site === 'none' || site === 'same-origin';
  return !request.referrer || request.referrer === 'about:client' || new URL(request.referrer).origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share' || !fromShareSheet(event.request)) return;
  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const cache = await caches.open(INBOX);
        const stamp = Date.now();
        let i = 0;
        for (const f of form.getAll('files')) {
          if (!(f instanceof File)) continue;
          const headers = { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || `shared-${i}`), 'x-mtime': String(f.lastModified || stamp) };
          await cache.put(new Request(`/share-inbox/${stamp}-${i++}`), new Response(f, { headers }));
        }
        const text = [form.get('title'), form.get('text'), form.get('url')].filter((v) => typeof v === 'string' && v.trim()).join('\n');
        if (text) {
          const headers = { 'content-type': 'text/plain; charset=utf-8', 'x-name': encodeURIComponent(`shared-${new Date(stamp).toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`), 'x-mtime': String(stamp) };
          await cache.put(new Request(`/share-inbox/${stamp}-${i++}`), new Response(text + '\n', { headers }));
        }
      } catch (e) {
        /* nothing parked; the page says so */
      }
      return Response.redirect('/share', 303);
    })(),
  );
});

importScripts('./ngsw-worker.js');
