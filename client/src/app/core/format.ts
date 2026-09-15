const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

/**
 * The name other machines on the LAN reach the NAS by: its hostname with .local, which mk-nas answers over mDNS on every
 * install. A bare hostname resolves only where the network's DNS happens to know it. A name with a dot is left alone.
 */
export function lanName(hostname: string): string {
  return !hostname || hostname === '?' || hostname.includes('.') ? hostname : `${hostname}.local`;
}

export function bytes(n: number | undefined | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function dateTime(ms: number): string {
  return ms ? dateFmt.format(new Date(ms)) : '—';
}

/** "just now", "5 min ago", "yesterday", else the date. */
export function ago(ms: number, now = Date.now()): string {
  if (!ms) return '—';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return dayFmt.format(new Date(ms));
}
