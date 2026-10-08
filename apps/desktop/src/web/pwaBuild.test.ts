import { describe, expect, it } from 'vitest';
import { buildCsp, buildHeadTags, buildManifest, renderServiceWorker, WEB_BASE } from './pwaBuild';

describe('web app build helpers', () => {
  it('CSP allows only self scripts, Google APIs and known hosts', () => {
    const csp = buildCsp();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain('https://www.googleapis.com');
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
  });

  it('manifest is a standalone app scoped to the web base', () => {
    const m = buildManifest({
      name: 'Cardo',
      shortName: 'Cardo',
      description: 'd',
      themeColor: 'x',
      backgroundColor: 'y',
      lang: 'de',
    });
    expect(m.display).toBe('standalone');
    expect(m.id).toBe(WEB_BASE);
    expect(m.start_url).toBe('./');
    expect((m.icons as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('head tags escape attribute values', () => {
    const tags = buildHeadTags({ title: 'A "B"', themeColor: 'c', csp: "default-src 'self'" });
    expect(tags).toContain('content="A &quot;B&quot;"');
    expect(tags).toContain('apple-mobile-web-app-capable');
  });

  it('service worker embeds version and precache list and parses', () => {
    const src = renderServiceWorker('v1', ['./', 'assets/a.js']);
    expect(src).toContain('"v1"');
    expect(src).toContain('["./","assets/a.js"]');
    expect(() => new Function('self', 'caches', src)).not.toThrow();
  });
});
