/** UUID helpers: v4 for device ids/file names, v7 for op ids (like Rust `Uuid::now_v7`). */
import { randomBytes } from './bytes';

export function uuidV4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  return format(b);
}

let lastMs = -1;
let lastSeq = 0;

/**
 * RFC 9562 UUIDv7: 48-bit unix ms, version 7, 12-bit rand_a, variant 10,
 * 62 random bits. rand_a is used as a counter seeded randomly per
 * millisecond so ids from one process sort in creation order.
 */
export function uuidV7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  let ms = Math.max(0, Math.floor(nowMs));
  if (ms <= lastMs) {
    ms = lastMs;
    lastSeq += 1;
    if (lastSeq > 0xfff) {
      ms += 1;
      lastSeq = (b[7] ?? 0) & 0x7f;
    }
  } else {
    lastSeq = (((b[6] ?? 0) & 0x07) << 8) | (b[7] ?? 0); // leave headroom
  }
  lastMs = ms;
  // 48-bit big-endian timestamp.
  const hi = Math.floor(ms / 2 ** 16);
  const lo = ms % 2 ** 16;
  b[0] = (hi >>> 24) & 0xff;
  b[1] = (hi >>> 16) & 0xff;
  b[2] = (hi >>> 8) & 0xff;
  b[3] = hi & 0xff;
  b[4] = (lo >>> 8) & 0xff;
  b[5] = lo & 0xff;
  b[6] = 0x70 | ((lastSeq >>> 8) & 0x0f);
  b[7] = lastSeq & 0xff;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  return format(b);
}

function format(b: Uint8Array): string {
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
