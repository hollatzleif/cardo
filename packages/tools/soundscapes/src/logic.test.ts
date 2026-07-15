import { describe, expect, it } from 'vitest';
import {
  TRACKS,
  TRACK_IDS,
  buildSoundscapesContext,
  clamp01,
  defaultMixer,
  effectiveVolume,
  enabledTracks,
  mixerReducer,
  normalizeMixer,
  type MixerState,
} from './logic';

describe('defaults & metadata', () => {
  it('TRACKS covers every TrackId with a namespaced label key', () => {
    expect(TRACKS.map((t) => t.id)).toEqual([...TRACK_IDS]);
    for (const track of TRACKS) {
      expect(track.labelKey).toBe(`tool.soundscapes.track.${track.id}`);
    }
  });

  it('defaultMixer: paused, rain preselected, sane volumes', () => {
    const state = defaultMixer();
    expect(state.playing).toBe(false);
    expect(enabledTracks(state)).toEqual(['rain']);
    expect(state.master).toBeGreaterThan(0);
    expect(state.master).toBeLessThanOrEqual(1);
    for (const id of TRACK_IDS) {
      expect(state.tracks[id].volume).toBeGreaterThanOrEqual(0);
      expect(state.tracks[id].volume).toBeLessThanOrEqual(1);
    }
  });
});

describe('clamp01 / effectiveVolume', () => {
  it('clamps into [0, 1] and neutralizes NaN/Infinity', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(7)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('effective volume is the clamped product, 0 when disabled', () => {
    expect(effectiveVolume({ enabled: true, volume: 0.5 }, 0.8)).toBeCloseTo(0.4, 10);
    expect(effectiveVolume({ enabled: true, volume: 1 }, 1)).toBe(1);
    expect(effectiveVolume({ enabled: false, volume: 1 }, 1)).toBe(0);
    expect(effectiveVolume({ enabled: true, volume: 2 }, 2)).toBe(1);
    expect(effectiveVolume({ enabled: true, volume: -1 }, 0.5)).toBe(0);
  });
});

describe('mixerReducer', () => {
  const base = defaultMixer();

  it('play / stop toggle the playing flag without touching tracks', () => {
    const playing = mixerReducer(base, { type: 'play' });
    expect(playing.playing).toBe(true);
    expect(playing.tracks).toEqual(base.tracks);
    const stopped = mixerReducer(playing, { type: 'stop' });
    expect(stopped.playing).toBe(false);
    expect(stopped.tracks).toEqual(base.tracks);
  });

  it('play on an all-silent mix enables the first track (never a silent no-op)', () => {
    const silent = mixerReducer(base, { type: 'toggle-track', track: 'rain' });
    expect(enabledTracks(silent)).toEqual([]);
    const playing = mixerReducer(silent, { type: 'play' });
    expect(playing.playing).toBe(true);
    expect(enabledTracks(playing)).toEqual(['rain']);
  });

  it('toggle-track flips exactly one track', () => {
    const next = mixerReducer(base, { type: 'toggle-track', track: 'stream' });
    expect(enabledTracks(next).sort()).toEqual(['rain', 'stream']);
    expect(mixerReducer(next, { type: 'toggle-track', track: 'stream' }).tracks).toEqual(base.tracks);
  });

  it('solo enables only the given track', () => {
    const mixed = mixerReducer(base, { type: 'toggle-track', track: 'white-noise' });
    const solo = mixerReducer(mixed, { type: 'solo', track: 'brown-noise' });
    expect(enabledTracks(solo)).toEqual(['brown-noise']);
    // Volumes survive a solo.
    expect(solo.tracks.rain.volume).toBe(base.tracks.rain.volume);
  });

  it('set-volume / set-master clamp', () => {
    expect(mixerReducer(base, { type: 'set-volume', track: 'rain', volume: 1.5 }).tracks.rain.volume).toBe(1);
    expect(mixerReducer(base, { type: 'set-volume', track: 'rain', volume: -0.5 }).tracks.rain.volume).toBe(0);
    expect(mixerReducer(base, { type: 'set-master', volume: 42 }).master).toBe(1);
    expect(mixerReducer(base, { type: 'set-master', volume: 0.3 }).master).toBe(0.3);
  });

  it('never mutates the input state', () => {
    const before = JSON.stringify(base);
    mixerReducer(base, { type: 'solo', track: 'stream' });
    mixerReducer(base, { type: 'set-volume', track: 'rain', volume: 0 });
    mixerReducer(base, { type: 'play' });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('normalizeMixer', () => {
  it('garbage collapses to defaults', () => {
    expect(normalizeMixer(null)).toEqual(defaultMixer());
    expect(normalizeMixer('loud')).toEqual(defaultMixer());
    expect(normalizeMixer(42)).toEqual(defaultMixer());
  });

  it('partial/dirty state is repaired and clamped', () => {
    const state = normalizeMixer({
      playing: 'yes', // not a boolean → false
      master: 3, // clamped
      tracks: {
        rain: { enabled: true, volume: -2 },
        bogus: { enabled: true, volume: 1 }, // unknown id → ignored
      },
    });
    expect(state.playing).toBe(false);
    expect(state.master).toBe(1);
    expect(state.tracks.rain).toEqual({ enabled: true, volume: 0 });
    expect(state.tracks.stream).toEqual(defaultMixer().tracks.stream);
    expect(Object.keys(state.tracks).sort()).toEqual([...TRACK_IDS].sort());
  });
});

describe('buildSoundscapesContext', () => {
  const playing: MixerState = {
    ...defaultMixer(),
    playing: true,
    master: 0.8,
  };

  it('off / paused / playing states, both languages', () => {
    const off = mixerReducer(defaultMixer(), { type: 'toggle-track', track: 'rain' });
    expect(buildSoundscapesContext(off, 'en')).toBe('Soundscape off, no track selected.');
    expect(buildSoundscapesContext(off, 'de')).toBe('Klangkulisse aus, kein Track gewählt.');

    expect(buildSoundscapesContext(defaultMixer(), 'en')).toContain('paused');
    expect(buildSoundscapesContext(defaultMixer(), 'en')).toContain('Rain');

    expect(buildSoundscapesContext(playing, 'en')).toBe('Soundscape playing (Rain) at 80 % master volume.');
    expect(buildSoundscapesContext(playing, 'de-DE')).toBe('Klangkulisse läuft (Regen) bei 80 % Gesamtlautstärke.');
  });
});
