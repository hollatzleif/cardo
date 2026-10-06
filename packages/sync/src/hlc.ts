/**
 * Hybrid Logical Clock – same format and rollover as hlc.rs:
 * `<unix_ms:013>-<counter:04>-<device_id>`, counter rolls over after 9999.
 * The state is a plain value so stores can persist it in the same
 * transaction as the write (monotonic across restarts and tabs).
 */

export interface HlcState {
  lastMs: number;
  counter: number;
}

export const HLC_ZERO: HlcState = { lastMs: 0, counter: 0 };

export function formatHlc(state: HlcState, deviceId: string): string {
  return `${String(state.lastMs).padStart(13, '0')}-${String(state.counter).padStart(4, '0')}-${deviceId}`;
}

/** Advances the clock; pure. */
export function tickHlc(state: HlcState, wallMs: number): HlcState {
  if (wallMs > state.lastMs) return { lastMs: wallMs, counter: 0 };
  // Wall clock stalled or went backwards: the logical part keeps us monotonic.
  const counter = state.counter + 1;
  return counter > 9999 ? { lastMs: state.lastMs + 1, counter: 0 } : { lastMs: state.lastMs, counter };
}

/**
 * Remote hlcs further ahead of the local wall clock than this are not
 * observed: one device with a wildly wrong clock (or a forged op) must not
 * drag every other device's clock into the far future.
 */
export const MAX_HLC_DRIFT_MS = 24 * 60 * 60 * 1000;

const HLC_RE = /^(\d{13})-(\d{4})-/;

/** `<ms>-<counter>` of an hlc string, or null when it is not one. */
export function parseHlc(hlc: string): HlcState | null {
  const m = HLC_RE.exec(hlc);
  return m ? { lastMs: Number(m[1]), counter: Number(m[2]) } : null;
}

/**
 * HLC receive rule (pure): after seeing a remote hlc, the next local tick
 * sorts after it, so a local edit made after applying a remote op always
 * wins against that op on every device. Same rule as `Hlc::observe` in
 * hlc.rs.
 */
export function observeHlc(state: HlcState, remoteHlc: string, wallMs: number): HlcState {
  const r = parseHlc(remoteHlc);
  if (!r || r.lastMs > wallMs + MAX_HLC_DRIFT_MS) return state;
  if (r.lastMs > state.lastMs || (r.lastMs === state.lastMs && r.counter > state.counter)) return r;
  return state;
}

export function isHlcState(value: unknown): value is HlcState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.lastMs) && Number.isSafeInteger(v.counter);
}

/** In-memory clock for callers without a store (mirrors Rust `Hlc`). */
export class Hlc {
  #state: HlcState;
  readonly deviceId: string;
  readonly #wall: () => number;

  constructor(deviceId: string, state: HlcState = HLC_ZERO, wall: () => number = Date.now) {
    this.deviceId = deviceId;
    this.#state = state;
    this.#wall = wall;
  }

  get state(): HlcState {
    return this.#state;
  }

  now(): string {
    this.#state = tickHlc(this.#state, this.#wall());
    return formatHlc(this.#state, this.deviceId);
  }

  observe(remoteHlc: string): void {
    this.#state = observeHlc(this.#state, remoteHlc, this.#wall());
  }
}
