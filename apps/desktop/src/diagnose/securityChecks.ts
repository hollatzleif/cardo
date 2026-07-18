import i18next from 'i18next';
import {
  createMemoryBackend,
  createNamespacedStorage,
  type DiagnoseCheck,
} from '@cardo/core';
import { invoke } from '@tauri-apps/api/core';
import { fetchWithTimeout } from '../host/net';
import { fetchAppInfo, isTauri } from '../host/backend';
import { getHost } from '../host';
import { deviceHash } from '../inbox/feed';
import { writeDoc } from '../assistant/api';
import { MODEL_CATALOG } from '../assistant/models';

/**
 * Security checks (category "security"). All of them run offline except the
 * CSP probe, which deliberately targets a host that must NOT be reachable –
 * a rejected request is the pass case, so bad connectivity cannot turn any
 * of these red by accident.
 */

const tt = (key: string): string => String(i18next.t(key));

/** The one host the CSP probe expects to be blocked. Never allowlist it. */
const CSP_PROBE_URL = 'https://example.com/';
const CSP_PROBE_TIMEOUT_MS = 3000;

function cspAllowlistCheck(): DiagnoseCheck {
  return {
    id: 'security:csp-allowlist',
    titleKey: 'diagnose.check.cspAllowlist',
    category: 'security',
    async run() {
      // The CSP only exists inside the Tauri webview – browser dev has none.
      if (!isTauri()) return { status: 'warn', detail: tt('diagnose.detail.browserSkipped') };
      try {
        // no-cors: an allowed host would resolve with an opaque response, so
        // only the CSP (or a dead network) can make this reject.
        await fetchWithTimeout(CSP_PROBE_URL, { method: 'HEAD', mode: 'no-cors' }, CSP_PROBE_TIMEOUT_MS);
        return {
          status: 'fail',
          detail: `CSP allows unexpected host: ${CSP_PROBE_URL} was reachable`,
        };
      } catch {
        return { status: 'pass' };
      }
    },
  };
}

function voteAnonymousCheck(): DiagnoseCheck {
  return {
    id: 'security:vote-anonymous',
    titleKey: 'diagnose.check.voteAnonymous',
    category: 'security',
    async run() {
      const hash = await deviceHash();
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        return { status: 'fail', detail: `device hash is not a SHA-256 hex digest: ${hash.slice(0, 24)}…` };
      }
      const info = await fetchAppInfo();
      if (info.deviceId !== '' && hash.includes(info.deviceId)) {
        return { status: 'fail', detail: 'device hash contains the raw device id' };
      }
      return { status: 'pass' };
    },
  };
}

function assistantDocTraversalCheck(): DiagnoseCheck {
  return {
    id: 'security:assistant-doc-traversal',
    titleKey: 'diagnose.check.assistantDocTraversal',
    category: 'security',
    async run() {
      // Outside Tauri the doc store is in-memory – nothing to attack.
      if (!isTauri()) return { status: 'warn', detail: tt('diagnose.detail.browserSkipped') };
      const invalidIds = ['../evil', 'A B'];
      const accepted: string[] = [];
      for (const id of invalidIds) {
        try {
          await writeDoc('profile', id, 'personality', 'diagnose probe');
          accepted.push(id);
        } catch {
          // Expected: the Rust side must reject the id.
        }
      }
      return accepted.length > 0
        ? { status: 'fail', detail: `invalid doc id(s) accepted: ${accepted.join(', ')}` }
        : { status: 'pass' };
    },
  };
}

function notesPathTraversalCheck(): DiagnoseCheck {
  return {
    id: 'security:notes-path-traversal',
    titleKey: 'diagnose.check.notesPathTraversal',
    category: 'security',
    async run() {
      // Outside Tauri the files backend is in-memory (no Rust guard to test).
      if (!isTauri()) return { status: 'warn', detail: tt('diagnose.detail.browserSkipped') };
      const { files } = getHost().services;
      if (!files) return { status: 'warn', detail: tt('diagnose.detail.browserSkipped') };
      // Each of these must be refused by notes.rs::validate_name before it
      // ever reaches the filesystem.
      const invalidNames = ['../evil.md', 'sub/dir.md', 'no-ext', '..\\evil.md'];
      const accepted: string[] = [];
      for (const name of invalidNames) {
        try {
          await files.write(name, 'diagnose probe');
          accepted.push(name);
          // If it slipped through, undo the damage best-effort.
          try {
            await files.delete(name);
          } catch {
            /* ignore */
          }
        } catch {
          // Expected: the Rust name guard rejects it.
        }
      }
      return accepted.length > 0
        ? { status: 'fail', detail: `invalid note name(s) accepted: ${accepted.join(', ')}` }
        : { status: 'pass' };
    },
  };
}

function keyInKeychainCheck(): DiagnoseCheck {
  return {
    id: 'security:key-in-keychain',
    titleKey: 'diagnose.check.keyInKeychain',
    category: 'security',
    async run() {
      // The keychain lives on the Rust side; browser dev has none.
      if (!isTauri()) return { status: 'warn', detail: tt('diagnose.detail.browserSkipped') };
      try {
        const detail = await invoke<string>('diagnose_keychain');
        return { status: 'pass', detail };
      } catch (err) {
        // A locked / unavailable keychain is a warning, not a failure – the
        // sync key simply cannot be stored until it is unlocked.
        return { status: 'warn', detail: `keychain unavailable: ${String(err)}` };
      }
    },
  };
}

function legalHostsCheck(): DiagnoseCheck {
  return {
    id: 'security:legal-hosts',
    titleKey: 'diagnose.check.legalHosts',
    category: 'security',
    async run() {
      // The host allow-list lives in the Rust legal module; browser dev has none.
      if (!isTauri()) return { status: 'warn', detail: tt('diagnose.detail.browserSkipped') };
      const hosts = await invoke<string[]>('legal_allowed_hosts');
      // Every entry must be a bare https host: no scheme, path, port, wildcard.
      const bad = hosts.filter(
        (h) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) || h.includes('*') || h.includes('/') || h.includes(':'),
      );
      return bad.length === 0
        ? { status: 'pass', detail: `${hosts.length} allow-listed legal host(s)` }
        : { status: 'fail', detail: `malformed legal host(s): ${bad.join(', ')}` };
    },
  };
}

function modelUrlAllowlistCheck(): DiagnoseCheck {
  return {
    id: 'security:model-url-allowlist',
    titleKey: 'diagnose.check.modelUrlAllowlist',
    category: 'security',
    async run() {
      // Only local models are ever downloaded – claude entries (provider
      // 'claude') carry an informational url that is never fetched.
      const offenders = MODEL_CATALOG.filter(
        (model) => model.provider === 'local' && !model.url.startsWith('https://huggingface.co/'),
      );
      return offenders.length > 0
        ? {
            status: 'fail',
            detail: `models outside huggingface.co: ${offenders.map((m) => m.id).join(', ')}`,
          }
        : { status: 'pass' };
    },
  };
}

function namespaceIsolationCheck(): DiagnoseCheck {
  return {
    id: 'security:namespace-isolation',
    titleKey: 'diagnose.check.namespaceIsolation',
    category: 'security',
    async run() {
      const backend = createMemoryBackend();
      const toolA = createNamespacedStorage(backend, 'diag-tool-a');
      const toolB = createNamespacedStorage(backend, 'diag-tool-b');

      await toolA.set('secret', { v: 1 });
      const raw = await backend.get('diag-tool-a', 'secret');
      if (raw === null) {
        return { status: 'fail', detail: 'write did not land under the tool namespace' };
      }
      if ((await toolB.get('secret')) !== null) {
        return { status: 'fail', detail: 'tool B can read tool A data' };
      }

      let rejected = false;
      try {
        createNamespacedStorage(backend, '../evil');
      } catch {
        rejected = true;
      }
      if (!rejected) {
        return { status: 'fail', detail: 'invalid namespace "../evil" was accepted' };
      }
      return { status: 'pass' };
    },
  };
}

export function buildSecurityChecks(): DiagnoseCheck[] {
  return [
    cspAllowlistCheck(),
    voteAnonymousCheck(),
    assistantDocTraversalCheck(),
    notesPathTraversalCheck(),
    modelUrlAllowlistCheck(),
    namespaceIsolationCheck(),
    legalHostsCheck(),
    keyInKeychainCheck(),
  ];
}
