/**
 * Pure build-time helpers for the iPhone home-screen web app (vite --mode
 * web). Kept free of DOM and Node APIs so they are unit-tested directly;
 * vite/cardoPwa.ts wires them into the build. Colors are never literals here:
 * the caller passes them in, read from the theme JSON at build time.
 */

export const WEB_BASE = '/cardo-app/app/';

/**
 * Hosts the web app may contact. Mirrors the desktop CSP (tauri.conf.json)
 * minus everything that only the desktop uses (local models, GitHub
 * releases), plus Google's APIs for Drive sync.
 */
export const WEB_CONNECT_HOSTS = [
  'https://www.googleapis.com',
  'https://oauth2.googleapis.com',
  'https://cardo-polls.hollatzleif.workers.dev',
  'https://hollatzleif.github.io',
  'https://api.open-meteo.com',
  'https://geocoding-api.open-meteo.com',
  'https://open.er-api.com',
] as const;

export function buildCsp(connectHosts: readonly string[] = WEB_CONNECT_HOSTS): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${connectHosts.join(' ')}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "media-src 'self' data: blob:",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

export interface ManifestOptions {
  name: string;
  shortName: string;
  description: string;
  themeColor: string;
  backgroundColor: string;
  lang: string;
}

export function buildManifest(o: ManifestOptions): Record<string, unknown> {
  return {
    name: o.name,
    short_name: o.shortName,
    description: o.description,
    lang: o.lang,
    id: WEB_BASE,
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'any',
    theme_color: o.themeColor,
    background_color: o.backgroundColor,
    icons: [
      { src: 'icons/icon-180.png', sizes: '180x180', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
    ],
  };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Tags injected into <head> of the web build only. */
export function buildHeadTags(o: { title: string; themeColor: string; csp: string }): string {
  return [
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(o.csp)}" />`,
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    `<meta name="apple-mobile-web-app-title" content="${escapeAttr(o.title)}" />`,
    `<meta name="theme-color" content="${escapeAttr(o.themeColor)}" />`,
    '<link rel="manifest" href="manifest.webmanifest" />',
    '<link rel="apple-touch-icon" href="icons/icon-180.png" />',
  ].join('\n    ');
}

/** The viewport tag the web build uses (edge to edge under the notch). */
export const WEB_VIEWPORT =
  'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content';

/**
 * Service worker source. Strategy:
 * - install: precache the app shell, but do NOT take over (an update must
 *   never swap code under a running sync) – the page asks via SKIP_WAITING
 *   once the user taps "Neu laden".
 * - navigations: network first (3 s), cached index.html as offline fallback.
 * - hashed build assets: cache first.
 * - other origins (Google, weather …): passed through, never cached.
 */
export function renderServiceWorker(version: string, precache: readonly string[]): string {
  return `/* Cardo web app service worker – generated at build time. */
const VERSION = ${JSON.stringify(version)};
const CACHE = 'cardo-app-' + VERSION;
const PRECACHE = ${JSON.stringify(precache)};
// The worker's own network access (the app-side fetchWithTimeout rule does
// not apply here: the browser bounds service-worker fetches itself).
const network = self.fetch.bind(self);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('cardo-app-') && k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'GET_VERSION' && event.ports[0]) event.ports[0].postMessage(VERSION);
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      withTimeout(network(request), 3000)
        .then((response) => {
          if (response.ok && url.pathname === scope.pathname) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(scope.pathname, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((hit) => hit || caches.match(scope.pathname)).then(
            (hit) => hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }),
          ),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        network(request).then((response) => {
          if (response.ok && url.pathname.includes('/assets/')) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
`;
}
