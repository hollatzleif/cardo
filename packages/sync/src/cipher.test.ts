import { describe, expect, it } from 'vitest';

import { toHex } from './bytes';
import { openRaw, sealRaw, SyncCipher } from './cipher';
import { deriveKeys, generateSyncKey } from './keys';

const hex = (s: string) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g)!.map((b) => parseInt(b, 16)));
const enc = (s: string) => new TextEncoder().encode(s);
const cipher = () => new SyncCipher(deriveKeys(generateSyncKey()).dataKey);

describe('XChaCha20-Poly1305', () => {
  it('matches draft-irtf-cfrg-xchacha-03 A.3.1', () => {
    const plaintext = enc(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const aad = hex('50515253c0c1c2c3c4c5c6c7');
    const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = hex('404142434445464748494a4b4c4d4e4f5051525354555657');
    const ciphertext =
      'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
      '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
      '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
      '21f9664c97637da9768812f615c68b13b52e';
    const tag = 'c0875924c1c7987947deafd8780acf49';
    const sealed = sealRaw(key, nonce, aad, plaintext);
    expect(toHex(sealed)).toBe(ciphertext + tag);
    expect(new TextDecoder().decode(openRaw(key, nonce, aad, sealed))).toContain('sunscreen');
  });

  it('SyncCipher layout is nonce || ciphertext || tag with the op id as AAD', () => {
    const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = hex('404142434445464748494a4b4c4d4e4f5051525354555657');
    const blob = new SyncCipher(key).encrypt('op-1', enc('hello'), nonce);
    expect(toHex(blob.subarray(0, 24))).toBe(toHex(nonce));
    expect(toHex(blob.subarray(24))).toBe(toHex(sealRaw(key, nonce, enc('op-1'), enc('hello'))));
    expect(blob.length).toBe(24 + 5 + 16);
  });

  it('roundtrip', () => {
    const c = cipher();
    expect(new TextDecoder().decode(c.decrypt('op-1', c.encrypt('op-1', enc('hello sync'))))).toBe('hello sync');
  });

  it('nonce is random per op', () => {
    const c = cipher();
    expect(toHex(c.encrypt('op-1', enc('same')))).not.toBe(toHex(c.encrypt('op-1', enc('same'))));
  });

  it('wrong key, swapped op id, tampering and short blobs fail', () => {
    const c = cipher();
    const blob = c.encrypt('op-1', enc('secret'));
    expect(() => cipher().decrypt('op-1', blob)).toThrow('wrong key or tampered');
    expect(() => c.decrypt('op-2', blob)).toThrow('wrong key or tampered');
    const tampered = Uint8Array.from(blob);
    tampered[tampered.length - 1]! ^= 0x01;
    expect(() => c.decrypt('op-1', tampered)).toThrow('wrong key or tampered');
    expect(() => c.decrypt('op-1', new Uint8Array(10))).toThrow('too short');
    expect(() => c.decrypt('op-1', new Uint8Array(24))).toThrow('too short');
  });
});
