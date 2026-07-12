// Node environment – pure source scan, no DOM needed.
//
// Future-proofing guard: bad/no internet must NEVER break Cardo. The rule
// (documented in host/net.ts) is that every fetch() in app and tool code
// goes through fetchWithTimeout – a fetch with a hard AbortSignal timeout –
// and lives inside a try/catch. This test re-checks the rule on every run,
// so a future tool or feature cannot quietly introduce a hanging naked
// fetch() call site.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // apps/desktop/src/host
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const SCAN_ROOTS = [path.join(REPO_ROOT, 'apps', 'desktop', 'src')];

// packages/tools/*/src – resolved with fs, no glob library.
const TOOLS_DIR = path.join(REPO_ROOT, 'packages', 'tools');
for (const entry of fs.readdirSync(TOOLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const srcDir = path.join(TOOLS_DIR, entry.name, 'src');
  if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) SCAN_ROOTS.push(srcDir);
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    // Test files may stub/mock fetch however they like.
    if (entry.name.includes('.test.')) continue;
    out.push(full);
  }
  return out;
}

const NET_TS = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'host', 'net.ts');
const rel = (file: string): string => path.relative(REPO_ROOT, file);

/**
 * Raw `fetch(` call sites in a file. Occurrences of `fetchWithTimeout(` do
 * not match (the char after "fetch" is "W", not "("); a leading word char
 * is rejected so identifiers like `refetch(` don't count, while
 * `window.fetch(` still does.
 */
function rawFetchLines(lines: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/(?<!\w)fetch\(/.test(lines[i] ?? '')) hits.push(i);
  }
  return hits;
}

/**
 * The ONLY sanctioned place for a raw fetch: the body of a local
 * fetchWithTimeout definition – a `return fetch(url, { ...` line within
 * 3 lines after a `function fetchWithTimeout` declaration. (Tools cannot
 * import host code, so packages/tools replicate the tiny helper.)
 */
function isInsideFetchWithTimeoutDefinition(lines: string[], index: number): boolean {
  if (!/return fetch\(url, \{/.test(lines[index] ?? '')) return false;
  for (let back = 1; back <= 3; back++) {
    if (/function fetchWithTimeout\b/.test(lines[index - back] ?? '')) return true;
  }
  return false;
}

interface ScannedFile {
  file: string;
  content: string;
  lines: string[];
  rawFetch: number[];
}

const scanned: ScannedFile[] = SCAN_ROOTS.flatMap(listSourceFiles)
  .filter((file) => path.resolve(file) !== NET_TS)
  .map((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    return { file, content, lines, rawFetch: rawFetchLines(lines) };
  });

const fetchingFiles = scanned.filter((f) => f.rawFetch.length > 0);
const timeoutCallers = scanned.filter((f) => /(?<!\w)fetchWithTimeout\(/.test(f.content));

describe('net-guard: every fetch() goes through fetchWithTimeout and is caught', () => {
  it('sanity: the scanner actually sees the source tree', () => {
    // If these ever fail the walker broke – the guard would be scanning nothing.
    expect(scanned.length).toBeGreaterThan(50);
    expect(
      fetchingFiles.map((f) => rel(f.file)),
      'the weather tool is the known fetchWithTimeout-replicating tool',
    ).toContain(path.join('packages', 'tools', 'weather', 'src', 'index.tsx'));
    expect(
      timeoutCallers.map((f) => rel(f.file)),
      'the inbox feed is a known fetchWithTimeout caller',
    ).toContain(path.join('apps', 'desktop', 'src', 'inbox', 'feed.ts'));
  });

  it('has NO naked fetch call sites outside a fetchWithTimeout definition', () => {
    const offenders: string[] = [];
    for (const f of fetchingFiles) {
      for (const index of f.rawFetch) {
        if (!isInsideFetchWithTimeoutDefinition(f.lines, index)) {
          offenders.push(`${rel(f.file)}:${index + 1}  ${f.lines[index]?.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `Naked fetch() call sites found – route them through fetchWithTimeout ` +
        `(apps/desktop/src/host/net.ts) so bad networks can never hang Cardo:\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('every file with a raw fetch imports or defines fetchWithTimeout', () => {
    const offenders = fetchingFiles
      .filter((f) => !/fetchWithTimeout/.test(f.content))
      .flatMap((f) => f.rawFetch.map((index) => `${rel(f.file)}:${index + 1}`));
    expect(
      offenders,
      `Files fetch without any fetchWithTimeout in sight:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every file that talks to the network contains at least one catch', () => {
    const networkFiles = [...new Set([...fetchingFiles, ...timeoutCallers])];
    const offenders = networkFiles
      .filter((f) => !/\bcatch\b/.test(f.content))
      .map((f) => {
        const line = (f.rawFetch[0] ?? 0) + 1;
        return `${rel(f.file)}:${line}`;
      });
    expect(
      offenders,
      `Files fetch but never catch – offline failures would escape:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
