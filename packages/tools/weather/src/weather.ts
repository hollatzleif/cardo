/**
 * Pure weather logic – no host access, no network, fully unit-testable.
 * Everything that talks to the internet lives in index.tsx; this module
 * only builds URLs, parses payloads and maps WMO codes.
 */

/* ── Storage document shapes ──────────────────────────────────────────── */

/** Storage doc 'place' – the one place the user picked. */
export type PlaceDoc = {
  name: string;
  lat: number;
  lon: number;
};

export type CurrentWeather = {
  /** °C */
  temperature: number;
  weatherCode: number;
  /** km/h */
  windSpeed: number;
  /** % */
  humidity: number;
};

export type DailyDay = {
  /** "YYYY-MM-DD" (local calendar day at the place). */
  date: string;
  weatherCode: number;
  tempMax: number;
  tempMin: number;
};

/** Storage doc 'data' – cached forecast so the widget works offline. */
export type DataDoc = {
  /** ISO timestamp of the successful fetch – powers the honest "vor X Min". */
  fetchedAt: string;
  current: CurrentWeather;
  daily: DailyDay[];
};

/** Refresh when the cache is older than this (and every interval while mounted). */
export const STALE_MINUTES = 30;

/* ── URL building (exact strings – covered by self-test "url-building") ── */

export function buildForecastUrl(lat: number, lon: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
    '&timezone=auto&forecast_days=5'
  );
}

export function buildGeocodingUrl(name: string, language: string): string {
  // Open-Meteo expects a bare language code ("de"), not a locale ("de-DE").
  const lang = language.split('-')[0] ?? 'en';
  return (
    'https://geocoding-api.open-meteo.com/v1/search' +
    `?name=${encodeURIComponent(name)}&count=5&language=${encodeURIComponent(lang)}`
  );
}

/* ── WMO weather-code mapping ─────────────────────────────────────────── */

type WmoGroup = [low: number, high: number, emoji: string, key: string];

const WMO_GROUPS: WmoGroup[] = [
  [0, 0, '☀️', 'clear'],
  [1, 2, '🌤️', 'partly'],
  [3, 3, '☁️', 'overcast'],
  [45, 48, '🌫️', 'fog'],
  [51, 67, '🌧️', 'rain'],
  [71, 77, '🌨️', 'snow'],
  [80, 82, '🌦️', 'showers'],
  [85, 86, '🌨️', 'snow'],
  [95, 99, '⛈️', 'thunder'],
];

/** Maps a WMO weather code to a display emoji + i18n label key. */
export function wmoInfo(code: number): { emoji: string; labelKey: string } {
  for (const [low, high, emoji, key] of WMO_GROUPS) {
    if (code >= low && code <= high) {
      return { emoji, labelKey: `tool.weather.wmo.${key}` };
    }
  }
  return { emoji: '🌡️', labelKey: 'tool.weather.wmo.unknown' };
}

/* ── Payload parsing (defensive – the network is not to be trusted) ───── */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Parses the Open-Meteo forecast payload into our cache shape.
 * Returns null when the payload does not look like a forecast at all;
 * malformed daily rows are skipped individually.
 */
export function parseForecastResponse(
  json: unknown,
): { current: CurrentWeather; daily: DailyDay[] } | null {
  if (typeof json !== 'object' || json === null) return null;
  const root = json as { current?: unknown; daily?: unknown };
  if (typeof root.current !== 'object' || root.current === null) return null;
  if (typeof root.daily !== 'object' || root.daily === null) return null;
  const c = root.current as Record<string, unknown>;
  const d = root.daily as Record<string, unknown>;

  if (
    !isFiniteNumber(c.temperature_2m) ||
    !isFiniteNumber(c.weather_code) ||
    !isFiniteNumber(c.wind_speed_10m) ||
    !isFiniteNumber(c.relative_humidity_2m)
  ) {
    return null;
  }

  const time = d.time;
  const codes = d.weather_code;
  const maxs = d.temperature_2m_max;
  const mins = d.temperature_2m_min;
  if (!Array.isArray(time) || !Array.isArray(codes) || !Array.isArray(maxs) || !Array.isArray(mins)) {
    return null;
  }

  const daily: DailyDay[] = [];
  for (let i = 0; i < time.length; i++) {
    const date: unknown = time[i];
    const code: unknown = codes[i];
    const max: unknown = maxs[i];
    const min: unknown = mins[i];
    if (typeof date !== 'string' || !isFiniteNumber(code) || !isFiniteNumber(max) || !isFiniteNumber(min)) {
      continue;
    }
    daily.push({ date, weatherCode: code, tempMax: max, tempMin: min });
  }

  return {
    current: {
      temperature: c.temperature_2m,
      weatherCode: c.weather_code,
      windSpeed: c.wind_speed_10m,
      humidity: c.relative_humidity_2m,
    },
    daily,
  };
}

export type GeoResult = {
  name: string;
  lat: number;
  lon: number;
  /** "Bavaria · Germany" – whatever the API knows, for disambiguation. */
  region: string;
};

/** Parses the Open-Meteo geocoding payload into a flat result list. */
export function parseGeocodingResponse(json: unknown): GeoResult[] {
  if (typeof json !== 'object' || json === null) return [];
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const out: GeoResult[] = [];
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.name !== 'string' || !isFiniteNumber(r.latitude) || !isFiniteNumber(r.longitude)) {
      continue;
    }
    const region = [r.admin1, r.country]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' · ');
    out.push({ name: r.name, lat: r.latitude, lon: r.longitude, region });
  }
  return out;
}

/* ── Display helpers ──────────────────────────────────────────────────── */

/** Whole minutes since `fetchedAtIso` – never negative, Infinity when unparsable. */
export function dataAgeMinutes(fetchedAtIso: string, now: Date): number {
  const fetched = Date.parse(fetchedAtIso);
  if (Number.isNaN(fetched)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - fetched) / 60000));
}

/** Narrow weekday ("M", "D", …) for a "YYYY-MM-DD" date via Intl. */
export function weekdayInitial(date: string, language: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
  try {
    return new Intl.DateTimeFormat(language, { weekday: 'narrow' }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en', { weekday: 'narrow' }).format(d);
  }
}
