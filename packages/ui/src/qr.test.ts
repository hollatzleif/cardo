import { describe, expect, it } from 'vitest';
import { qrMatrix } from './qr';

/** Same BCH computation the encoder uses – kept in the test as an oracle. */
function expectedFormatBits(mask: number): number {
  const data = mask; // EC level M = 0b00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function bitAt(m: boolean[][], row: number, col: number): number {
  return m[row]?.[col] ? 1 : 0;
}

/** Read the 15 format bits from the copy around the top-left finder. */
function extractFormatCopy1(m: boolean[][]): number {
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= bitAt(m, i, 8) << i;
  bits |= bitAt(m, 7, 8) << 6;
  bits |= bitAt(m, 8, 8) << 7;
  bits |= bitAt(m, 8, 7) << 8;
  for (let i = 9; i <= 14; i++) bits |= bitAt(m, 8, 14 - i) << i;
  return bits;
}

/** Read the 15 format bits from the split copy (top-right + bottom-left). */
function extractFormatCopy2(m: boolean[][]): number {
  const size = m.length;
  let bits = 0;
  for (let i = 0; i <= 7; i++) bits |= bitAt(m, 8, size - 1 - i) << i;
  for (let i = 8; i <= 14; i++) bits |= bitAt(m, size - 15 + i, 8) << i;
  return bits;
}

/** The expected 7×7 finder pattern cell (concentric rings). */
function finderCell(dy: number, dx: number): boolean {
  return Math.max(Math.abs(dx - 3), Math.abs(dy - 3)) !== 2;
}

function expectFinderAt(m: boolean[][], top: number, left: number): void {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      expect(m[top + dy]?.[left + dx], `finder cell (${top + dy}, ${left + dx})`).toBe(
        finderCell(dy, dx),
      );
    }
  }
}

describe('qrMatrix', () => {
  it('returns a square, quiet-zone-free matrix of the version-1 size for a short string', () => {
    const m = qrMatrix('CARDO');
    expect(m).not.toBeNull();
    expect(m!.length).toBe(21); // 21 + 4·(v−1) with v = 1
    for (const row of m!) expect(row.length).toBe(21);
  });

  it('picks the smallest fitting version (byte capacities for level M)', () => {
    // v1 fits 14 bytes, v2 fits 26, v3 starts at 27, v10 tops out at 213.
    expect(qrMatrix('a'.repeat(14))!.length).toBe(21);
    expect(qrMatrix('a'.repeat(15))!.length).toBe(25);
    expect(qrMatrix('a'.repeat(26))!.length).toBe(25);
    expect(qrMatrix('a'.repeat(27))!.length).toBe(29);
    expect(qrMatrix('a'.repeat(213))!.length).toBe(57); // version 10
  });

  it('returns null when the payload exceeds the version-10 capacity', () => {
    expect(qrMatrix('a'.repeat(214))).toBeNull();
  });

  it('encodes input as UTF-8 (multi-byte characters shrink the capacity)', () => {
    expect(qrMatrix('ü'.repeat(106))).not.toBeNull(); // 212 bytes → fits v10
    expect(qrMatrix('ü'.repeat(107))).toBeNull(); // 214 bytes → too long
  });

  it('places finder patterns at three corners', () => {
    const m = qrMatrix('CARDO')!;
    const size = m.length;
    expectFinderAt(m, 0, 0);
    expectFinderAt(m, 0, size - 7);
    expectFinderAt(m, size - 7, 0);
  });

  it('draws alternating timing patterns in row and column 6', () => {
    const m = qrMatrix('CARDO')!;
    const size = m.length;
    for (let i = 8; i <= size - 9; i++) {
      expect(m[6]?.[i], `timing row cell ${i}`).toBe(i % 2 === 0);
      expect(m[i]?.[6], `timing column cell ${i}`).toBe(i % 2 === 0);
    }
  });

  it('sets the dark module at (4·version + 9, 8)', () => {
    for (const [text, version] of [
      ['CARDO', 1],
      ['a'.repeat(20), 2],
    ] as const) {
      const m = qrMatrix(text)!;
      expect(m.length).toBe(4 * version + 17);
      expect(m[4 * version + 9]?.[8]).toBe(true);
    }
  });

  it('embeds BCH-valid format info for level M, identical in both copies', () => {
    const m = qrMatrix('https://example.org/cardo')!;
    const copy1 = extractFormatCopy1(m);
    const copy2 = extractFormatCopy2(m);
    expect(copy1).toBe(copy2);
    const valid = Array.from({ length: 8 }, (_, mask) => expectedFormatBits(mask));
    expect(valid).toContain(copy1);
    // Decoded EC-level bits must be 00 = level M.
    const dataBits = (copy1 ^ 0x5412) >>> 10;
    expect(dataBits >>> 3).toBe(0b00);
  });

  it('produces distinct format info for each of the 8 masks', () => {
    const all = new Set(Array.from({ length: 8 }, (_, mask) => expectedFormatBits(mask)));
    expect(all.size).toBe(8);
  });

  it('is deterministic – encoding the same string twice yields identical matrices', () => {
    const a = qrMatrix('WIFI:T:WPA;S:cardo;P:secret;;');
    const b = qrMatrix('WIFI:T:WPA;S:cardo;P:secret;;');
    expect(a).toEqual(b);
  });

  it('carries no quiet zone – the border rows/columns contain finder darkness', () => {
    const m = qrMatrix('CARDO')!;
    expect(m[0]?.some(Boolean)).toBe(true);
    expect(m[m.length - 1]?.some(Boolean)).toBe(true);
    expect(m.map((row) => row[0]).some(Boolean)).toBe(true);
  });
});
