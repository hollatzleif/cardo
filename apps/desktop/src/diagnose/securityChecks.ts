import i18next from 'i18next';
import {
  createMemoryBackend,
  createNamespacedStorage,
  type DiagnoseCheck,
} from '@cardo/core';
import { fetchWithTimeout } from '../host/net';
import { fetchAppInfo, isTauri } from '../host/backend';
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
    modelUrlAllowlistCheck(),
    namespaceIsolationCheck(),
  ];
}
