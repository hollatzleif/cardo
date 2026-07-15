/**
 * Self-contained QR code matrix generator (ISO/IEC 18004 subset):
 * byte mode, error-correction level M, versions 1–10 (smallest fitting
 * version is picked automatically), all 8 masks evaluated via the
 * penalty rules N1–N4. Dependency-free on purpose – tools render the
 * matrix themselves and the sync settings UI will reuse it for key QRs.
 */

/* ── GF(256) arithmetic (primitive polynomial 0x11D) ─────────────────── */

const GF_EXP: number[] = [];
const GF_LOG: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[((GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)) % 255] ?? 0;
}

/** Reed–Solomon generator polynomial of the given degree (leading 1 omitted). */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1; // start with the monomial x^0
  let root = 1;
  for (let i = 0; i < degree; i++) {
    // Multiply the current product by (x - α^i).
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j] ?? 0, root) ^ (result[j + 1] ?? 0);
    }
    root = gfMul(root, 2);
  }
  return result;
}

/** Remainder of data(x) · x^degree divided by the generator polynomial. */
function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] = (result[i] ?? 0) ^ gfMul(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

/* ── Version tables (error-correction level M only) ──────────────────── */

/** Per version (index 0 = v1): [ecPerBlock, blocks₁, dataPerBlock₁, blocks₂, dataPerBlock₂]. */
const EC_BLOCKS_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
];

/** Alignment pattern center coordinates per version (index 0 = v1). */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const MAX_VERSION = 10;

function dataCapacityBytes(version: number): number {
  const row = EC_BLOCKS_M[version - 1];
  if (!row) return 0;
  const [, g1, d1, g2, d2] = row;
  return g1 * d1 + g2 * d2;
}

/** Maximum payload bytes for byte mode (mode indicator + count field subtracted). */
function byteCapacity(version: number): number {
  const headerBits = 4 + (version <= 9 ? 8 : 16);
  return Math.floor((dataCapacityBytes(version) * 8 - headerBits) / 8);
}

/* ── Data codewords: bit stream, padding, blocks, interleaving ────────── */

function buildCodewords(bytes: readonly number[], version: number): number[] {
  const capacityBits = dataCapacityBytes(version) * 8;
  const bits: number[] = [];
  const pushBits = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  pushBits(4, 4); // byte mode indicator
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  pushBits(0, Math.min(4, capacityBits - bits.length)); // terminator
  if (bits.length % 8 !== 0) pushBits(0, 8 - (bits.length % 8));
  for (let i = 0; bits.length < capacityBits; i++) pushBits(i % 2 === 0 ? 0xec : 0x11, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    data.push(byte);
  }

  const [ecLen, g1, d1, g2, d2] = EC_BLOCKS_M[version - 1] ?? [0, 0, 0, 0, 0];
  const divisor = rsDivisor(ecLen);
  const blocks: Array<{ data: number[]; ec: number[] }> = [];
  let offset = 0;
  for (const [count, dataLen] of [
    [g1, d1],
    [g2, d2],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(offset, offset + dataLen);
      offset += dataLen;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, divisor) });
    }
  }

  const out: number[] = [];
  const maxDataLen = blocks.reduce((max, b) => Math.max(max, b.data.length), 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      const value = block.data[i];
      if (value !== undefined) out.push(value);
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of blocks) out.push(block.ec[i] ?? 0);
  }
  return out;
}

/* ── Format / version information (BCH) ──────────────────────────────── */

/** 15 format bits for EC level M (bits 00) and the given mask, already XOR-masked. */
function formatBits(mask: number): number {
  const data = mask; // (ecBits for M = 0b00) << 3 | mask
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 version bits (only used for versions ≥ 7). */
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/* ── Mask predicates and penalty scoring (rules N1–N4) ───────────────── */

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

const FINDER_SEQ_A = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_SEQ_B = [false, false, false, false, true, false, true, true, true, false, true];

function penaltyScore(modules: ReadonlyArray<readonly boolean[]>, size: number): number {
  const at = (row: number, col: number): boolean => modules[row]?.[col] ?? false;
  let score = 0;

  // N1: runs of ≥ 5 same-colored modules in a row/column.
  // N3: finder-like 1:1:3:1:1 patterns with 4 light modules on one side.
  for (let axis = 0; axis < 2; axis++) {
    const get = axis === 0 ? at : (i: number, j: number) => at(j, i);
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) {
          run++;
          continue;
        }
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
      for (let j = 0; j + 11 <= size; j++) {
        let matchesA = true;
        let matchesB = true;
        for (let k = 0; k < 11; k++) {
          const cell = get(i, j + k);
          if (cell !== FINDER_SEQ_A[k]) matchesA = false;
          if (cell !== FINDER_SEQ_B[k]) matchesB = false;
        }
        if (matchesA) score += 40;
        if (matchesB) score += 40;
      }
    }
  }

  // N2: 2×2 blocks of one color.
  for (let r = 0; r + 1 < size; r++) {
    for (let c = 0; c + 1 < size; c++) {
      const cell = at(r, c);
      if (cell === at(r, c + 1) && cell === at(r + 1, c) && cell === at(r + 1, c + 1)) score += 3;
    }
  }

  // N4: deviation of the dark-module proportion from 50 %.
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (at(r, c)) dark++;
  }
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * Encode `data` (UTF-8) as a QR symbol and return its module matrix
 * (`true` = dark), WITHOUT quiet zone. Byte mode, EC level M, the smallest
 * fitting version 1–10 is picked. Returns `null` when the payload exceeds
 * the version-10 capacity.
 */
export function qrMatrix(data: string): boolean[][] | null {
  const bytes = Array.from(new TextEncoder().encode(data));
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (bytes.length <= byteCapacity(v)) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;

  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunction = (row: number, col: number, dark: boolean): void => {
    const m = modules[row];
    const f = isFunction[row];
    if (m && f && col >= 0 && col < size) {
      m[col] = dark;
      f[col] = true;
    }
  };

  // Timing patterns (drawn first – finders overwrite their ends).
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Finder patterns incl. separators at three corners.
  for (const [cy, cx] of [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const row = cy + dy;
        const col = cx + dx;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(row, col, dist !== 2 && dist !== 4);
      }
    }
  }

  // Alignment patterns (5×5, skipping the three finder corners).
  const centers = ALIGNMENT[version - 1] ?? [];
  for (const row of centers) {
    for (const col of centers) {
      const inFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
      if (inFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(row + dy, col + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Format info areas + the always-dark module (re-drawn per mask below).
  const drawFormat = (mask: number): void => {
    const bits = formatBits(mask);
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFunction(i, 8, bit(i));
    setFunction(7, 8, bit(6));
    setFunction(8, 8, bit(7));
    setFunction(8, 7, bit(8));
    for (let i = 9; i <= 14; i++) setFunction(8, 14 - i, bit(i));
    for (let i = 0; i <= 7; i++) setFunction(8, size - 1 - i, bit(i));
    for (let i = 8; i <= 14; i++) setFunction(size - 15 + i, 8, bit(i));
    setFunction(size - 8, 8, true); // dark module
  };
  drawFormat(0);

  // Version info (two 3×6 blocks) for versions ≥ 7.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  // Zigzag data placement (bottom-right, upward/downward, skipping column 6).
  const codewords = buildCodewords(bytes, version);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if ((isFunction[row]?.[col] ?? true) || bitIndex >= codewords.length * 8) continue;
        const byte = codewords[bitIndex >> 3] ?? 0;
        const m = modules[row];
        if (m) m[col] = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex++;
      }
    }
  }

  // XOR a mask over the data modules (an involution – applying twice undoes it).
  const applyMask = (mask: number): void => {
    for (let row = 0; row < size; row++) {
      const m = modules[row];
      const f = isFunction[row];
      if (!m || !f) continue;
      for (let col = 0; col < size; col++) {
        if (!f[col] && maskAt(mask, row, col)) m[col] = !m[col];
      }
    }
  };

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penaltyScore(modules, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(mask); // undo
  }
  applyMask(bestMask);
  drawFormat(bestMask);

  return modules;
}
