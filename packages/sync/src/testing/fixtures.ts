/**
 * Node-only access to the cross-language fixtures that the Rust core
 * produces and verifies (crates/cardo-core/tests/fixtures/sync-v1, see the
 * README there). Rust is the reference; the TS port must pass every file.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, from packages/sync/src/testing/. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const SYNC_V1_DIR = join(REPO_ROOT, 'crates', 'cardo-core', 'tests', 'fixtures', 'sync-v1');

export function fixturePath(...parts: string[]): string {
  return join(SYNC_V1_DIR, ...parts);
}

export function readFixtureText(...parts: string[]): string {
  return readFileSync(fixturePath(...parts), 'utf8');
}

export function readFixture<T = unknown>(...parts: string[]): T {
  return JSON.parse(readFixtureText(...parts)) as T;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`bad hex at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

/** Batch file names of a hub folder in pull order. */
export function hubFileNames(hubDir: string): string[] {
  return readdirSync(join(hubDir, 'ops'))
    .filter((n) => n.endsWith('.cardo-ops') && !n.startsWith('.'))
    .sort();
}

/** Copies a committed hub to a temp dir – verification never writes into fixtures. */
export function copyHub(hubDir: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'cardo-hub-'));
  cpSync(join(hubDir, 'ops'), join(tmp, 'ops'), { recursive: true });
  return tmp;
}

/** Same layout as Rust `write_json`: pretty, two-space indent, keys sorted, trailing newline. */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) out[key] = sortKeysDeep(rec[key]);
    return out;
  }
  return value;
}

export interface FixtureKey {
  key: string;
  payloadHex: string;
  version: number;
  licenseId: string;
  secretHex: string;
  checkHex: string;
  hkdfSalt: string;
  authToken: string;
  dataKeyHex: string;
}

export function fixtureKey(): FixtureKey {
  return readFixture<FixtureKey>('key.json');
}
