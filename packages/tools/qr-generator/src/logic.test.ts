import { describe, expect, it } from 'vitest';
import {
  buildQrContext,
  escapeWifiValue,
  normalizeUrl,
  payloadFor,
  pushRecent,
  RECENT_MAX,
  wifiPayload,
} from './logic';

describe('escapeWifiValue', () => {
  it('escapes every special character with a backslash', () => {
    expect(escapeWifiValue('a;b')).toBe('a\\;b');
    expect(escapeWifiValue('a,b')).toBe('a\\,b');
    expect(escapeWifiValue('a:b')).toBe('a\\:b');
    expect(escapeWifiValue('a"b')).toBe('a\\"b');
    expect(escapeWifiValue('a\\b')).toBe('a\\\\b');
  });

  it('escapes the backslash itself before it can double-escape others', () => {
    // \; must become \\\; (escaped backslash + escaped semicolon), not \\;
    expect(escapeWifiValue('\\;')).toBe('\\\\\\;');
  });

  it('leaves ordinary characters untouched', () => {
    expect(escapeWifiValue('My Café_5G!')).toBe('My Café_5G!');
  });
});

describe('wifiPayload', () => {
  it('builds the WIFI: format for WPA', () => {
    expect(wifiPayload('mynet', 'secret', 'WPA')).toBe('WIFI:T:WPA;S:mynet;P:secret;;');
  });

  it('escapes SSID and password', () => {
    expect(wifiPayload('a;b', 'p:w,x"y\\z', 'WPA')).toBe(
      'WIFI:T:WPA;S:a\\;b;P:p\\:w\\,x\\"y\\\\z;;',
    );
  });

  it('rejects empty or whitespace-only SSIDs', () => {
    expect(wifiPayload('', 'secret', 'WPA')).toBeNull();
    expect(wifiPayload('   ', 'secret', 'WPA')).toBeNull();
  });

  it('omits the password field for open networks', () => {
    expect(wifiPayload('mynet', 'ignored', 'nopass')).toBe('WIFI:T:nopass;S:mynet;;');
  });

  it('supports WEP', () => {
    expect(wifiPayload('mynet', 'k', 'WEP')).toBe('WIFI:T:WEP;S:mynet;P:k;;');
  });
});

describe('normalizeUrl', () => {
  it('keeps explicit schemes', () => {
    expect(normalizeUrl('https://example.org')).toBe('https://example.org');
    expect(normalizeUrl('mailto:leif@example.org')).toBe('mailto:leif@example.org');
  });

  it('prepends https:// when the scheme is missing', () => {
    expect(normalizeUrl('example.org/x')).toBe('https://example.org/x');
  });

  it('trims and rejects empty input', () => {
    expect(normalizeUrl('  example.org ')).toBe('https://example.org');
    expect(normalizeUrl('   ')).toBeNull();
  });
});

describe('payloadFor', () => {
  it('passes text through verbatim and rejects empty text', () => {
    expect(payloadFor('text', { text: 'hello world' })).toBe('hello world');
    expect(payloadFor('text', { text: '' })).toBeNull();
    expect(payloadFor('text', {})).toBeNull();
  });

  it('routes url and wifi to their builders', () => {
    expect(payloadFor('url', { url: 'example.org' })).toBe('https://example.org');
    expect(payloadFor('wifi', { ssid: 'net', password: 'pw' })).toBe('WIFI:T:WPA;S:net;P:pw;;');
    expect(payloadFor('wifi', { ssid: '' })).toBeNull();
  });
});

describe('pushRecent', () => {
  it('prepends, dedupes and caps at the maximum', () => {
    expect(pushRecent(['b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
    expect(pushRecent(['a', 'b'], 'b')).toEqual(['b', 'a']);
    const full = ['1', '2', '3', '4', '5'];
    expect(pushRecent(full, '6')).toEqual(['6', '1', '2', '3', '4']);
    expect(pushRecent(full, '6')).toHaveLength(RECENT_MAX);
  });

  it('ignores empty payloads', () => {
    expect(pushRecent(['a'], '')).toEqual(['a']);
  });
});

describe('buildQrContext', () => {
  it('mentions the empty state in both languages', () => {
    expect(buildQrContext([], 'en')).toContain('nothing encoded');
    expect(buildQrContext([], 'de')).toContain('noch nichts');
  });

  it('lists recent payloads, long ones shortened', () => {
    const text = buildQrContext(['https://example.org', 'x'.repeat(80)], 'en');
    expect(text).toContain('https://example.org');
    expect(text).toContain('…');
    expect(text).not.toContain('x'.repeat(61));
  });
});
