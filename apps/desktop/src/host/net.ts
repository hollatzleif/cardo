/**
 * Network helpers – bad connections must never hang or crash Cardo.
 * RULE (enforced by net-guard.test.ts): every fetch() in app and tool
 * code goes through fetchWithTimeout (or replicates its timeout pattern)
 * and lives inside a try/catch.
 */

export const DEFAULT_TIMEOUT_MS = 10_000;

/** fetch with a hard timeout – aborts instead of hanging on bad networks. */
export function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** Best-effort offline hint (no network probe – instant). */
export function isProbablyOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
