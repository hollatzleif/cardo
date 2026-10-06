import { OAUTH_CHANNEL, OAUTH_RESULT_KEY } from './config';
import { parseFragment } from './oauthParse';

/**
 * Runs on oauth-callback.html after Google redirects back. Hands the result
 * to the app on every channel that might work inside an installed iPhone web
 * app (popup opener, BroadcastChannel, shared localStorage), then closes the
 * popup – or, if this page replaced the app (no opener), goes back to it.
 * Validation (state, scope) happens in the app, not here.
 */
const result = parseFragment(window.location.hash);
// The token must not linger in the address bar / history.
history.replaceState(null, '', window.location.pathname);

const payload = JSON.stringify({ ...result, receivedAt: Date.now() });
try {
  localStorage.setItem(OAUTH_RESULT_KEY, payload);
} catch {
  // Storage unavailable – the other channels may still work.
}
try {
  const channel = new BroadcastChannel(OAUTH_CHANNEL);
  channel.postMessage(payload);
  channel.close();
} catch {
  // BroadcastChannel unsupported.
}
const opener = window.opener as Window | null;
if (opener) {
  try {
    opener.postMessage({ type: 'cardo-oauth', payload }, window.location.origin);
  } catch {
    // Opener gone or cross-origin.
  }
}

const status = document.getElementById('status');
if (status) status.textContent = 'Angemeldet. Du kannst dieses Fenster schließen.';

setTimeout(() => {
  window.close();
  // Still open (no opener / not allowed to close): return to the app, which
  // picks the result up from localStorage.
  setTimeout(() => window.location.replace(import.meta.env.BASE_URL), 300);
}, 150);
