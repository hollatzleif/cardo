import { describe, expect, it } from 'vitest';

import { base32Decode, base32Encode } from './base32';
import { toHex } from './bytes';
import { deriveKeys, displaySyncKey, generateSyncKey, parseSyncKey } from './keys';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const payloadPositions = (shown: string) => [...shown].map((c, i) => (c === '-' ? -1 : i)).filter((i) => i >= 0);
const replaceAt = (s: string, i: number, c: string) => s.slice(0, i) + c + s.slice(i + 1);

describe('sync keys', () => {
  it('generate → display → parse roundtrip', () => {
    const key = generateSyncKey();
    const shown = displaySyncKey(key);
    expect(shown.startsWith('CRD1-')).toBe(true);
    const parsed = parseSyncKey(shown);
    expect(toHex(parsed.licenseId)).toBe(toHex(key.licenseId));
    expect(toHex(parsed.secret)).toBe(toHex(key.secret));
  });

  it('forgives case, whitespace and dashes', () => {
    const key = generateSyncKey();
    const sloppy = `  ${displaySyncKey(key).toLowerCase().replace(/-/g, ' ')}  `;
    expect(toHex(parseSyncKey(sloppy).secret)).toBe(toHex(key.secret));
  });

  it('detects a typo in any character but the last', () => {
    for (let round = 0; round < 20; round++) {
      const shown = displaySyncKey(generateSyncKey());
      const positions = payloadPositions(shown);
      for (const idx of positions.slice(0, -1)) {
        const typo = replaceAt(shown, idx, shown[idx] === 'A' ? 'B' : 'A');
        expect(() => parseSyncKey(typo), `typo at ${idx}: ${typo}`).toThrow();
      }
    }
  });

  it('a typo in the final character never yields a different key', () => {
    for (let round = 0; round < 50; round++) {
      const key = generateSyncKey();
      const shown = displaySyncKey(key);
      const last = payloadPositions(shown).at(-1)!;
      for (const c of ALPHABET) {
        let parsed;
        try {
          parsed = parseSyncKey(replaceAt(shown, last, c));
        } catch {
          continue;
        }
        expect(toHex(parsed.secret)).toBe(toHex(key.secret));
        expect(toHex(parsed.licenseId)).toBe(toHex(key.licenseId));
      }
    }
  });

  it('derivation is deterministic and domain separated', () => {
    const key = generateSyncKey();
    const a = deriveKeys(key);
    const b = deriveKeys(key);
    expect(a.authToken).toBe(b.authToken);
    expect(toHex(a.dataKey)).toBe(toHex(b.dataKey));
    expect(a.licenseId).toBe(b.licenseId);
    expect(a.authToken).not.toBe(toHex(a.dataKey));
    expect(a.authToken).toHaveLength(64);
    expect(a.licenseId).toHaveLength(16);
    const other = deriveKeys(generateSyncKey());
    expect(other.authToken).not.toBe(a.authToken);
    expect(toHex(other.dataKey)).not.toBe(toHex(a.dataKey));
  });

  it('rejects foreign and broken input with the Rust messages', () => {
    expect(() => parseSyncKey('')).toThrow('missing CRD1');
    expect(() => parseSyncKey('HELLO-WORLD')).toThrow('missing CRD1');
    expect(() => parseSyncKey('CRD1-TOO-SHORT')).toThrow('wrong length');
    expect(() => parseSyncKey('CRD1-AAAA')).toThrow('wrong length');
    expect(() => parseSyncKey('CRD1-1111')).toThrow('invalid characters');
    // Valid length + checksum layout but version 0x02.
    const shown = displaySyncKey(generateSyncKey());
    const payload = base32Decode(shown.slice(5).replace(/-/g, ''))!;
    payload[0] = 0x02;
    expect(() => parseSyncKey(`CRD1${base32Encode(payload)}`)).toThrow('unsupported sync key version 0x02');
  });

  it('base32 roundtrip', () => {
    for (let len = 0; len < 40; len++) {
      const data = Uint8Array.from({ length: len }, (_, i) => i);
      expect([...base32Decode(base32Encode(data))!]).toEqual([...data]);
    }
  });
});
