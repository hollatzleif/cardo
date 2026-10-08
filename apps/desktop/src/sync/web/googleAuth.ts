import {
  GDRIVE_SCOPE,
  GDRIVE_WEB_CLIENT_ID,
  GOOGLE_AUTH_URL,
  OAUTH_CHANNEL,
  OAUTH_PENDING_KEY,
  OAUTH_RESULT_KEY,
  OAUTH_TOKEN_KEY,
  oauthRedirectUri,
} from './config';
import { acceptResult, buildAuthUrl, type StoredToken } from './oauthParse';

/**
 * Google sign-in for the web app: OAuth implicit token flow in a popup.
 * No Google script, no client secret, no refresh token – an access token
 * lasts about an hour, renewal is one tap (prompt=none, usually just a flash).
 *
 * IMPORTANT for callers: beginGoogleAuth() opens the popup synchronously, so
 * it must be called directly from a tap/click handler, before any await –
 * iOS blocks popups opened later.
 */

export class GoogleAuthError extends Error {
  constructor(public readonly code: string) {
    super(`google auth: ${code}`);
  }
}

const AUTH_TIMEOUT_MS = 5 * 60_000;

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function isGoogleConfigured(): boolean {
  return GDRIVE_WEB_CLIENT_ID !== '';
}

/** The stored token if it is still valid, else null. */
export function currentToken(nowMs = Date.now()): StoredToken | null {
  const token = readJson<StoredToken>(OAUTH_TOKEN_KEY);
  return token && token.expiresAt > nowMs ? token : null;
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(OAUTH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

/**
 * Picks up a result the callback page left in localStorage (full-page
 * redirect fallback, or a popup whose message never arrived). Call at start.
 */
export function consumePendingResult(nowMs = Date.now()): StoredToken | null {
  const pending = readJson<{ state: string; startedAt: number }>(OAUTH_PENDING_KEY);
  const raw = readJson<Record<string, unknown>>(OAUTH_RESULT_KEY);
  if (!pending || !raw) return null;
  try {
    localStorage.removeItem(OAUTH_RESULT_KEY);
    localStorage.removeItem(OAUTH_PENDING_KEY);
  } catch {
    // ignore
  }
  if (nowMs - pending.startedAt > AUTH_TIMEOUT_MS) return null;
  const outcome = acceptResult(raw as never, pending.state, GDRIVE_SCOPE, nowMs);
  if ('token' in outcome) {
    localStorage.setItem(OAUTH_TOKEN_KEY, JSON.stringify(outcome.token));
    return outcome.token;
  }
  return null;
}

/**
 * Starts sign-in. Opens the popup NOW (synchronously), then resolves with a
 * valid token once the callback page reports back.
 */
export function beginGoogleAuth(
  options: { silent?: boolean; loginHint?: string } = {},
): Promise<StoredToken> {
  if (!isGoogleConfigured()) return Promise.reject(new GoogleAuthError('not_configured'));
  const state = randomState();
  localStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify({ state, startedAt: Date.now() }));
  localStorage.removeItem(OAUTH_RESULT_KEY);
  const url = buildAuthUrl({
    authUrl: GOOGLE_AUTH_URL,
    clientId: GDRIVE_WEB_CLIENT_ID,
    redirectUri: oauthRedirectUri(),
    scope: GDRIVE_SCOPE,
    state,
    silent: options.silent ?? false,
    loginHint: options.loginHint,
  });
  const popup = window.open(url, 'cardo-oauth', 'popup,width=480,height=640');
  if (!popup) {
    // Popup blocked: full-page redirect; the callback page comes back to the
    // app and consumePendingResult() finishes the job on the next start.
    window.location.assign(url);
    return new Promise(() => {});
  }

  return new Promise<StoredToken>((resolve, reject) => {
    let done = false;
    let channel: BroadcastChannel | null = null;
    const finish = (payload: string | null, error?: string) => {
      if (done) return;
      done = true;
      cleanup();
      if (error) return reject(new GoogleAuthError(error));
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload ?? '');
      } catch {
        return reject(new GoogleAuthError('bad_payload'));
      }
      const outcome = acceptResult(parsed as never, state, GDRIVE_SCOPE, Date.now());
      try {
        localStorage.removeItem(OAUTH_RESULT_KEY);
        localStorage.removeItem(OAUTH_PENDING_KEY);
      } catch {
        // ignore
      }
      if ('error' in outcome) return reject(new GoogleAuthError(outcome.error));
      localStorage.setItem(OAUTH_TOKEN_KEY, JSON.stringify(outcome.token));
      resolve(outcome.token);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; payload?: string } | null;
      if (data?.type === 'cardo-oauth' && typeof data.payload === 'string') finish(data.payload);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === OAUTH_RESULT_KEY && e.newValue) finish(e.newValue);
    };
    const poll = window.setInterval(() => {
      const raw = localStorage.getItem(OAUTH_RESULT_KEY);
      if (raw) finish(raw);
      else if (popup.closed) {
        // Give late channels a moment before calling it a cancel.
        window.setTimeout(() => {
          const late = localStorage.getItem(OAUTH_RESULT_KEY);
          if (late) finish(late);
          else finish(null, 'popup_closed');
        }, 800);
      }
    }, 400);
    const timeout = window.setTimeout(() => finish(null, 'timeout'), AUTH_TIMEOUT_MS);
    try {
      channel = new BroadcastChannel(OAUTH_CHANNEL);
      channel.onmessage = (e) => typeof e.data === 'string' && finish(e.data);
    } catch {
      channel = null;
    }
    window.addEventListener('message', onMessage);
    window.addEventListener('storage', onStorage);
    function cleanup() {
      window.clearInterval(poll);
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
      channel?.close();
    }
  });
}
