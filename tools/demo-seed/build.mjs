// Builds the demo drive's seed directory from public-domain and CC0 sources, with a CREDITS.md.
//   node tools/demo-seed/build.mjs <outdir>
// Photos: Openverse (CC0 only) resized to 2400px with an EXIF date; Space: NASA image library
// (public domain); Videos: NASA (the small renditions); Music: Openverse CC0 audio; PDFs: rendered
// here from HTML with headless Chrome. Every file's mtime is its "taken" date, so Recent and the
// Photos timeline look lived-in. Sizes stay well under 2 GB in total.
import { mkdir, writeFile, utimes, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('../../server/node_modules/sharp');
const exec = promisify(execFile);

const out = process.argv[2];
if (!out) throw new Error('usage: build.mjs <outdir>');
const UA = 'mk-drive-demo-seed/1 (https://github.com/mkornas/mk-drive; demo dataset builder)';
const credits = [];
const now = Date.now();
const day = 86_400_000;
const d = (daysAgo, h = 10) => { const t = new Date(now - daysAgo * day); t.setHours(h, 12, 0, 0); return t; };
const exifDate = (t) => `${t.getFullYear()}:${String(t.getMonth() + 1).padStart(2, '0')}:${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:00`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fetchBuf(url, maxMb = 400) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > maxMb * 1024 * 1024) throw new Error(`too big (${(len / 1e6).toFixed(0)} MB) ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
async function json(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function save(rel, buf, when) {
  const file = join(out, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  await utimes(file, when, when);
}

// ---- Photos from Openverse (CC0 only) ----
// Wikimedia Commons only (Unsplash's CC0 mirrors live there and are large and clean); 2000px+
// after decoding, titles stripped of markup, nothing that is not scenery.
const PHOTO_SETS = [
  ['Photos/Mountains', ['mountain lake landscape', 'alpine lake', 'fjord norway', 'mountain valley'], 10, 400],
  ['Photos/Coast', ['coast beach cliffs sea', 'ocean beach sunset', 'sea cliffs', 'lighthouse coast'], 10, 60],
  ['Photos/City', ['city street architecture evening', 'city skyline night', 'old town street', 'bridge river city'], 8, 120],
  ['Photos/Forest', ['forest path trees', 'pine forest', 'autumn forest', 'waterfall forest'], 8, 200],
  ['Photos/Table', ['coffee breakfast table', 'cafe latte', 'fresh bread bakery', 'kitchen table food'], 6, 20],
];
// no violence, and no museum scans of prints and paintings (Commons is full of them)
const AVOID = /war|damag|kherson|ruin|soldier|army|protest|police|accident|dead|blood|nude|naked|rp-[pft]-|rijksmuseum|image from page|gezicht|landschap|boslaan|ruiter|laan met|painting|drawing|engraving|etching|lithograph|schilderij|tekening|prent|manuscript|book of/i;
const cleanTitle = (t) => String(t ?? '').replace(/<[^>]*>/g, ' ').replace(/^file:/i, '').replace(/\.(jpe?g|png)$/i, '').replace(/\s+/g, ' ').trim();
async function photos() {
  for (const [dir, queries, want, baseDays] of PHOTO_SETS) {
    let got = 0;
    const seen = new Set();
    for (const q of queries) {
      if (got >= want) break;
      let res;
      try {
        res = await json(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=cc0&extension=jpg&size=large&source=wikimedia&page_size=20&mature=false`);
      } catch (e) { log('openverse', q, e.message); continue; }
      for (const r of res.results ?? []) {
        if (got >= want) break;
        const title = cleanTitle(r.title);
        const key = slug(title).slice(0, 28);
        if (!r.url || (r.width && r.width < 2000) || AVOID.test(title) || AVOID.test(r.url) || seen.has(key)) continue;
        seen.add(key);
        try {
          const buf = await fetchBuf(r.url, 60);
          const meta = await sharp(buf).metadata();
          if (!meta.width || Math.max(meta.width, meta.height ?? 0) < 2000) { log('small', title.slice(0, 40), `${meta.width}x${meta.height}`); continue; }
          const when = d(baseDays + got * 3 + Math.floor(Math.random() * 3), 9 + (got % 8));
          const jpg = await sharp(buf).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
            .withExif({ IFD0: { ImageDescription: title, Artist: r.creator ?? '', Copyright: `CC0, via ${r.source ?? 'openverse'}` }, IFD2: { DateTimeOriginal: exifDate(when), DateTimeDigitized: exifDate(when) } })
            .jpeg({ quality: 85, mozjpeg: true })
            .toBuffer();
          const name = `${slug(title) || slug(q)}-${String(got + 1).padStart(2, '0')}.jpg`;
          await save(join(dir, name), jpg, when);
          credits.push([join(dir, name), title, r.creator ?? '', 'CC0', r.foreign_landing_url ?? r.url]);
          got++;
          log(dir, name, `${meta.width}x${meta.height}`);
        } catch (e) { log('skip', r.url?.slice(0, 60), e.message.slice(0, 60)); }
      }
    }
  }
}

// ---- NASA: space photos (public domain) and small videos ----
async function nasa(kind, q, want, dir, daysBase) {
  let res;
  try { res = await json(`https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=${kind}&page_size=12`); } catch (e) { log('nasa', q, e.message); return; }
  let got = 0;
  for (const item of res.collection?.items ?? []) {
    if (got >= want) break;
    const data = item.data?.[0];
    if (!data || !item.href) continue;
    try {
      const assets = await json(item.href);
      // the original photo when it is not huge, else the large rendition; the medium video, else the small one
      const picks = kind === 'image'
        ? [assets.find((u) => /~orig\.jpe?g$/i.test(u)), assets.find((u) => /~large\.jpg$/i.test(u))]
        : [assets.find((u) => /~medium\.mp4$/i.test(u)), assets.find((u) => /~mobile\.mp4$/i.test(u)), assets.find((u) => /~preview\.mp4$/i.test(u))];
      let buf = null;
      for (const pick of picks.filter(Boolean)) {
        try { buf = await fetchBuf(pick.replace(/^http:/, 'https:'), kind === 'image' ? 40 : 250); break; } catch (e) { log('nasa rendition', e.message.slice(0, 60)); }
      }
      if (!buf) continue;
      const when = data.date_created ? new Date(data.date_created) : d(daysBase + got * 5);
      const title = (data.title || q).replace(/\s+/g, ' ').trim();
      if (kind === 'image') {
        const jpg = await sharp(buf).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
          .withExif({ IFD0: { ImageDescription: title, Artist: 'NASA', Copyright: 'Public domain, NASA' }, IFD2: { DateTimeOriginal: exifDate(when), DateTimeDigitized: exifDate(when) } })
          .jpeg({ quality: 85, mozjpeg: true }).toBuffer();
        const name = `${slug(title) || data.nasa_id}.jpg`;
        await save(join(dir, name), jpg, when);
        credits.push([join(dir, name), title, 'NASA', 'Public domain', `https://images.nasa.gov/details/${data.nasa_id}`]);
      } else {
        const name = `${slug(title) || data.nasa_id}.mp4`;
        await save(join(dir, name), buf, when);
        credits.push([join(dir, name), title, 'NASA', 'Public domain', `https://images.nasa.gov/details/${data.nasa_id}`]);
      }
      got++;
      log(dir, title.slice(0, 50), `${(buf.length / 1e6).toFixed(1)} MB`);
    } catch (e) { log('skip nasa', data.nasa_id, e.message.slice(0, 80)); }
  }
}

// ---- Music from Openverse (CC0) ----
async function music() {
  const sets = [['piano', 3, 30], ['acoustic guitar', 3, 90], ['ambient', 2, 15]];
  for (const [q, want, base] of sets) {
    let res;
    try { res = await json(`https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}&license=cc0&page_size=20&mature=false`); } catch (e) { log('openverse audio', q, e.message); continue; }
    let got = 0;
    for (const r of res.results ?? []) {
      if (got >= want) break;
      if (!r.url || !/\.(mp3|ogg|wav|flac)(\?|$)/i.test(r.url) || (r.duration && r.duration < 20_000)) continue;
      try {
        const buf = await fetchBuf(r.url, 40);
        const when = d(base + got * 7);
        const ext = (r.url.match(/\.(mp3|ogg|wav|flac)/i) || [, 'mp3'])[1].toLowerCase();
        const name = `${slug(r.title) || slug(q)}-${got + 1}.${ext}`;
        await save(join('Music', name), buf, when);
        credits.push([join('Music', name), r.title ?? '', r.creator ?? '', 'CC0', r.foreign_landing_url ?? r.url]);
        got++;
        log('Music', name, `${(buf.length / 1e6).toFixed(1)} MB`);
      } catch (e) { log('skip audio', r.url?.slice(0, 60), e.message.slice(0, 60)); }
    }
  }
}

// ---- Documents rendered here (no licence questions) ----
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;margin:56px 64px;max-width:720px}h1{font-size:30px;letter-spacing:-.02em;margin:0 0 6px}h2{font-size:19px;margin:30px 0 8px}p,li{color:#333}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border-bottom:1px solid #ddd;padding:7px 6px;text-align:left}th{color:#666;font-weight:600;font-size:13px}.meta{color:#777;font-size:13px;margin-bottom:26px}code{background:#f2f2f2;padding:1px 5px;border-radius:4px}</style></head><body>${body}</body></html>`;
const DOCS = [
  ['Documents/Trip plan — the coast, June.pdf', 3, page('Trip plan', `<h1>The coast, 12–16 June</h1><p class="meta">Four nights, two towns, one rented bike.</p><h2>Where we sleep</h2><table><tr><th>Night</th><th>Place</th><th>Booked</th></tr><tr><td>12–14</td><td>The old lighthouse keeper's house</td><td>yes</td></tr><tr><td>14–16</td><td>Harbour apartment, second floor</td><td>yes</td></tr></table><h2>Things to do</h2><ul><li>The cliff walk, early, before the wind</li><li>Fish market on Saturday morning</li><li>Kayaks at the harbour (call the day before)</li><li>The small museum with the shipwreck maps</li></ul><h2>Packing</h2><ul><li>Rain jackets, both of them</li><li>The good camera and the spare battery</li><li>Chargers, the long cable</li></ul>`)],
  ['Documents/Recipes/Sourdough, the Sunday loaf.pdf', 18, page('Sourdough', `<h1>Sourdough, the Sunday loaf</h1><p class="meta">Makes one loaf. Start Saturday evening.</p><h2>Ingredients</h2><table><tr><th>What</th><th>How much</th></tr><tr><td>Bread flour</td><td>450 g</td></tr><tr><td>Whole wheat flour</td><td>50 g</td></tr><tr><td>Water</td><td>375 g</td></tr><tr><td>Starter, active</td><td>100 g</td></tr><tr><td>Salt</td><td>10 g</td></tr></table><h2>Method</h2><ol><li>Mix flour and water; rest 45 minutes.</li><li>Add starter and salt; fold every 30 minutes for two hours.</li><li>Rest at room temperature until it grows by half.</li><li>Shape, then into the fridge overnight.</li><li>Bake at 250 °C in a covered pot: 20 minutes covered, 22 uncovered.</li></ol><p>Cool for an hour before cutting, however hard that is.</p>`)],
  ['Documents/Manuals/The box in the corner — quick start.pdf', 45, page('Quick start', `<h1>The box in the corner</h1><p class="meta">Quick start for the home server.</p><h2>What runs on it</h2><table><tr><th>App</th><th>Port</th><th>What for</th></tr><tr><td>mk-drive</td><td>8810</td><td>files, photos, shares</td></tr><tr><td>mk-dashboard</td><td>8800</td><td>the host and the containers</td></tr><tr><td>mk-nas</td><td>—</td><td>disks, pools, snapshots</td></tr></table><h2>If it does not answer</h2><ol><li>Is the light on? The power strip under the desk has a switch.</li><li>Open <code>http://192.168.1.20:8800</code> from a laptop on the same network.</li><li>Still nothing: hold the power button for ten seconds, wait a minute, try again.</li></ol><h2>Backups</h2><p>Every night at three the important datasets are copied to the second box in the garage. The last copy's time is on the dashboard.</p>`)],
  ['Documents/Reports/Monthly report, August.pdf', 12, page('Monthly report', `<h1>August, in numbers</h1><p class="meta">The household, one page.</p><table><tr><th>Line</th><th>Planned</th><th>Actual</th></tr><tr><td>Rent</td><td>2 400</td><td>2 400</td></tr><tr><td>Groceries</td><td>900</td><td>1 040</td></tr><tr><td>Transport</td><td>250</td><td>180</td></tr><tr><td>Fun</td><td>300</td><td>420</td></tr><tr><td>Savings</td><td>1 500</td><td>1 500</td></tr></table><h2>Notes</h2><ul><li>Groceries over because of the two dinners; fine.</li><li>The bike repair went under fun, which is honest.</li><li>Renew the domain in September.</li></ul>`)],
];
async function documents() {
  for (const [rel, daysAgo, html] of DOCS) {
    const tmp = join(out, '.tmp.html');
    await mkdir(dirname(join(out, rel)), { recursive: true });
    await writeFile(tmp, html);
    await exec('google-chrome', ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${join(out, rel)}`, `file://${tmp}`], { timeout: 60_000 });
    await utimes(join(out, rel), d(daysAgo), d(daysAgo));
    log('PDF', rel);
  }
  await rm(join(out, '.tmp.html'), { force: true });
  const csv = ['month,rent,groceries,transport,fun,savings', ...Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')},2400,${850 + ((i * 37) % 200)},${150 + ((i * 53) % 120)},${200 + ((i * 71) % 250)},1500`)].join('\n') + '\n';
  await save('Documents/Reports/budget-2025.csv', Buffer.from(csv), d(70));
  await save('Documents/Reading list.md', Buffer.from('# Reading list\n\n- [ ] The lighthouse keeper\'s diary\n- [x] A field guide to the coast\n- [ ] Bread, the long way\n- [ ] The small museum catalogue\n'), d(6));
}

await mkdir(out, { recursive: true });
await photos();
await nasa('image', 'aurora from the space station', 3, 'Photos/Space', 300);
await nasa('image', 'Earth at night from orbit', 3, 'Photos/Space', 320);
await nasa('image', 'nebula Hubble', 2, 'Photos/Space', 340);
await nasa('image', 'Mars surface rover', 2, 'Photos/Space', 360);
await nasa('video', 'Earth time-lapse from the space station', 2, 'Videos', 200);
await nasa('video', 'rocket launch', 1, 'Videos', 240);
await nasa('video', 'aurora time-lapse', 1, 'Videos', 260);
await music();
await documents();
const lines = ['# Credits', '', 'Everything in this demo is public domain or CC0, or was written for it. Per file:', '', '| File | Title | Creator | Licence | Source |', '| --- | --- | --- | --- | --- |', ...credits.map((c) => `| ${c.map((x) => String(x).replace(/\|/g, '/')).join(' | ')} |`), '', 'The PDFs, the notes and the spreadsheet were written for the demo.', ''];
await save('CREDITS.md', Buffer.from(lines.join('\n')), d(1));
const du = await exec('du', ['-sh', out]);
log('done', du.stdout.trim(), `${credits.length} credited files`);
