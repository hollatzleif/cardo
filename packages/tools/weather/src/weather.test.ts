// Pure unit tests – node environment, NO network, no host.
import { describe, expect, it } from 'vitest';
import {
  buildForecastUrl,
  buildGeocodingUrl,
  dataAgeMinutes,
  parseForecastResponse,
  parseGeocodingResponse,
  weekdayInitial,
  wmoInfo,
} from './weather';

describe('buildForecastUrl', () => {
  it('builds the exact Open-Meteo forecast URL', () => {
    expect(buildForecastUrl(52.52, 13.41)).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41' +
        '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
        '&timezone=auto&forecast_days=5',
    );
  });

  it('handles negative coordinates', () => {
    expect(buildForecastUrl(-33.87, -151.21)).toContain('latitude=-33.87&longitude=-151.21');
  });
});

describe('buildGeocodingUrl', () => {
  it('builds the exact geocoding URL', () => {
    expect(buildGeocodingUrl('Berlin', 'de')).toBe(
      'https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=5&language=de',
    );
  });

  it('URL-encodes the query and strips locale regions', () => {
    expect(buildGeocodingUrl('São Paulo', 'de-DE')).toBe(
      'https://geocoding-api.open-meteo.com/v1/search?name=S%C3%A3o%20Paulo&count=5&language=de',
    );
  });
});

describe('wmoInfo', () => {
  const cases: Array<[number, string, string]> = [
    [0, '☀️', 'tool.weather.wmo.clear'],
    [1, '🌤️', 'tool.weather.wmo.partly'],
    [2, '🌤️', 'tool.weather.wmo.partly'],
    [3, '☁️', 'tool.weather.wmo.overcast'],
    [45, '🌫️', 'tool.weather.wmo.fog'],
    [48, '🌫️', 'tool.weather.wmo.fog'],
    [51, '🌧️', 'tool.weather.wmo.rain'],
    [67, '🌧️', 'tool.weather.wmo.rain'],
    [71, '🌨️', 'tool.weather.wmo.snow'],
    [77, '🌨️', 'tool.weather.wmo.snow'],
    [80, '🌦️', 'tool.weather.wmo.showers'],
    [82, '🌦️', 'tool.weather.wmo.showers'],
    [85, '🌨️', 'tool.weather.wmo.snow'],
    [95, '⛈️', 'tool.weather.wmo.thunder'],
    [99, '⛈️', 'tool.weather.wmo.thunder'],
  ];

  it.each(cases)('maps WMO code %i', (code, emoji, labelKey) => {
    expect(wmoInfo(code)).toEqual({ emoji, labelKey });
  });

  it('falls back honestly for unknown codes', () => {
    expect(wmoInfo(42)).toEqual({ emoji: '🌡️', labelKey: 'tool.weather.wmo.unknown' });
    expect(wmoInfo(-1).labelKey).toBe('tool.weather.wmo.unknown');
  });
});

describe('parseForecastResponse', () => {
  const payload = {
    current: {
      temperature_2m: 21.4,
      weather_code: 2,
      wind_speed_10m: 12.3,
      relative_humidity_2m: 58,
    },
    daily: {
      time: ['2026-07-12', '2026-07-13'],
      weather_code: [2, 61],
      temperature_2m_max: [24.1, 19.5],
      temperature_2m_min: [14.2, 12.8],
    },
  };

  it('parses a valid payload', () => {
    expect(parseForecastResponse(payload)).toEqual({
      current: { temperature: 21.4, weatherCode: 2, windSpeed: 12.3, humidity: 58 },
      daily: [
        { date: '2026-07-12', weatherCode: 2, tempMax: 24.1, tempMin: 14.2 },
        { date: '2026-07-13', weatherCode: 61, tempMax: 19.5, tempMin: 12.8 },
      ],
    });
  });

  it('rejects garbage instead of caching it', () => {
    expect(parseForecastResponse(null)).toBeNull();
    expect(parseForecastResponse('nope')).toBeNull();
    expect(parseForecastResponse({})).toBeNull();
    expect(parseForecastResponse({ current: {}, daily: {} })).toBeNull();
    expect(
      parseForecastResponse({ ...payload, current: { ...payload.current, temperature_2m: 'hot' } }),
    ).toBeNull();
  });

  it('skips malformed daily rows but keeps the rest', () => {
    const mangled = {
      ...payload,
      daily: { ...payload.daily, temperature_2m_max: [24.1, 'broken'] },
    };
    const parsed = parseForecastResponse(mangled);
    expect(parsed?.daily).toEqual([{ date: '2026-07-12', weatherCode: 2, tempMax: 24.1, tempMin: 14.2 }]);
  });
});

describe('parseGeocodingResponse', () => {
  it('parses results with a readable region', () => {
    const json = {
      results: [
        { name: 'Berlin', latitude: 52.52, longitude: 13.41, country: 'Deutschland', admin1: 'Berlin' },
        { name: 'Berlin', latitude: 44.47, longitude: -71.19, country: 'USA' },
      ],
    };
    expect(parseGeocodingResponse(json)).toEqual([
      { name: 'Berlin', lat: 52.52, lon: 13.41, region: 'Berlin · Deutschland' },
      { name: 'Berlin', lat: 44.47, lon: -71.19, region: 'USA' },
    ]);
  });

  it('returns an empty list for empty or malformed payloads', () => {
    expect(parseGeocodingResponse({})).toEqual([]);
    expect(parseGeocodingResponse(null)).toEqual([]);
    expect(parseGeocodingResponse({ results: [{ name: 42, latitude: 1, longitude: 2 }] })).toEqual([]);
  });
});

describe('dataAgeMinutes', () => {
  const now = new Date('2026-07-12T12:00:00.000Z');

  it('floors to whole minutes', () => {
    expect(dataAgeMinutes('2026-07-12T11:59:30.000Z', now)).toBe(0);
    expect(dataAgeMinutes('2026-07-12T11:55:00.000Z', now)).toBe(5);
    expect(dataAgeMinutes('2026-07-12T10:00:00.000Z', now)).toBe(120);
  });

  it('never goes negative for clock skew', () => {
    expect(dataAgeMinutes('2026-07-12T12:05:00.000Z', now)).toBe(0);
  });

  it('treats unparsable timestamps as infinitely stale', () => {
    expect(dataAgeMinutes('not-a-date', now)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('weekdayInitial', () => {
  it('returns the narrow weekday via Intl', () => {
    // 2026-07-13 is a Monday.
    expect(weekdayInitial('2026-07-13', 'en')).toBe('M');
    expect(weekdayInitial('2026-07-12', 'de')).toBe('S'); // Sonntag
  });

  it('falls back to English for unknown locales', () => {
    expect(weekdayInitial('2026-07-13', 'zz-INVALID-!!')).toBeTruthy();
  });
});
