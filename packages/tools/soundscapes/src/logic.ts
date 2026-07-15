/**
 * Pure mixer logic for the soundscapes tool – no audio, no host access.
 * The actual LoopPlayer wiring (and the bundled .wav asset URLs) lives
 * in index.tsx; this module owns the state machine and the math.
 */

/* ── Tracks ───────────────────────────────────────────────────────────── */

export type TrackId = 'rain' | 'white-noise' | 'brown-noise' | 'stream';

export const TRACK_IDS: readonly TrackId[] = ['rain', 'white-noise', 'brown-noise', 'stream'];

/** Track metadata: id + i18n label key (asset URLs are wired in index.tsx,
 * because Vite asset imports don't belong in pure logic). */
export const TRACKS: ReadonlyArray<{ id: TrackId; labelKey: string }> = TRACK_IDS.map((id) => ({
  id,
  labelKey: `tool.soundscapes.track.${id}`,
}));

/* ── Mixer state ──────────────────────────────────────────────────────── */

export type TrackState = {
  enabled: boolean;
  /** 0–1 */
  volume: number;
};

export type MixerState = {
  /** Master switch – true while the mix is (supposed to be) audible. */
  playing: boolean;
  /** 0–1, multiplied onto every track volume. */
  master: number;
  tracks: Record<TrackId, TrackState>;
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function defaultMixer(): MixerState {
  return {
    playing: false,
    master: 0.8,
    tracks: {
      rain: { enabled: true, volume: 0.7 },
      'white-noise': { enabled: false, volume: 0.5 },
      'brown-noise': { enabled: false, volume: 0.5 },
      stream: { enabled: false, volume: 0.5 },
    },
  };
}

/** Defensive load: anything not shaped like a mixer collapses to defaults. */
export function normalizeMixer(raw: unknown): MixerState {
  const base = defaultMixer();
  if (typeof raw !== 'object' || raw === null) return base;
  const root = raw as Record<string, unknown>;
  const state: MixerState = {
    playing: root.playing === true,
    master: typeof root.master === 'number' ? clamp01(root.master) : base.master,
    tracks: { ...base.tracks },
  };
  const tracks =
    typeof root.tracks === 'object' && root.tracks !== null
      ? (root.tracks as Record<string, unknown>)
      : {};
  for (const id of TRACK_IDS) {
    const entry = tracks[id];
    if (typeof entry !== 'object' || entry === null) continue;
    const track = entry as Record<string, unknown>;
    state.tracks[id] = {
      enabled: track.enabled === true,
      volume: typeof track.volume === 'number' ? clamp01(track.volume) : base.tracks[id].volume,
    };
  }
  return state;
}

/** What actually reaches the ear: clamped track × master, 0 when disabled. */
export function effectiveVolume(track: TrackState, master: number): number {
  if (!track.enabled) return 0;
  return clamp01(clamp01(track.volume) * clamp01(master));
}

export function enabledTracks(state: MixerState): TrackId[] {
  return TRACK_IDS.filter((id) => state.tracks[id].enabled);
}

/* ── Reducer ──────────────────────────────────────────────────────────── */

export type MixerAction =
  | { type: 'play' }
  | { type: 'stop' }
  | { type: 'toggle-track'; track: TrackId }
  | { type: 'solo'; track: TrackId }
  | { type: 'set-volume'; track: TrackId; volume: number }
  | { type: 'set-master'; volume: number };

/** Pure state transitions; never mutates, always clamps. */
export function mixerReducer(state: MixerState, action: MixerAction): MixerState {
  switch (action.type) {
    case 'play': {
      // Pressing play on an all-silent mix enables the first track –
      // "play" must never be a silent no-op for the user.
      if (enabledTracks(state).length > 0) return { ...state, playing: true };
      const first: TrackId = TRACK_IDS[0] ?? 'rain';
      return {
        ...state,
        playing: true,
        tracks: { ...state.tracks, [first]: { ...state.tracks[first], enabled: true } },
      };
    }
    case 'stop':
      return { ...state, playing: false };
    case 'toggle-track': {
      const track = state.tracks[action.track];
      return {
        ...state,
        tracks: { ...state.tracks, [action.track]: { ...track, enabled: !track.enabled } },
      };
    }
    case 'solo': {
      const tracks = { ...state.tracks };
      for (const id of TRACK_IDS) tracks[id] = { ...tracks[id], enabled: id === action.track };
      return { ...state, tracks };
    }
    case 'set-volume': {
      const track = state.tracks[action.track];
      return {
        ...state,
        tracks: {
          ...state.tracks,
          [action.track]: { ...track, volume: clamp01(action.volume) },
        },
      };
    }
    case 'set-master':
      return { ...state, master: clamp01(action.volume) };
  }
}

/* ── Assistant context ────────────────────────────────────────────────── */

const TRACK_NAMES: Record<'de' | 'en', Record<TrackId, string>> = {
  de: {
    rain: 'Regen',
    'white-noise': 'Weißes Rauschen',
    'brown-noise': 'Braunes Rauschen',
    stream: 'Bachlauf',
  },
  en: {
    rain: 'Rain',
    'white-noise': 'White noise',
    'brown-noise': 'Brown noise',
    stream: 'Stream',
  },
};

/** One line: what is (or would be) playing, at which master volume. */
export function buildSoundscapesContext(state: MixerState, lang: string): string {
  const de = lang.startsWith('de');
  const names = TRACK_NAMES[de ? 'de' : 'en'];
  const active = enabledTracks(state).map((id) => names[id]);
  const percent = Math.round(state.master * 100);
  if (!state.playing) {
    if (active.length === 0) {
      return de ? 'Klangkulisse aus, kein Track gewählt.' : 'Soundscape off, no track selected.';
    }
    return de
      ? `Klangkulisse pausiert. Gewählte Tracks: ${active.join(', ')}.`
      : `Soundscape paused. Selected tracks: ${active.join(', ')}.`;
  }
  return de
    ? `Klangkulisse läuft (${active.join(', ') || 'stumm'}) bei ${percent} % Gesamtlautstärke.`
    : `Soundscape playing (${active.join(', ') || 'silent'}) at ${percent} % master volume.`;
}
