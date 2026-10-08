/** Standard base64 (RFC 4648) – port of sync_folder.rs `b64_encode/b64_decode`. */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Map<string, number>([...B64].map((c, i) => [c, i]));

/** Encodes WITH '=' padding, like Rust. */
export function b64Encode(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i] ?? 0;
    const b1 = data[i + 1] ?? 0;
    const b2 = data[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    const len = Math.min(3, data.length - i);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += len > 1 ? B64[(n >> 6) & 63] : '=';
    out += len > 2 ? B64[n & 63] : '=';
  }
  return out;
}

/**
 * Decodes padded or unpadded input. Like Rust, every '=' is dropped first and
 * a trailing group of one character (or any foreign character) yields null.
 */
export function b64Decode(text: string): Uint8Array | null {
  const cleaned = text.replace(/=/g, '');
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 4) {
    const chunk = cleaned.slice(i, i + 4);
    let n = 0;
    for (const c of chunk) {
      const v = LOOKUP.get(c);
      if (v === undefined) return null;
      n = n * 64 + v;
    }
    switch (chunk.length) {
      case 4:
        out.push((n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
        break;
      case 3:
        n *= 64;
        out.push((n >>> 16) & 0xff, (n >>> 8) & 0xff);
        break;
      case 2:
        n *= 4096;
        out.push((n >>> 16) & 0xff);
        break;
      default:
        return null;
    }
  }
  return Uint8Array.from(out);
}
