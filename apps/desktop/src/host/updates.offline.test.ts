// @vitest-environment jsdom
//
// Update checks on a dead network: dev builds and offline machines must
// never see scary popups. A failing background check stays completely
// silent ('idle', no toast); only an explicit manual check surfaces the
// error state (still no toast – the settings UI renders the status text).
import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const updater = vi.hoisted(() => ({
  check: vi.fn<() => Promise<unknown>>(),
}));

// updates.ts imports the updater plugin lazily via dynamic import.
vi.mock('@tauri-apps/plugin-updater', () => ({ check: updater.check }));

import { getHost, initHost } from './index';
import { checkForUpdates, getUpdateStatus, onUpdateStatus } from './updates';

const toasts: unknown[] = [];
let notifySpy: MockInstance;

beforeAll(() => {
  const host = initHost(); // memory backend – no Tauri in vitest
  host.services.events.on('core:toast', (payload) => toasts.push(payload));
  notifySpy = vi.spyOn(host.services.notifications, 'notify');
});

beforeEach(() => {
  toasts.length = 0;
  notifySpy.mockClear();
  updater.check.mockReset();
});

describe('checkForUpdates with no internet', () => {
  it('background check: resolves, stays silent and returns to idle', async () => {
    updater.check.mockRejectedValue(new TypeError('error sending request: connection refused'));
    const seen: string[] = [];
    const unsub = onUpdateStatus((s) => seen.push(s.state));

    await expect(checkForUpdates({ background: true })).resolves.toBeUndefined();
    unsub();

    expect(getUpdateStatus()).toEqual({ state: 'idle' });
    expect(seen).toEqual(['checking', 'idle']);
    // Transparency principle: no toast, no OS notification – total silence.
    expect(toasts).toEqual([]);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('manual check: resolves, reports the error state, still no toast', async () => {
    updater.check.mockRejectedValue(new TypeError('error sending request: connection refused'));

    await expect(checkForUpdates({ background: false })).resolves.toBeUndefined();

    expect(getUpdateStatus()).toEqual({ state: 'error' });
    expect(toasts).toEqual([]);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('a later successful check recovers from the error state', async () => {
    updater.check.mockRejectedValueOnce(new TypeError('offline'));
    await checkForUpdates({ background: false });
    expect(getUpdateStatus().state).toBe('error');

    updater.check.mockResolvedValueOnce(null); // null = already up to date
    await checkForUpdates({ background: false });
    expect(getUpdateStatus()).toEqual({ state: 'upToDate' });
    expect(toasts).toEqual([]);
    expect(getHost()).toBeDefined();
  });
});
