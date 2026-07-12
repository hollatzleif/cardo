#!/usr/bin/env node
/**
 * Secret scanner for the Cardo repo.
 *
 * Scans every git-tracked file (and, with --staged, the staged blobs too)
 * for committed private keys, cloud/provider tokens and hard-coded
 * credentials. Exits 1 and prints a `file:line: [rule] <line>` list on any
 * hit, so it can gate `pnpm lint` and CI.
 *
 * Design rule: the allowlist may only ever excuse a DEMONSTRABLE non-secret
 * (a format-doc string, a CSS custom property, a rate-limit comment). It must
 * never carry a real secret – there are none in this repo, and there never
 * should be. New secrets belong in Wrangler secrets / CI secrets / the local
 * minisign keystore, never in a tracked file.
 *
 * Usage:
 *   node scripts/check-secrets.mjs           # scan tracked working-tree files
 *   node scripts/check-secrets.mjs --staged  # also scan staged content
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SELF = 'scripts/check-secrets.mjs';

/* ---- detection rules ------------------------------------------------- */

const RULES = [
  // PEM private keys of every flavour (RSA / EC / OPENSSH / PKCS#8).
  { name: 'private-key', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  // minisign / rsign encrypted secret key header.
  { name: 'rsign-secret-key', re: /untrusted comment: rsign encrypted secret key/ },
  // GitHub tokens: ghp_ / gho_ / ghu_ / ghs_ / ghr_ ...
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  // AWS access key id.
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  // A concrete PBKDF2 hash "pbkdf2$<iterations>$..." (real digits after $).
  { name: 'pbkdf2-hash', re: /pbkdf2\$\d+\$/ },
  // Slack tokens.
  { name: 'slack-token', re: /xox[bap]-/ },
  // Generic hard-coded credential: password/secret/token = "<16+ chars>".
  {
    name: 'generic-credential',
    re: /(password|secret|token)\s*[:=]\s*['"][^'"]{16,}['"]/i,
    generic: true,
  },
];

/* ---- allowlist (file + rule + required line substring) --------------- */
// Every entry documents WHY the flagged text is provably not a secret.

const ALLOWLIST = [
  // The security audit doc DESCRIBES the secret formats – it contains none.
  {
    file: 'docs/SECURITY-NOTES.md',
    rule: 'rsign-secret-key',
    contains: 'minisign',
    why: 'audit doc names the rsign header phrase to explain what the scanner blocks',
  },
  {
    file: 'docs/SECURITY-NOTES.md',
    rule: 'pbkdf2-hash',
    contains: 'pbkdf2$100000$<salt>$<hash>',
    why: 'audit doc documents the hash FORMAT with placeholders, no real hash',
  },
  // The PBKDF2 storage FORMAT is documented, not a real hash.
  {
    file: 'server/polls-worker/README.md',
    rule: 'pbkdf2-hash',
    contains: 'pbkdf2$',
    why: 'documents the hash format string, contains no real hash',
  },
  {
    file: 'server/polls-worker/src/index.ts',
    rule: 'pbkdf2-hash',
    contains: 'pbkdf2',
    why: 'documents/parses the hash format, no real hash literal',
  },
  // README shows how to generate the hash: a getpass() PROMPT string, not a value.
  {
    file: 'server/polls-worker/README.md',
    rule: 'generic-credential',
    contains: 'getpass',
    why: 'password prompt string in the setup snippet, not a credential',
  },
  // A CSS custom-property reference in the design panel table.
  {
    file: 'apps/desktop/src/design/DesignPanel.tsx',
    rule: 'generic-credential',
    contains: '--palette-surface-0',
    why: 'CSS custom property name, not a token secret',
  },
];

/* ---- file selection -------------------------------------------------- */

// Never scan our own source (it necessarily contains the patterns above).
const SKIP_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tgz', 'wasm', 'lock',
]);

// The generic rule is intentionally noisy; skip locale files and test
// fixtures (design tokens, sample data, i18n strings – never real secrets).
function isGenericExempt(file) {
  return (
    /(^|\/)(test|tests|__tests__|fixtures)\//.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /\/locales\//.test(file) ||
    file.includes('packages/i18n/locales/')
  );
}

function extOf(file) {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot + 1).toLowerCase();
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'], {
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

function readTracked(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readStaged(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/* ---- scanning -------------------------------------------------------- */

function isAllowed(file, ruleName, line) {
  return ALLOWLIST.some(
    (a) => a.file === file && a.rule === ruleName && line.includes(a.contains),
  );
}

function scan(file, content, origin, findings) {
  if (file === SELF) return;
  if (SKIP_EXT.has(extOf(file))) return;
  if (content == null || content.includes('\0')) return; // binary guard

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (rule.generic && isGenericExempt(file)) continue;
      if (!rule.re.test(line)) continue;
      if (isAllowed(file, rule.name, line)) continue;
      findings.push({
        file,
        line: i + 1,
        rule: rule.name,
        origin,
        text: line.trim().slice(0, 200),
      });
    }
  }
}

/* ---- main ------------------------------------------------------------ */

function main() {
  const withStaged = process.argv.includes('--staged');
  const findings = [];

  for (const file of trackedFiles()) {
    scan(file, readTracked(file), 'tracked', findings);
  }
  if (withStaged) {
    for (const file of stagedFiles()) {
      scan(file, readStaged(file), 'staged', findings);
    }
  }

  if (findings.length > 0) {
    console.error(`check-secrets: ${findings.length} potential secret(s) found:\n`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}: [${f.rule}] (${f.origin}) ${f.text}`);
    }
    console.error(
      '\nIf a hit is a proven non-secret, add a precise allowlist entry ' +
        '(file + rule + line substring) in scripts/check-secrets.mjs. ' +
        'NEVER commit a real secret – use Wrangler/CI secrets instead.',
    );
    process.exit(1);
  }

  console.log('check-secrets: no secrets found.');
}

main();
