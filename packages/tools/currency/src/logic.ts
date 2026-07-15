/**
 * Pure currency logic – no host access, no network, fully unit-testable.
 * Everything that talks to the internet lives in index.tsx; this module
 * only builds URLs, parses payloads and does the cross-rate math.
 */

/* ── Storage document shapes ──────────────────────────────────────────── */

/** Storage doc `rates:<BASE>` – one cached daily rate table per base. */
export type RatesDoc = {
  type: 'rates';
  /** ISO 4217 code the table is quoted against (rates[base] === 1). */
  base: string;
  /** Epoch ms of the successful fetch – powers the honest age label. */
  fetchedAtMs: number;
  /** Currency code → units of that currency per 1 unit of `base`. */
  rates: Record<string, number>;
};

/** Storage doc 'last-pair' – the last conversion, for the assistant context. */
export type LastPairDoc = {
  type: 'last-pair';
  from: string;
  to: string;
  amount: number;
  result: number;
};

/** Fetch at most once per day per base (the API updates daily anyway). */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Older than this and the age label turns into a warning (>26 h). */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

/** ~30 common ISO 4217 codes for the selects – no exotic garbage. */
export const CURRENCIES: readonly string[] = [
  'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CNY', 'AUD', 'CAD', 'NZD', 'SEK',
  'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'ISK', 'INR',
  'BRL', 'MXN', 'ZAR', 'SGD', 'HKD', 'KRW', 'THB', 'IDR', 'ILS', 'AED',
];

export const DEFAULT_BASE = 'EUR';
export const DEFAULT_DECIMALS = 2;
export const DEFAULT_PAIRS: readonly string[] = ['EUR/USD', 'EUR/GBP', 'EUR/CHF'];

/* ── Code / pair helpers ──────────────────────────────────────────────── */

/** "usd " → "USD"; anything that is not a 3-letter code → null. */
export function normalizeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** "EUR/USD" → { from, to }; malformed → null. */
export function parsePair(pair: string): { from: string; to: string } | null {
  const parts = pair.split('/');
  if (parts.length !== 2) return null;
  const from = normalizeCode(parts[0] ?? '');
  const to = normalizeCode(parts[1] ?? '');
  return from && to ? { from, to } : null;
}

/* ── URL building & payload parsing ───────────────────────────────────── */

export function buildUrl(base: string): string {
  return `https://open.er-api.com/v6/latest/${base}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Parses the open.er-api.com payload into our cache shape. Returns null
 * when the payload does not look like a rate table at all; individual
 * non-numeric rate entries are skipped.
 */
export function parseRatesResponse(json: unknown): { base: string; rates: Record<string, number> } | null {
  if (typeof json !== 'object' || json === null) return null;
  const root = json as Record<string, unknown>;
  if (root.result !== 'success') return null;
  const base = typeof root.base_code === 'string' ? normalizeCode(root.base_code) : null;
  if (!base) return null;
  if (typeof root.rates !== 'object' || root.rates === null) return null;
  const rates: Record<string, number> = {};
  for (const [code, value] of Object.entries(root.rates as Record<string, unknown>)) {
    const normalized = normalizeCode(code);
    if (normalized && isFiniteNumber(value) && value > 0) rates[normalized] = value;
  }
  // A real table quotes the base itself at 1 and knows more than one code.
  if (rates[base] === undefined || Object.keys(rates).length < 2) return null;
  return { base, rates };
}

/* ── Conversion math ──────────────────────────────────────────────────── */

/**
 * Converts via the base cross-rate: amount / rate[from] * rate[to].
 * Null when either code is unknown to the table (or there is no table).
 */
export function convert(amount: number, from: string, to: string, doc: RatesDoc | null): number | null {
  if (!doc || !Number.isFinite(amount)) return null;
  const fromCode = normalizeCode(from);
  const toCode = normalizeCode(to);
  if (!fromCode || !toCode) return null;
  const rateFrom = doc.rates[fromCode];
  const rateTo = doc.rates[toCode];
  if (rateFrom === undefined || rateTo === undefined) return null;
  return (amount / rateFrom) * rateTo;
}

/* ── Freshness ────────────────────────────────────────────────────────── */

/** Older than 26 h → show the age in the warning color. */
export function isStale(fetchedAtMs: number, nowMs: number): boolean {
  return nowMs - fetchedAtMs > STALE_AFTER_MS;
}

/** Daily fetch gate: fetch only when there is no cache or it is a day old. */
export function shouldFetch(doc: RatesDoc | null, nowMs: number): boolean {
  return !doc || nowMs - doc.fetchedAtMs >= REFRESH_INTERVAL_MS;
}

/**
 * Honest, human age label. Buckets: under an hour, whole hours, whole days.
 * "vor 3 Std." / "3 h ago" – never pretends to be fresher than it is.
 */
export function rateAgeLabel(fetchedAtMs: number, nowMs: number, lang: string): string {
  const de = lang.startsWith('de');
  const age = Math.max(0, nowMs - fetchedAtMs);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (age < hour) return de ? 'vor weniger als 1 Std.' : 'less than 1 h ago';
  if (age < day) {
    const hours = Math.floor(age / hour);
    return de ? `vor ${hours} Std.` : `${hours} h ago`;
  }
  const days = Math.floor(age / day);
  if (days === 1) return de ? 'vor 1 Tag' : '1 day ago';
  return de ? `vor ${days} Tagen` : `${days} days ago`;
}

/* ── Display helpers ──────────────────────────────────────────────────── */

export function formatAmount(value: number, decimals: number, lang: string): string {
  const digits = Math.min(8, Math.max(0, Math.trunc(decimals)));
  try {
    return new Intl.NumberFormat(lang, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return value.toFixed(digits);
  }
}

/* ── Assistant context ────────────────────────────────────────────────── */

/** One-paragraph summary of the cached table + last conversion. */
export function buildCurrencyContext(
  doc: RatesDoc | null,
  lastPair: LastPairDoc | null,
  lang: string,
  nowMs: number,
): string {
  const de = lang.startsWith('de');
  if (!doc) {
    return de
      ? 'Noch keine Wechselkurse geladen (offline oder erster Start).'
      : 'No exchange rates cached yet (offline or first run).';
  }
  const age = rateAgeLabel(doc.fetchedAtMs, nowMs, lang);
  const head = de
    ? `Wechselkurse zur Basis ${doc.base}, ${Object.keys(doc.rates).length} Währungen, aktualisiert ${age}.`
    : `Exchange rates against ${doc.base}, ${Object.keys(doc.rates).length} currencies, updated ${age}.`;
  if (!lastPair) return head;
  const result = convert(lastPair.amount, lastPair.from, lastPair.to, doc);
  const shown = result === null ? lastPair.result : result;
  const line = `${formatAmount(lastPair.amount, 2, lang)} ${lastPair.from} = ${formatAmount(shown, 2, lang)} ${lastPair.to}`;
  return de ? `${head} Letzte Umrechnung: ${line}.` : `${head} Last conversion: ${line}.`;
}
