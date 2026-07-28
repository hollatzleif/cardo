// Browser APIs jsdom does not implement, needed by anything that mounts a
// widget or a surface. Previously duplicated per test file; hoisted here so
// every jsdom test gets the same environment and a new one does not fail for
// want of a polyfill someone else already wrote.
//
// Registered via `setupFiles` in vitest.config.ts. Safe in node-environment
// tests too: every branch is guarded on the API being absent, and `window`
// only exists under jsdom.

const g = globalThis as Record<string, unknown>;

// Deliberately NOT set here: IS_REACT_ACT_ENVIRONMENT. Turning it on globally
// makes React emit act() warnings for any render outside act() — including the
// diagnose suite's own widget probes, which treat every console.error as a
// check failure. Suites that drive React through act() set it themselves.

if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
}

if (typeof g.ResizeObserver !== 'function') {
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (typeof g.IntersectionObserver !== 'function') {
  g.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
}

// Used by the network-facing tools for request timeouts; absent in older jsdom.
const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
if (typeof AS.timeout !== 'function') {
  AS.timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
}
