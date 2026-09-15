// Screenshots of the drive's pages through headless Chrome over the DevTools protocol: log in over the API,
// hand the cookie to the browser, set the theme in localStorage, open each path, save a PNG.
//   node shot.mjs <base> <outdir> <theme:light|dark> <width> <path...>
// Signs in as the demo account unless SHOT_EMAIL / SHOT_PASSWORD say otherwise (Storage pages need an admin).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, out, theme, widthArg, ...paths] = process.argv.slice(2);
const width = Number(widthArg) || 1360;
mkdirSync(out, { recursive: true });
const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.SHOT_EMAIL ?? 'demo@example.com', password: process.env.SHOT_PASSWORD ?? 'demo-drive-2026' }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
if (!cookie) throw new Error(`no cookie: ${login.status} ${await login.text()}`);
const [cname, cvalue] = cookie.split('=');
const url = new URL(base);

const port = 9333 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const chrome = spawn(
  'google-chrome',
  [
    `--headless=new`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--window-size=${width},900`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    ws = (await r.json()).webSocketDebuggerUrl;
    break;
  } catch {
    await wait(200);
  }
}
if (!ws) throw new Error('chrome did not come up');
const sock = new WebSocket(ws);
await new Promise((r) => (sock.onopen = r));
let id = 0;
const pending = new Map();
const events = [];
sock.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) events.push(msg);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    sock.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 }, sessionId);
await send('Network.setCookie', { name: cname, value: cvalue, domain: url.hostname, path: '/', httpOnly: true }, sessionId);
await send(
  'Page.addScriptToEvaluateOnNewDocument',
  { source: `try{localStorage.setItem('mk-kit-theme','${theme}');localStorage.setItem('mk-theme','${theme}');}catch{}` },
  sessionId,
);
for (const p of paths) {
  await send('Page.navigate', { url: base + p }, sessionId);
  await wait(2500);
  await send('Runtime.evaluate', { expression: `document.documentElement.setAttribute('data-mk-theme','${theme}')` }, sessionId);
  await wait(400);
  const { result } = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true }, sessionId);
  const height = Math.min(Math.max(900, result.value), 4000);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 }, sessionId);
  await wait(300);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  const file = join(out, `${theme}-${width}-${p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(file);
}
sock.close();
chrome.kill();
