import i18next from 'i18next';
import type { DiagnoseCheck } from '@cardo/core';
import type { SelfTestResult } from '@cardo/plugin-api';
import { fetchWithTimeout } from '../host/net';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../host/backend';

/**
 * github.com and huggingface.co cannot be fetched from the webview
 * (no CORS headers on github.com; HF CDN redirect chains) – those two
 * probes run in Rust via net_probe when available.
 */
async function rustProbe(url: string): Promise<{ status: number; ms: number; bodyPrefix: string }> {
  return invoke('net_probe', { url });
}
import { POLLS_WORKER_URL } from '../polls/config';
import { MODEL_CATALOG } from '../assistant/models';

/**
 * Online cooperation checks (category "network"). STRICTLY opt-in: they are
 * only built when the user ticks "include online checks" in the diagnose
 * panel. Design rules:
 * - every request goes through fetchWithTimeout (8 s hard cap),
 * - a canary probe runs first; if it fails, every check reports a WARN
 *   ("offline – skipped") – being offline is never a red failure,
 * - a request that itself cannot be sent (DNS, CSP, CORS, flaky Wi-Fi)
 *   is also a WARN – only a *reachable but broken* endpoint (bad status,
 *   malformed payload) is a real failure.
 */

const NET_TIMEOUT_MS = 8000;
const WEBSITE_URL = 'https://hollatzleif.github.io/cardo-app/';
const UPDATE_MANIFEST_URL =
  'https://github.com/hollatzleif/cardo-app/releases/latest/download/latest.json';
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=1';
const FORECAST_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=52.5&longitude=13.4&current=temperature_2m';

const tt = (key: string): string => String(i18next.t(key));

/** performance.now()-timed fetch – latency lands in the check detail. */
async function timed(request: () => Promise<Response>): Promise<{ res: Response; ms: number }> {
  const start = performance.now();
  const res = await request();
  return { res, ms: Math.round(performance.now() - start) };
}

const pass = (ms: number): SelfTestResult => ({ status: 'pass', detail: `${ms} ms` });
const badStatus = (res: Response): SelfTestResult => ({
  status: 'fail',
  detail: `HTTP ${res.status}`,
});

export function buildNetworkChecks(): DiagnoseCheck[] {
  // Canary, shared across all checks of ONE run via a lazily-resolved
  // promise: the first check triggers it, everyone else awaits the result.
  let canary: Promise<boolean> | null = null;
  const canaryOk = (): Promise<boolean> =>
    (canary ??= fetchWithTimeout(WEBSITE_URL, { method: 'HEAD' }, NET_TIMEOUT_MS).then(
      (res) => res.ok,
      () => false,
    ));

  function netCheck(
    id: string,
    titleKey: string,
    probe: () => Promise<SelfTestResult>,
  ): DiagnoseCheck {
    return {
      id: `network:${id}`,
      titleKey,
      category: 'network',
      async run() {
        if (!(await canaryOk())) {
          return { status: 'warn', detail: tt('diagnose.online.offlineSkipped') };
        }
        try {
          return await probe();
        } catch (err) {
          // Online (canary ok) but this request could not be sent – a
          // connectivity/allowlist problem, never a red failure.
          return {
            status: 'warn',
            detail: `${tt('diagnose.online.unreachableSkipped')} (${String(err)})`,
          };
        }
      },
    };
  }

  // Downloadability probe: local models only – claude entries (provider
  // 'claude', sizeBytes 0) are never downloaded.
  const smallestModel = MODEL_CATALOG.filter((m) => m.provider === 'local').sort(
    (a, b) => a.sizeBytes - b.sizeBytes,
  )[0];

  return [
    netCheck('update-server', 'diagnose.check.netUpdateServer', async () => {
      if (isTauri()) {
        const probe = await rustProbe(UPDATE_MANIFEST_URL);
        if (probe.status < 200 || probe.status >= 400) {
          return { status: 'fail', detail: `HTTP ${probe.status}` };
        }
        return /"version"\s*:\s*"\d+\.\d+\.\d+"/.test(probe.bodyPrefix)
          ? pass(probe.ms)
          : { status: 'fail', detail: 'manifest has no valid version field' };
      }
      const { res, ms } = await timed(() =>
        fetchWithTimeout(UPDATE_MANIFEST_URL, undefined, NET_TIMEOUT_MS),
      );
      if (!res.ok) return badStatus(res);
      const json = (await res.json()) as { version?: unknown };
      return typeof json.version === 'string' && /^\d+\.\d+\.\d+$/.test(json.version)
        ? pass(ms)
        : { status: 'fail', detail: `unexpected version: ${JSON.stringify(json.version)}` };
    }),

    netCheck('website', 'diagnose.check.netWebsite', async () => {
      const { res, ms } = await timed(() =>
        fetchWithTimeout(WEBSITE_URL, { method: 'HEAD' }, NET_TIMEOUT_MS),
      );
      return res.ok ? pass(ms) : badStatus(res);
    }),

    netCheck('polls-worker', 'diagnose.check.netPollsWorker', async () => {
      const { res, ms } = await timed(() =>
        fetchWithTimeout(`${POLLS_WORKER_URL}/results`, undefined, NET_TIMEOUT_MS),
      );
      if (!res.ok) return badStatus(res);
      const json = (await res.json()) as Record<string, unknown>;
      return json !== null && typeof json === 'object' && 'polls' in json
        ? pass(ms)
        : { status: 'fail', detail: 'response has no "polls" key' };
    }),

    netCheck('feed', 'diagnose.check.netFeed', async () => {
      const { res, ms } = await timed(() =>
        fetchWithTimeout(`${POLLS_WORKER_URL}/feed`, undefined, NET_TIMEOUT_MS),
      );
      if (!res.ok) return badStatus(res);
      const json = (await res.json()) as { items?: unknown };
      return Array.isArray(json.items)
        ? pass(ms)
        : { status: 'fail', detail: 'response has no "items" array' };
    }),

    netCheck('open-meteo-geo', 'diagnose.check.netOpenMeteoGeo', async () => {
      const { res, ms } = await timed(() => fetchWithTimeout(GEO_URL, undefined, NET_TIMEOUT_MS));
      if (!res.ok) return badStatus(res);
      const json = (await res.json()) as { results?: unknown };
      return Array.isArray(json.results) && json.results.length > 0
        ? pass(ms)
        : { status: 'fail', detail: 'geocoding returned no results for "Berlin"' };
    }),

    netCheck('open-meteo-forecast', 'diagnose.check.netOpenMeteoForecast', async () => {
      const { res, ms } = await timed(() =>
        fetchWithTimeout(FORECAST_URL, undefined, NET_TIMEOUT_MS),
      );
      if (!res.ok) return badStatus(res);
      const json = (await res.json()) as { current?: unknown };
      return json.current !== undefined && json.current !== null
        ? pass(ms)
        : { status: 'fail', detail: 'forecast response has no "current" block' };
    }),

    netCheck('huggingface', 'diagnose.check.netHuggingface', async () => {
      if (!smallestModel) return { status: 'fail', detail: 'model catalog is empty' };
      if (isTauri()) {
        const probe = await rustProbe(smallestModel.url);
        return probe.status === 200 || probe.status === 206
          ? pass(probe.ms)
          : { status: 'fail', detail: `HTTP ${probe.status}` };
      }
      const { res, ms } = await timed(() =>
        fetchWithTimeout(
          smallestModel.url,
          { headers: { Range: 'bytes=0-0' } },
          NET_TIMEOUT_MS,
        ),
      );
      // Range request: 206 (partial) or 200 (server ignored the range) are fine.
      if (res.status !== 200 && res.status !== 206) return badStatus(res);
      // Abort the body – one byte was the deal.
      await res.body?.cancel().catch(() => {});
      return pass(ms);
    }),
  ];
}
