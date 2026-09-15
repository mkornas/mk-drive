// A stand-in mk-nasd on a Unix socket, with the kind of data a two-pool box a year in has. For looking at the pages.
//   node tools/fake-nas-agent.mjs <socket> [--empty]
// --empty is a box fresh from the installer: no pool, two free data disks, the OS disk and one that carries something.
// pool.create, dataset.create and policy.set change what the agent answers afterwards, in either mode; with
// FAKE_NAS_LOCATIONS set, a dataset made as a location also gets its directory there, so the drive picks it up.
// FAKE_NAS_FAIL_ONCE=dataset.create (a comma list of verbs) makes the first call of each fail, for the retry states.
// --foreign (with --empty) gives the two data disks the labels of a pool from another system (an old TrueNAS pool),
// not imported here; disk.wipe makes a disk free.
import { createServer } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

const sock = process.argv[2];
const EMPTY = process.argv.includes('--empty');
const FOREIGN = process.argv.includes('--foreign');
try {
  unlinkSync(sock);
} catch {}
const now = Date.now();
const ago = (h) => new Date(now - h * 3600_000).toISOString();
const D = (id, model, size, use, smart, extra = {}) => ({
  id,
  ids: [id, `wwn-0x50014ee${id.length}`],
  dev: '/dev/' + (extra.dev ?? 'sdx'),
  size,
  model,
  serial: id.split('_').pop(),
  transport: extra.tran ?? 'sata',
  rotational: extra.rot ?? true,
  use,
  smart,
});
const disks = [
  D(
    'ata-WDC_WD40EFZX-68AWUN0_WD-WX12D31A7K4N',
    'WDC WD40EFZX-68AWUN0',
    4e12,
    { kind: 'pool', pool: 'tank' },
    { passed: true, temperature: 36, powerOnHours: 9120, reallocated: 0, pending: 0, wear: null },
    { dev: 'sda' },
  ),
  D(
    'ata-WDC_WD40EFZX-68AWUN0_WD-WX22D31A8Q9P',
    'WDC WD40EFZX-68AWUN0',
    4e12,
    { kind: 'pool', pool: 'tank' },
    { passed: true, temperature: 38, powerOnHours: 9120, reallocated: 0, pending: 2, wear: null },
    { dev: 'sdb' },
  ),
  D(
    'ata-ST8000VN004-2M2101_WSD3F7QK',
    'ST8000VN004-2M2101',
    8e12,
    { kind: 'pool', pool: 'vault' },
    { passed: true, temperature: 41, powerOnHours: 2200, reallocated: 0, pending: 0, wear: null },
    { dev: 'sdc' },
  ),
  D(
    'ata-ST8000VN004-2M2101_WSD3F8ZB',
    'ST8000VN004-2M2101',
    8e12,
    { kind: 'pool', pool: 'vault' },
    { passed: true, temperature: 40, powerOnHours: 2200, reallocated: 0, pending: 0, wear: null },
    { dev: 'sdd' },
  ),
  D(
    'ata-ST8000VN004-2M2101_WSD3F9AA',
    'ST8000VN004-2M2101',
    8e12,
    { kind: 'free' },
    { passed: true, temperature: 33, powerOnHours: 12, reallocated: 0, pending: 0, wear: null },
    { dev: 'sde' },
  ),
  D(
    'nvme-Samsung_SSD_980_500GB_S64ANJ0R123456',
    'Samsung SSD 980 500GB',
    5e11,
    { kind: 'os' },
    { passed: true, temperature: 44, powerOnHours: 9200, reallocated: null, pending: null, wear: 4 },
    { dev: 'nvme0n1', tran: 'nvme', rot: false },
  ),
];
const poolSummary = [
  { name: 'tank', health: 'ONLINE', size: 3.96e12, allocated: 2.31e12, free: 1.65e12, capacity: 58, fragmentation: 9 },
  { name: 'vault', health: 'DEGRADED', size: 7.9e12, allocated: 1.2e12, free: 6.7e12, capacity: 15, fragmentation: 2 },
];
const vd = (name, state, children = [], note = null) => ({ name, state, read: 0, write: 0, cksum: 0, note, children });
const pools = {
  tank: {
    ...poolSummary[0],
    status: null,
    action: null,
    errors: 'No known data errors',
    scan: 'scrub repaired 0B in 03:12:41 with 0 errors on Sun Sep  7 03:12:41 2026',
    scrub: {
      pool: 'tank',
      kind: 'scrub',
      state: 'finished',
      text: 'scrub repaired 0B in 03:12:41 with 0 errors on Sun Sep  7 03:12:41 2026',
      percent: null,
      finishedAt: ago(140),
      errors: 0,
    },
    vdevs: [vd('tank', 'ONLINE', [vd('mirror-0', 'ONLINE', [vd(disks[0].id, 'ONLINE'), vd(disks[1].id, 'ONLINE')])])],
  },
  vault: {
    ...poolSummary[1],
    status: 'One or more devices has been removed by the administrator. Sufficient replicas exist for the pool to continue functioning in a degraded state.',
    action: 'Online the device using zpool online or replace the device with zpool replace.',
    errors: 'No known data errors',
    scan: 'resilver in progress since Sun Sep 13 09:02:11 2026\n\t420G / 1.2T scanned at 210M/s, 388G / 1.2T issued at 190M/s\n\t388G resilvered, 32.34% done, 01:12:03 to go',
    scrub: {
      pool: 'vault',
      kind: 'resilver',
      state: 'running',
      text: 'resilver in progress since Sun Sep 13 09:02:11 2026',
      percent: 32.34,
      finishedAt: null,
      errors: 0,
    },
    vdevs: [
      vd('vault', 'DEGRADED', [
        vd('mirror-0', 'DEGRADED', [
          vd('replacing-0', 'DEGRADED', [
            vd('3921047123412', 'REMOVED', [], 'was /dev/disk/by-id/ata-ST8000VN004-2M2101_WSD3F6XX-part1'),
            vd(disks[2].id, 'ONLINE', [], '(resilvering)'),
          ]),
          vd(disks[3].id, 'ONLINE'),
        ]),
      ]),
    ],
  },
};
const ds = (name, used, avail, mp, extra = {}) => ({
  name,
  pool: name.split('/')[0],
  type: 'filesystem',
  used,
  available: avail,
  referenced: used,
  mountpoint: mp,
  mounted: true,
  quota: null,
  compression: 'lz4',
  compressratio: 1.12,
  atime: false,
  recordsize: 131072,
  creation: ago(4000),
  ...extra,
});
const datasets = [
  ds('tank', 2.31e12, 1.65e12, '/tank'),
  ds('tank/photos', 1.4e12, 6e11, '/srv/locations/photos', { quota: 2e12, compression: 'zstd', compressratio: 1.03 }),
  ds('tank/docs', 8.2e10, 1.65e12, '/srv/locations/docs', { compression: 'zstd', compressratio: 1.61 }),
  ds('tank/music', 3.1e11, 1.65e12, '/srv/locations/music'),
  ds('tank/timemachine', 5.1e11, 4.9e11, '/tank/timemachine', { quota: 1e12 }),
  ds('vault', 1.2e12, 6.7e12, '/vault'),
  ds('vault/backup', 1.19e12, 6.7e12, '/vault/backup'),
  ds('vault/backup/photos', 1.19e12, 6.7e12, '/vault/backup/photos'),
];
const snap = (dataset, snapshot, h, used) => ({ name: `${dataset}@${snapshot}`, dataset, snapshot, used, referenced: 1e11, creation: ago(h) });
const snapshots = [
  ...[1, 2, 3, 4, 5, 6].map((i) => snap('tank/photos', `auto-hourly-2026-09-13_${String(11 - i).padStart(2, '0')}-00`, i, 2e6 * i)),
  ...[1, 2, 3].map((i) => snap('tank/photos', `auto-daily-2026-09-1${3 - i}_03-00`, 24 * i, 4e8 * i)),
  snap('tank/docs', 'auto-daily-2026-09-12_03-00', 30, 1.2e8),
  snap('tank/docs', 'before-cleanup', 200, 9e9),
  snap('vault/backup/photos', 'repl-2026-09-13_02-00', 8, 0),
];
const policies = [
  { dataset: 'tank/photos', hourly: 24, daily: 7, weekly: 4, monthly: 3, updatedAt: ago(3000) },
  { dataset: 'tank/docs', hourly: 0, daily: 14, weekly: 8, monthly: 6, updatedAt: ago(3000) },
];
const shares = [
  {
    dataset: 'tank/photos',
    name: 'photos',
    mountpoint: '/srv/locations/photos',
    smb: true,
    timeMachine: false,
    nfs: true,
    nfsClients: ['192.168.1.0/24'],
    updatedAt: ago(500),
  },
  {
    dataset: 'tank/timemachine',
    name: 'timemachine',
    mountpoint: '/tank/timemachine',
    smb: true,
    timeMachine: true,
    nfs: false,
    nfsClients: [],
    updatedAt: ago(500),
  },
];
const job = (id, kind, extra) => ({
  id,
  kind,
  replicationId: null,
  pool: null,
  target: '',
  state: 'done',
  startedAt: ago(10),
  finishedAt: ago(9),
  progress: 100,
  bytes: 0,
  total: null,
  message: null,
  ...extra,
});
const jobs = [
  job(9, 'resilver', { pool: 'vault', target: 'vault', state: 'running', startedAt: ago(1.2), finishedAt: null, progress: 32.3 }),
  job(8, 'replication', {
    replicationId: 1,
    target: 'tank/photos → admin@backup-host:backup/photos',
    startedAt: ago(8),
    finishedAt: ago(7.8),
    bytes: 3.2e9,
    total: 3.2e9,
    message: 'incremental from repl-2026-09-12_02-00 to repl-2026-09-13_02-00, 3.2 GB',
  }),
  job(7, 'scrub', {
    pool: 'tank',
    target: 'tank',
    startedAt: ago(143),
    finishedAt: ago(140),
    message: 'scrub repaired 0B in 03:12:41 with 0 errors on Sun Sep  7 03:12:41 2026',
  }),
  job(6, 'scrub', {
    pool: 'vault',
    target: 'vault',
    startedAt: ago(300),
    finishedAt: ago(296),
    state: 'failed',
    message: 'scrub repaired 12K in 04:01:10 with 3 errors on Mon Sep  1 04:01:10 2026',
  }),
  job(5, 'scrub', {
    pool: 'tank',
    target: 'tank',
    startedAt: ago(860),
    finishedAt: ago(857),
    message: 'scrub repaired 0B in 03:05:00 with 0 errors on Fri Aug  8 03:05:00 2026',
  }),
  job(4, 'replication', {
    replicationId: 1,
    target: 'tank/photos → admin@backup-host:backup/photos',
    startedAt: ago(32),
    finishedAt: ago(31.7),
    bytes: 1.1e9,
    total: 1.1e9,
    message: 'incremental, 1.1 GB',
  }),
];
const replications = [
  {
    id: 1,
    dataset: 'tank/photos',
    host: 'backup-host',
    user: 'admin',
    port: 22,
    targetDataset: 'backup/photos',
    recursive: false,
    schedule: 'daily',
    keep: 3,
    lastRunAt: ago(8),
    lastResult: 'ok',
    lastMessage: 'incremental from repl-2026-09-12_02-00 to repl-2026-09-13_02-00, 3.2 GB',
    running: null,
    createdAt: ago(3000),
  },
];
const events = [
  {
    eid: 812,
    time: ago(1.3),
    class: 'resource.fs.zfs.statechange',
    pool: 'vault',
    vdev: 'ata-ST8000VN004-2M2101_WSD3F6XX',
    state: 'REMOVED',
    prevState: 'ONLINE',
    summary: 'vault: ata-ST8000VN004-2M2101_WSD3F6XX went REMOVED (was ONLINE)',
    matters: true,
    count: 1,
  },
  {
    eid: 790,
    time: ago(5),
    class: 'ereport.fs.zfs.checksum',
    pool: 'tank',
    vdev: disks[1].id,
    state: null,
    prevState: null,
    summary: `tank: checksum error on ${disks[1].id}`,
    matters: true,
    count: 4,
  },
];
const point = (i) => ({
  at: new Date(now - (360 - i) * 5000).toISOString(),
  cpu: 4 + 30 * Math.abs(Math.sin(i / 25)),
  load: 0.4 + Math.sin(i / 40) * 0.3,
  memoryUsed: 6.1e9 + i * 1e6,
  rx: 2e6 + 1.5e7 * Math.max(0, Math.sin(i / 30)),
  tx: 8e5,
  read: 1.9e8 * Math.abs(Math.cos(i / 50)),
  write: 4e7,
  temp: 46,
});
const system = () => ({
  hostname: 'nas',
  uptime: 41 * 86400 + 3600 * 5,
  cores: 4,
  now: {
    at: new Date().toISOString(),
    cpu: 23.5,
    load: [0.62, 0.71, 0.55],
    memory: { total: 16.4e9, used: 6.2e9, available: 10.2e9 },
    swap: { total: 4.1e9, used: 0 },
    net: [{ name: 'enp3s0', rx: 1.2e7, tx: 8.3e5 }],
    disks: [
      { dev: 'sda', read: 0, write: 3e5, busy: 2 },
      { dev: 'sdb', read: 0, write: 3e5, busy: 2 },
      { dev: 'sdc', read: 2.1e8, write: 1.9e8, busy: 91 },
      { dev: 'sdd', read: 2.0e8, write: 0, busy: 88 },
      { dev: 'sde', read: 0, write: 0, busy: 0 },
      { dev: 'nvme0n1', read: 1e5, write: 2e6, busy: 1 },
    ],
    temps: [
      { sensor: 'coretemp', label: 'Package id 0', celsius: 46 },
      { sensor: 'nvme', label: 'Composite', celsius: 44 },
    ],
  },
  history: Array.from({ length: 360 }, (_, i) => point(i)),
  disks: disks.map((d) => ({ dev: d.dev.slice(5), id: d.id, pool: d.use.kind === 'pool' ? d.use.pool : null })),
});
const network = () => ({
  hostname: 'nas',
  mdns: true,
  gateway: '192.168.1.1',
  dns: ['192.168.1.1', '1.1.1.1'],
  interfaces: [
    {
      name: 'enp3s0',
      mac: '02:00:00:00:00:01',
      up: true,
      speed: 2500,
      addresses: ['192.168.1.40/24'],
      dhcp: false,
      configured: { dhcp: false, address: '192.168.1.40/24', gateway: '192.168.1.1', dns: ['192.168.1.1', '1.1.1.1'] },
    },
    { name: 'enp4s0', mac: '02:00:00:00:00:02', up: false, speed: null, addresses: [], dhcp: false, configured: null },
  ],
  pending: null,
});
const health = () => ({
  ok: false,
  pools: poolSummary.map((p) => ({ name: p.name, health: p.health, capacity: p.capacity, ok: p.health === 'ONLINE' })),
  disks: disks.map((d) => ({ id: d.id, ok: !(d.smart?.pending > 0), reason: d.smart?.pending > 0 ? `${d.smart.pending} pending sectors` : null })),
  problems: [
    'Pool vault is DEGRADED (3921047123412 REMOVED) — Online the device using zpool online or replace the device with zpool replace.',
    `Disk ${disks[1].id}: 2 pending sectors`,
  ],
  events,
});
const smart = (id) => {
  const d = disks.find((x) => x.id === id);
  return {
    id,
    model: d.model,
    serial: d.serial,
    firmware: '81.00A81',
    ...d.smart,
    selfTest: {
      running: id === disks[2].id ? { kind: 'long', percentDone: 40 } : null,
      tests: [
        { kind: 'long', passed: true, result: 'Completed without error', hours: 9000 },
        { kind: 'short', passed: true, result: 'Completed without error', hours: 8800 },
      ],
    },
    raw: {
      ata_smart_attributes: {
        table: [
          { id: 5, name: 'Reallocated_Sector_Ct', value: 200, worst: 200, thresh: 140, raw: { value: 0 } },
          { id: 194, name: 'Temperature_Celsius', value: 112, worst: 95, thresh: 0, raw: { value: 38 } },
          { id: 197, name: 'Current_Pending_Sector', value: 200, worst: 200, thresh: 0, raw: { value: d.smart.pending ?? 0 } },
        ],
      },
    },
  };
};
const answers = {
  version: () => ({ agent: '0.4.4', contract: 2, node: 'v24.21.0', zfs: 'zfs-2.2.2', smartctl: '7.4', hostname: 'nas' }),
  disks: () => disks,
  smart: (a) => smart(a.disk),
  pools: () => poolSummary,
  pool: (a) => pools[a.pool],
  datasets: (a) => datasets.filter((d) => !a?.pool || d.pool === a.pool),
  snapshots: (a) => snapshots.filter((s) => !a?.dataset || s.dataset === a.dataset || s.dataset.startsWith(a.dataset + '/')),
  scrubs: () => [pools.tank.scrub, pools.vault.scrub],
  health,
  jobs: (a) => jobs.filter((j) => (a?.pool ? j.pool === a.pool : a?.replicationId ? j.replicationId === a.replicationId : true)),
  events: () => events,
  system,
  network,
  policies: () => policies,
  'scrub.policies': () => [
    { pool: 'tank', interval: 'monthly', updatedAt: null },
    { pool: 'vault', interval: 'weekly', updatedAt: ago(100) },
  ],
  backup: () => ({
    dataset: 'vault/backup/settings',
    lastAt: ago(6),
    lastResult: 'ok',
    lastMessage: '7 files',
    snapshots: 30,
    files: ['mk-nas.db', 'passdb.tdb', 'ssh/id_ed25519', 'ssh/id_ed25519.pub', 'ssh/known_hosts', 'mk-drive.env', 'mk-drive.db'],
    takenAt: ago(6),
  }),
  shares: () => shares,
  users: () => [{ name: 'admin', hasPassword: true, createdAt: ago(500) }],
  replications: () => replications,
  'replication.key': () => ({ publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample mk-nas@nas' }),
  'pool.importable': () => [],
};
// ---- an empty box ----
if (EMPTY) {
  disks.splice(
    0,
    disks.length,
    D(
      'ata-WDC_WD40EFZX-68AWUN0_WD-WX32D41B1A2C',
      'WDC WD40EFZX-68AWUN0',
      4e12,
      { kind: 'free' },
      { passed: true, temperature: 31, powerOnHours: 14, reallocated: 0, pending: 0, wear: null },
      { dev: 'sda' },
    ),
    D(
      'ata-WDC_WD40EFZX-68AWUN0_WD-WX32D41B3D4E',
      'WDC WD40EFZX-68AWUN0',
      4e12,
      { kind: 'free' },
      { passed: true, temperature: 32, powerOnHours: 14, reallocated: 0, pending: 0, wear: null },
      { dev: 'sdb' },
    ),
    D(
      'ata-ST2000DM008-2FR102_ZFL0ABCD',
      'ST2000DM008-2FR102',
      2e12,
      { kind: 'other', what: 'ntfs' },
      { passed: true, temperature: 35, powerOnHours: 21000, reallocated: 0, pending: 0, wear: null },
      { dev: 'sdc' },
    ),
    D(
      'nvme-Samsung_SSD_980_500GB_S64ANJ0R654321',
      'Samsung SSD 980 500GB',
      5e11,
      { kind: 'os' },
      { passed: true, temperature: 41, powerOnHours: 14, reallocated: null, pending: null, wear: 0 },
      { dev: 'nvme0n1', tran: 'nvme', rot: false },
    ),
  );
  poolSummary.length = 0;
  for (const k of Object.keys(pools)) delete pools[k];
  for (const list of [datasets, snapshots, policies, shares, jobs, replications, events]) list.length = 0;
  Object.assign(answers, {
    health: () => ({
      ok: true,
      pools: poolSummary.map((p) => ({ name: p.name, health: p.health, capacity: p.capacity, ok: true })),
      disks: disks.map((d) => ({ id: d.id, ok: true, reason: null })),
      problems: [],
      events: [],
    }),
    scrubs: () => Object.values(pools).map((p) => p.scrub),
    'scrub.policies': () => [],
    backup: () => ({ dataset: null, lastAt: null, lastResult: null, lastMessage: null, snapshots: 0, files: [], takenAt: null }),
    users: () => [],
  });
  if (FOREIGN) {
    for (const d of disks.slice(0, 2)) d.use = { kind: 'pool', pool: 'ARCHIVE', imported: false };
    answers['pool.importable'] = () =>
      disks.some((d) => d.use.kind === 'pool' && d.use.imported === false)
        ? [
            {
              name: 'ARCHIVE',
              id: '7755940926647500001',
              state: 'ONLINE',
              status: null,
              action: 'The pool can be imported using its name or numeric identifier.',
              devices: disks.slice(0, 2).map((d) => d.id),
            },
          ]
        : [];
  }
}

// ---- the verbs that make something ----
class BadArgs extends Error {
  code = 'bad-args';
}
const MIN = { single: 1, mirror: 2, raidz1: 3, raidz2: 4 };
Object.assign(answers, {
  'disk.wipe': (a) => {
    const d = disks.find((x) => x.id === a?.disk);
    if (!d) throw new BadArgs(`${a?.disk}: no such disk`);
    if (a.confirm !== d.id) throw new BadArgs(`type the name "${d.id}" to confirm`);
    if (d.use.kind === 'os' || (d.use.kind === 'pool' && d.use.imported !== false)) throw new BadArgs(`${d.id}: in use`);
    d.use = { kind: 'free' };
    return d;
  },
  'pool.create': (a) => {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(a?.name ?? '')) throw new BadArgs('name: not a pool name');
    if (pools[a.name]) throw new BadArgs(`a pool named ${a.name} exists`);
    if (a.confirm !== a.name) throw new BadArgs('confirm: must equal the pool name');
    const picked = (a.disks ?? []).map((id) => disks.find((d) => d.id === id));
    if (picked.some((d) => !d || d.use.kind !== 'free')) throw new BadArgs('disks: only free disks');
    if (!MIN[a.layout] || picked.length < MIN[a.layout] || (a.layout === 'single' && picked.length !== 1))
      throw new BadArgs(`disks: ${a.layout} needs at least ${MIN[a.layout]}`);
    const smallest = Math.min(...picked.map((d) => d.size));
    const usable = { single: smallest, mirror: smallest, raidz1: (picked.length - 1) * smallest, raidz2: (picked.length - 2) * smallest }[a.layout] * 0.96;
    for (const d of picked) d.use = { kind: 'pool', pool: a.name };
    const summary = { name: a.name, health: 'ONLINE', size: usable, allocated: 1e6, free: usable - 1e6, capacity: 0, fragmentation: 0 };
    poolSummary.push(summary);
    const members = picked.map((d) => vd(d.id, 'ONLINE'));
    pools[a.name] = {
      ...summary,
      status: null,
      action: null,
      errors: 'No known data errors',
      scan: null,
      scrub: { pool: a.name, kind: 'scrub', state: 'none', text: null, percent: null, finishedAt: null, errors: null },
      vdevs: [vd(a.name, 'ONLINE', a.layout === 'single' ? members : [vd(`${a.layout}-0`, 'ONLINE', members)])],
    };
    datasets.push(ds(a.name, 1e6, usable, `/${a.name}`, { creation: new Date().toISOString() }));
    return pools[a.name];
  },
  'dataset.create': (a) => {
    const [pool, ...rest] = String(a?.name ?? '').split('/');
    if (!pools[pool] || rest.length === 0 || !rest.every((r) => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(r))) throw new BadArgs('name: not a dataset name');
    if (datasets.some((d) => d.name === a.name)) throw new BadArgs(`${a.name} exists`);
    const mountpoint = a.location ? `/srv/locations/${basename(a.name)}` : `/${a.name}`;
    if (a.location && process.env.FAKE_NAS_LOCATIONS) mkdirSync(join(process.env.FAKE_NAS_LOCATIONS, basename(a.name)), { recursive: true });
    const d = ds(a.name, 1e5, pools[pool].free, mountpoint, {
      quota: a.quota ?? null,
      compression: a.compression ?? 'lz4',
      atime: a.atime ?? false,
      creation: new Date().toISOString(),
    });
    datasets.push(d);
    return d;
  },
  'policy.set': (a) => {
    if (!datasets.some((d) => d.name === a?.dataset)) throw new BadArgs('dataset: not found');
    const p = {
      dataset: a.dataset,
      hourly: a.hourly ?? 0,
      daily: a.daily ?? 0,
      weekly: a.weekly ?? 0,
      monthly: a.monthly ?? 0,
      updatedAt: new Date().toISOString(),
    };
    const i = policies.findIndex((x) => x.dataset === a.dataset);
    if (i >= 0) policies[i] = p;
    else policies.push(p);
    return p;
  },
});

const failOnce = new Set((process.env.FAKE_NAS_FAIL_ONCE ?? '').split(',').filter(Boolean));
createServer((c) => {
  let buf = '';
  c.setEncoding('utf8');
  c.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const fn = answers[req.verb];
      let res;
      try {
        if (failOnce.delete(req.verb)) throw Object.assign(new Error(`fake: ${req.verb} failed on purpose (FAKE_NAS_FAIL_ONCE)`), { code: 'command-failed' });
        res = fn ? { id: req.id, ok: true, result: fn(req.args) } : { id: req.id, ok: false, error: { code: 'unknown-verb', message: `fake: no ${req.verb}` } };
      } catch (e) {
        res = { id: req.id, ok: false, error: { code: e.code ?? 'internal', message: e.message } };
      }
      c.write(JSON.stringify(res) + '\n');
    }
  });
  c.on('error', () => {});
}).listen(sock, () => console.log(`fake agent on ${sock}${EMPTY ? ' (an empty box)' : ''}`));
