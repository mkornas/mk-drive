/**
 * The one EXIF field the drive cares about: when a picture was taken.
 * A small TIFF/IFD walk — no library — over the buffer sharp hands back
 * (`metadata().exif`, an APP1 payload that may start with "Exif\0\0").
 * Returns epoch milliseconds in local time, or null.
 */
const EXIF_IFD = 0x8769;
const DATE_TIME_ORIGINAL = 0x9003;
const DATE_TIME_DIGITIZED = 0x9004;
const DATE_TIME = 0x0132;
const OFFSET_TIME_ORIGINAL = 0x9011;

export function dateTaken(exif: Uint8Array | Buffer | undefined | null): number | null {
  if (!exif || exif.length < 12) return null;
  let buf = Buffer.from(exif.buffer, exif.byteOffset, exif.byteLength);
  if (buf.subarray(0, 6).toString('latin1') === 'Exif\0\0') buf = buf.subarray(6);
  const order = buf.subarray(0, 2).toString('latin1');
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ascii = (tagOffset: number): string | null => {
    const type = u16(tagOffset + 2);
    const count = u32(tagOffset + 4);
    if (type !== 2 || count < 2 || count > 64) return null;
    const at = count <= 4 ? tagOffset + 8 : u32(tagOffset + 8);
    if (at + count > buf.length) return null;
    return buf.subarray(at, at + count - 1).toString('latin1');
  };
  const readIfd = (offset: number): Map<number, number> => {
    const tags = new Map<number, number>();
    if (offset + 2 > buf.length) return tags;
    const n = u16(offset);
    for (let i = 0; i < n && i < 500; i++) {
      const at = offset + 2 + i * 12;
      if (at + 12 > buf.length) break;
      tags.set(u16(at), at);
    }
    return tags;
  };
  const ifd0 = readIfd(u32(4));
  const exifPointer = ifd0.get(EXIF_IFD);
  const sub = exifPointer !== undefined ? readIfd(u32(exifPointer + 8)) : new Map<number, number>();
  const candidates = [sub.get(DATE_TIME_ORIGINAL), sub.get(DATE_TIME_DIGITIZED), ifd0.get(DATE_TIME)];
  for (const at of candidates) {
    if (at === undefined) continue;
    const s = ascii(at);
    const m = s && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (!m || m[1] === '0000') continue;
    const [, y, mo, d, h, mi, se] = m.map(Number);
    const zone = sub.get(OFFSET_TIME_ORIGINAL) !== undefined ? ascii(sub.get(OFFSET_TIME_ORIGINAL)!) : null;
    const z = zone && /^([+-])(\d{2}):(\d{2})$/.exec(zone);
    const ms = z
      ? Date.UTC(y, mo - 1, d, h, mi, se) - (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) * 60_000
      : new Date(y, mo - 1, d, h, mi, se).getTime();
    if (Number.isFinite(ms) && y >= 1900) return ms;
  }
  return null;
}
