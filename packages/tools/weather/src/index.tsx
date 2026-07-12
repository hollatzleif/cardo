import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  STALE_MINUTES,
  buildForecastUrl,
  buildGeocodingUrl,
  dataAgeMinutes,
  parseForecastResponse,
  parseGeocodingResponse,
  weekdayInitial,
  wmoInfo,
  type DataDoc,
  type GeoResult,
  type PlaceDoc,
} from './weather';

/** fetch with hard timeout – bad networks must never hang the widget
 * (same pattern as the host's net.ts; tools cannot import host code). */
function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Weather – Open-Meteo forecast for one place of your choice.
 *
 * Cardo's first "yellow" tool: it contacts the internet, and it is honest
 * about it. Only the city name you type (geocoding) and the coordinates of
 * your chosen place (forecast) ever leave this device – never anything
 * about you. The widget always shows how old its data is, and a failed
 * refresh keeps the cached forecast on screen instead of pretending.
 */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  type RefreshOutcome = 'ok' | 'no-place' | 'offline';

  /** Fetch the forecast for the stored place and cache it (doc 'data'). */
  async function refresh(): Promise<RefreshOutcome> {
    const c = ctx;
    if (!c) return 'offline';
    const place = await c.storage.get<PlaceDoc>('place');
    if (!place) return 'no-place';
    try {
      const res = await fetchWithTimeout(buildForecastUrl(place.lat, place.lon));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseForecastResponse((await res.json()) as unknown);
      if (!parsed) throw new Error('unexpected payload');
      const doc: DataDoc = { fetchedAt: new Date().toISOString(), ...parsed };
      await c.storage.set<DataDoc>('data', doc);
      return 'ok';
    } catch {
      // Honesty rule: never fake freshness – keep the cache, report offline.
      return 'offline';
    }
  }

  async function loadState(): Promise<{ place: PlaceDoc | null; data: DataDoc | null }> {
    const c = ctx;
    if (!c) return { place: null, data: null };
    const [place, data] = await Promise.all([
      c.storage.get<PlaceDoc>('place'),
      c.storage.get<DataDoc>('data'),
    ]);
    return { place, data };
  }

  function WeatherWidget(_props: WidgetProps) {
    const [place, setPlace] = useState<PlaceDoc | null | undefined>(undefined);
    const [data, setData] = useState<DataDoc | null>(null);
    const [picking, setPicking] = useState(false);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<GeoResult[] | null>(null);
    const [searchState, setSearchState] = useState<'idle' | 'loading' | 'error'>('idle');
    const [offline, setOffline] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    // Re-render every minute so the "vor X Min" age stays honest.
    const [, setTick] = useState(0);

    useEffect(() => {
      let mounted = true;
      const load = () => {
        void loadState().then((s) => {
          if (mounted) {
            setPlace(s.place);
            setData(s.data);
          }
        });
      };
      load();
      const unsub = ctx?.storage.subscribe(load);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, []);

    useEffect(() => {
      let mounted = true;
      const doRefresh = () => {
        void refresh().then((outcome) => {
          if (mounted) setOffline(outcome === 'offline');
        });
      };
      // On mount: refresh only when the cache is missing or stale.
      void loadState().then((s) => {
        if (!mounted || !s.place) return;
        if (!s.data || dataAgeMinutes(s.data.fetchedAt, new Date()) >= STALE_MINUTES) doRefresh();
      });
      const refreshInterval = window.setInterval(doRefresh, STALE_MINUTES * 60 * 1000);
      const ageInterval = window.setInterval(() => setTick((n) => n + 1), 60 * 1000);
      return () => {
        mounted = false;
        window.clearInterval(refreshInterval);
        window.clearInterval(ageInterval);
      };
    }, []);

    const runSearch = async () => {
      const q = query.trim();
      if (!q) return;
      setSearchState('loading');
      setResults(null);
      try {
        const res = await fetchWithTimeout(buildGeocodingUrl(q, ctx?.i18n.language ?? 'en'));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setResults(parseGeocodingResponse((await res.json()) as unknown));
        setSearchState('idle');
      } catch {
        setSearchState('error');
      }
    };

    const pickPlace = async (r: GeoResult) => {
      await ctx?.storage.set<PlaceDoc>('place', { name: r.name, lat: r.lat, lon: r.lon });
      setPicking(false);
      setQuery('');
      setResults(null);
      setSearchState('idle');
      setRefreshing(true);
      const outcome = await refresh();
      setOffline(outcome === 'offline');
      setRefreshing(false);
    };

    const manualRefresh = async () => {
      setRefreshing(true);
      const outcome = await refresh();
      setOffline(outcome === 'offline');
      setRefreshing(false);
    };

    if (place === undefined) {
      return (
        <div className="c-muted" style={{ padding: 'var(--space-3)' }}>
          …
        </div>
      );
    }

    /* ── Setup / change-place view ── */
    if (!place || picking) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            height: '100%',
            padding: 'var(--space-2)',
          }}
        >
          <div className="c-muted">{t('tool.weather.setupHint')}</div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <input
              className="c-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder={t('tool.weather.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch();
              }}
            />
            <button
              className="c-btn c-btn--primary"
              onClick={() => void runSearch()}
              disabled={!query.trim() || searchState === 'loading'}
            >
              {t('tool.weather.search')}
            </button>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
            }}
          >
            {searchState === 'loading' && <div className="c-muted">…</div>}
            {searchState === 'error' && (
              <div style={{ color: 'var(--warning)' }}>{t('tool.weather.searchError')}</div>
            )}
            {results !== null && results.length === 0 && searchState === 'idle' && (
              <div className="c-muted">{t('tool.weather.noResults')}</div>
            )}
            {results?.map((r, i) => (
              <button
                key={`${r.lat},${r.lon},${i}`}
                className="c-btn c-btn--ghost"
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                onClick={() => void pickPlace(r)}
              >
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {r.name}
                  {r.region ? (
                    <span className="c-muted"> · {r.region}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
          {place && (
            <button
              className="c-btn c-btn--ghost"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                setPicking(false);
                setQuery('');
                setResults(null);
                setSearchState('idle');
              }}
            >
              {t('tool.weather.cancel')}
            </button>
          )}
        </div>
      );
    }

    /* ── Weather view ── */
    const current = data ? wmoInfo(data.current.weatherCode) : null;
    const ageMinutes = data ? dataAgeMinutes(data.fetchedAt, new Date()) : null;

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          height: '100%',
          padding: 'var(--space-2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: 600,
            }}
          >
            {place.name}
          </div>
          <button
            className="c-btn c-btn--ghost"
            style={{ padding: 'var(--space-1) var(--space-2)' }}
            onClick={() => setPicking(true)}
            aria-label={t('tool.weather.changePlace')}
            title={t('tool.weather.changePlace')}
          >
            ✎
          </button>
          <button
            className="c-btn c-btn--ghost"
            style={{ padding: 'var(--space-1) var(--space-2)' }}
            onClick={() => void manualRefresh()}
            disabled={refreshing}
            aria-label={t('tool.weather.refresh')}
            title={t('tool.weather.refresh')}
          >
            ↻
          </button>
        </div>

        {!data ? (
          <div className="c-muted" style={{ flex: 1 }}>
            {offline ? t('tool.weather.noData') : '…'}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <span style={{ fontSize: '2.4em', lineHeight: 1 }} role="img" aria-hidden="true">
                {current?.emoji}
              </span>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '2em',
                    fontWeight: 700,
                    lineHeight: 1.1,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {Math.round(data.current.temperature)}°
                </div>
                <div
                  className="c-muted"
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {current ? t(current.labelKey) : ''}
                </div>
              </div>
            </div>
            <div className="c-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <span title={t('tool.weather.wind')}>💨 {Math.round(data.current.windSpeed)} km/h</span>
              {' · '}
              <span title={t('tool.weather.humidity')}>💧 {Math.round(data.current.humidity)} %</span>
            </div>
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-1)',
                marginTop: 'auto',
                overflow: 'hidden',
              }}
            >
              {data.daily.slice(0, 5).map((day) => {
                const info = wmoInfo(day.weatherCode);
                return (
                  <div
                    key={day.date}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '2px',
                      fontSize: '0.85em',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                    title={t(info.labelKey)}
                  >
                    <span className="c-muted">
                      {weekdayInitial(day.date, ctx?.i18n.language ?? 'en')}
                    </span>
                    <span role="img" aria-hidden="true">
                      {info.emoji}
                    </span>
                    <span>{Math.round(day.tempMax)}°</span>
                    <span className="c-muted">{Math.round(day.tempMin)}°</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div
          className="c-muted"
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'baseline',
            fontSize: '0.8em',
            flexWrap: 'wrap',
          }}
        >
          {ageMinutes !== null && Number.isFinite(ageMinutes) && (
            <span>
              {ageMinutes < 1
                ? t('tool.weather.updatedJustNow')
                : t('tool.weather.updatedAgo', { minutes: ageMinutes })}
            </span>
          )}
          {offline && <span style={{ color: 'var(--warning)' }}>{t('tool.weather.offlineHint')}</span>}
        </div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;

      context.commands.register({
        id: 'weather.refresh',
        titleKey: 'tool.weather.command.refresh',
        params: z.object({}),
        selfTestParams: {},
        icon: '↻',
        async run() {
          const outcome = await refresh();
          // Commands never hard-fail on normal conditions (no place / offline).
          if (outcome === 'no-place') return { ok: true, messageKey: 'tool.weather.msg.noPlace' };
          if (outcome === 'offline') return { ok: true, messageKey: 'tool.weather.msg.offline' };
          return { ok: true, messageKey: 'tool.weather.msg.refreshed' };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: WeatherWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'cache-roundtrip': {
          const probe: DataDoc = {
            fetchedAt: '2026-01-01T12:00:00.000Z',
            current: { temperature: 3.4, weatherCode: 71, windSpeed: 8, humidity: 91 },
            daily: [{ date: '2026-01-01', weatherCode: 71, tempMax: 4, tempMin: -2 }],
          };
          await testCtx.storage.set<DataDoc>('data', probe);
          const roundtrip = await testCtx.storage.get<DataDoc>('data');
          await testCtx.storage.delete('data');
          const afterDelete = await testCtx.storage.get<DataDoc>('data');
          if (
            roundtrip?.fetchedAt !== probe.fetchedAt ||
            roundtrip.current.temperature !== 3.4 ||
            roundtrip.daily.length !== 1 ||
            roundtrip.daily[0]?.weatherCode !== 71
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(roundtrip)}` };
          }
          if (afterDelete !== null) {
            return { status: 'fail', detail: 'cache doc still present after delete' };
          }
          return { status: 'pass' };
        }
        case 'wmo-mapping': {
          const checks: Array<[number, string, string]> = [
            [0, '☀️', 'tool.weather.wmo.clear'],
            [2, '🌤️', 'tool.weather.wmo.partly'],
            [3, '☁️', 'tool.weather.wmo.overcast'],
            [45, '🌫️', 'tool.weather.wmo.fog'],
            [61, '🌧️', 'tool.weather.wmo.rain'],
            [75, '🌨️', 'tool.weather.wmo.snow'],
            [81, '🌦️', 'tool.weather.wmo.showers'],
            [95, '⛈️', 'tool.weather.wmo.thunder'],
            [42, '🌡️', 'tool.weather.wmo.unknown'],
          ];
          for (const [code, emoji, labelKey] of checks) {
            const info = wmoInfo(code);
            if (info.emoji !== emoji || info.labelKey !== labelKey) {
              return {
                status: 'fail',
                detail: `WMO ${code}: expected ${emoji}/${labelKey}, got ${info.emoji}/${info.labelKey}`,
              };
            }
          }
          return { status: 'pass' };
        }
        case 'url-building': {
          const expected =
            'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41' +
            '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
            '&timezone=auto&forecast_days=5';
          const actual = buildForecastUrl(52.52, 13.41);
          if (actual !== expected) {
            return { status: 'fail', detail: `URL mismatch: ${actual}` };
          }
          return { status: 'pass' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
