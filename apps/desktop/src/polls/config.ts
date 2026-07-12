/**
 * Poll endpoints. Transparency principle: the app contacts these hosts
 * ONLY after the user explicitly presses "load polls" in settings.
 * What is transmitted: the poll id, the chosen option and an anonymous
 * SHA-256 hash of the device id (so each installation counts once).
 * Nothing else – no name, no IP logging on our side, no telemetry.
 */
export const POLLS_DEFINITION_URL = 'https://hollatzleif.github.io/cardo-app/polls.json';
// Patched after `wrangler deploy` prints the real workers.dev URL.
export const POLLS_WORKER_URL = 'https://cardo-polls.hollatzleif.workers.dev';
