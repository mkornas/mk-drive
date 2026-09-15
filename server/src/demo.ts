/**
 * Demo mode (`DRIVE_DEMO=true`): a throwaway location full of sample files and
 * a demo admin, recreated on every start. For trying the app and for the
 * public demo — never for real data. `DRIVE_DEMO_SEED` names a directory
 * copied on top (timestamps kept), so the public demo shows real photos,
 * videos and PDFs instead of the generated stand-ins.
 */
import { cp, mkdir, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Config } from './config.ts';
import type { Users } from './users.ts';

export const DEMO_EMAIL = 'demo@example.com';
export const DEMO_PASSWORD = 'demo-drive-2026';

const README = `# Welcome to the demo drive

Everything here is sample data that is **recreated whenever the server starts**, so feel free to upload, rename, move and delete.

- Sign in as \`${DEMO_EMAIL}\` with \`${DEMO_PASSWORD}\`
- Try the grid view, the lightbox on the photos, search, the command palette (Ctrl/⌘ K)
- Share a link, star something, drag a file onto a folder
`;

const PALETTE: [string, [number, number, number]][] = [
  ['harbour', [14, 124, 123]],
  ['dunes', [201, 162, 39]],
  ['pine', [45, 90, 61]],
  ['slate', [70, 80, 96]],
  ['coral', [214, 96, 77]],
  ['plum', [110, 66, 128]],
];

async function photo(file: string, rgb: [number, number, number], w = 1600, h = 1067): Promise<void> {
  const [r, g, b] = rgb;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgb(${r},${g},${b})"/><stop offset="1" stop-color="rgb(${Math.min(255, r + 70)},${Math.min(255, g + 70)},${Math.min(255, b + 70)})"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.35}" r="${h * 0.18}" fill="rgba(255,255,255,0.85)"/><path d="M0 ${h * 0.75} Q ${w * 0.25} ${h * 0.55} ${w * 0.5} ${h * 0.7} T ${w} ${h * 0.6} V ${h} H0Z" fill="rgba(0,0,0,0.25)"/></svg>`;
  await writeFile(file, await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer());
}

/** Rebuilds the demo tree under `<dataDir>/demo` and returns the location config for it. */
export async function seedDemo(cfg: Config): Promise<{ name: string; path: string }> {
  const root = join(cfg.dataDir, 'demo');
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'Photos', 'Coast'), { recursive: true });
  await mkdir(join(root, 'Documents', 'Invoices'), { recursive: true });
  await mkdir(join(root, 'Projects', 'mk-drive', 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), README);
  await writeFile(join(root, 'Documents', 'notes.md'), '# Notes\n\n- Renew the domain\n- Back up the photos\n- Call the plumber\n');
  await writeFile(join(root, 'Documents', 'budget.json'), JSON.stringify({ month: '2026-09', income: 8200, spend: { rent: 2400, food: 900, fun: 300 } }, null, 2));
  await writeFile(join(root, 'Documents', 'Invoices', 'invoice-2026-08.txt'), 'Invoice 2026-08\nTotal: 1 230,00 zł\nPaid.\n');
  await writeFile(join(root, 'Documents', 'Invoices', 'invoice-2026-09.txt'), 'Invoice 2026-09\nTotal: 1 190,00 zł\nDue 2026-10-05.\n');
  await writeFile(join(root, 'Projects', 'mk-drive', 'src', 'main.ts'), "import { bootstrapApplication } from '@angular/platform-browser';\nimport { App } from './app/app';\n\nbootstrapApplication(App).catch(console.error);\n");
  await writeFile(join(root, 'Projects', 'mk-drive', 'package.json'), JSON.stringify({ name: 'mk-drive', version: '0.1.0', private: true }, null, 2));
  let i = 0;
  for (const [name, rgb] of PALETTE) {
    await photo(join(root, 'Photos', i < 3 ? `${name}.jpg` : join('Coast', `${name}.jpg`)), rgb);
    i++;
  }
  // give the files believable ages
  const now = Date.now();
  const stamps: [string, number][] = [
    ['README.md', 1], ['Documents/notes.md', 3], ['Documents/budget.json', 12], ['Documents/Invoices/invoice-2026-08.txt', 40], ['Documents/Invoices/invoice-2026-09.txt', 9],
    ['Photos/harbour.jpg', 60], ['Photos/dunes.jpg', 58], ['Photos/pine.jpg', 20], ['Photos/Coast/slate.jpg', 5], ['Photos/Coast/coral.jpg', 5], ['Photos/Coast/plum.jpg', 4],
  ];
  for (const [rel, days] of stamps) {
    const t = new Date(now - days * 86_400_000);
    await utimes(join(root, rel), t, t).catch(() => {});
  }
  if (cfg.demoSeed) {
    const seed = await stat(cfg.demoSeed).catch(() => null);
    if (!seed?.isDirectory()) throw new Error(`DRIVE_DEMO_SEED is not a directory: ${cfg.demoSeed}`);
    await cp(cfg.demoSeed, root, { recursive: true, preserveTimestamps: true });
  }
  return { name: 'Demo', path: root };
}

/**
 * The demo account, recreated with a known password on every start. A member with write
 * access to the demo location, never an admin: the account is shared with everyone who
 * visits, so it must not be able to manage people, locations or connectors. A read-only
 * guest sits next to it for showing what a member with less access sees.
 */
export async function seedDemoUsers(users: Users): Promise<void> {
  const existing = users.byEmail(DEMO_EMAIL);
  if (existing) {
    users.update(existing.id, { role: 'member', disabled: false });
    users.setGrants(existing.id, { Demo: 'write' });
    await users.setPassword(existing.id, DEMO_PASSWORD);
  } else await users.create({ email: DEMO_EMAIL, name: 'Demo', role: 'member', password: DEMO_PASSWORD, grants: { Demo: 'write' } });
  if (!users.byEmail('guest@example.com')) await users.create({ email: 'guest@example.com', name: 'Guest', role: 'member', password: DEMO_PASSWORD, grants: { Demo: 'read' } });
}
