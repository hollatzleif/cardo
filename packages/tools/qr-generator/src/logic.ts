/** Pure, unit-testable logic for the qr-generator tool. */

export type QrMode = 'text' | 'url' | 'wifi';
export type WifiSecurity = 'WPA' | 'WEP' | 'nopass';

export const QR_MODES: readonly QrMode[] = ['text', 'url', 'wifi'];
export const WIFI_SECURITIES: readonly WifiSecurity[] = ['WPA', 'WEP', 'nopass'];

/** Backslash-escape the WIFI: payload specials \ ; , : " (spec order: \ first). */
export function escapeWifiValue(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

/**
 * Build a `WIFI:` configuration payload. Empty SSIDs are rejected;
 * `nopass` networks omit the password field entirely.
 */
export function wifiPayload(ssid: string, password: string, security: WifiSecurity): string | null {
  if (ssid.trim().length === 0) return null;
  const parts = [`WIFI:T:${security}`, `S:${escapeWifiValue(ssid)}`];
  if (security !== 'nopass') parts.push(`P:${escapeWifiValue(password)}`);
  return `${parts.join(';')};;`;
}

/** Trim a URL and default to https:// when no scheme is given. */
export function normalizeUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

export type QrFields = {
  text?: string;
  url?: string;
  ssid?: string;
  password?: string;
  security?: WifiSecurity;
};

/** The QR payload for a mode + field set, or null when input is incomplete. */
export function payloadFor(mode: QrMode, fields: QrFields): string | null {
  switch (mode) {
    case 'text': {
      const text = fields.text ?? '';
      return text.length > 0 ? text : null;
    }
    case 'url':
      return normalizeUrl(fields.url ?? '');
    case 'wifi':
      return wifiPayload(fields.ssid ?? '', fields.password ?? '', fields.security ?? 'WPA');
  }
}

export const RECENT_MAX = 5;

export type RecentDoc = { id: string; type: 'recent'; entries: string[] };

/** Prepend a payload to the recent list: deduped, capped at RECENT_MAX. */
export function pushRecent(entries: readonly string[], payload: string, max = RECENT_MAX): string[] {
  if (!payload) return [...entries].slice(0, max);
  return [payload, ...entries.filter((e) => e !== payload)].slice(0, max);
}

/** Assistant context: the recently encoded payloads. */
export function buildQrContext(entries: readonly string[], language: string): string {
  const de = language === 'de';
  if (entries.length === 0) {
    return de ? 'QR-Codes: noch nichts kodiert.' : 'QR codes: nothing encoded yet.';
  }
  const shorten = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  const head = de
    ? `QR-Codes – zuletzt kodiert (${entries.length}):`
    : `QR codes – recently encoded (${entries.length}):`;
  return [head, ...entries.slice(0, RECENT_MAX).map((e) => `– ${shorten(e)}`)].join('\n');
}
