/**
 * Minimal shared audio helpers (Web Audio). Tools with the "audio"
 * permission build on these instead of each rolling their own oscillator
 * code (previously duplicated in alarm + pomodoro). No assets are loaded
 * here – loop sources are handed in as same-origin URLs bundled by Vite.
 *
 * Everything degrades to a silent no-op when AudioContext is unavailable
 * (jsdom, diagnose scratch runs), mirroring the alarm chime's behaviour.
 */

export type ToneStep = {
  /** Frequency in Hz. */
  freq: number;
  /** Duration of this step in milliseconds. */
  ms: number;
};

/**
 * Plays a short tone sequence (chimes, cues). Resolves when the pattern
 * has finished; resolves immediately in silent environments.
 */
export async function playTonePattern(
  steps: readonly ToneStep[],
  opts: { volume?: number; type?: OscillatorType } = {},
): Promise<void> {
  const Ctx = typeof AudioContext !== 'undefined' ? AudioContext : undefined;
  if (!Ctx || steps.length === 0) return;
  const audio = new Ctx();
  try {
    const gain = audio.createGain();
    const volume = Math.min(1, Math.max(0, opts.volume ?? 0.2));
    gain.gain.value = volume;
    gain.connect(audio.destination);

    const osc = audio.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.connect(gain);

    let at = audio.currentTime;
    for (const step of steps) {
      osc.frequency.setValueAtTime(step.freq, at);
      at += step.ms / 1000;
    }
    // Fade out to avoid a click at the end.
    gain.gain.setValueAtTime(volume, Math.max(audio.currentTime, at - 0.05));
    gain.gain.exponentialRampToValueAtTime(0.0001, at);
    osc.start();
    osc.stop(at);
    await new Promise<void>((resolve) => {
      osc.onended = () => resolve();
    });
  } finally {
    void audio.close().catch(() => {});
  }
}

export interface LoopPlayer {
  /** Starts (or resumes) the loop. Safe to call repeatedly. */
  play(): Promise<void>;
  stop(): void;
  /** 0–1; applied live. */
  setVolume(volume: number): void;
  readonly playing: boolean;
  /** Releases the audio context and buffers. The player is unusable after. */
  dispose(): void;
}

/**
 * Sample-accurate gapless loop player for a bundled audio asset
 * (soundscapes). Decodes the file once into an AudioBuffer and loops it via
 * an AudioBufferSourceNode – unlike HTMLAudioElement.loop this has NO gap
 * or hitch at the seam. A GainNode carries live volume.
 */
export function createLoopPlayer(url: string, initialVolume = 0.5): LoopPlayer {
  const Ctx = typeof AudioContext !== 'undefined' ? AudioContext : undefined;
  let audio: AudioContext | null = null;
  let gain: GainNode | null = null;
  let source: AudioBufferSourceNode | null = null;
  let buffer: AudioBuffer | null = null;
  let loading: Promise<AudioBuffer | null> | null = null;
  let volume = Math.min(1, Math.max(0, initialVolume));
  let disposed = false;
  let playing = false;

  async function loadBuffer(): Promise<AudioBuffer | null> {
    if (buffer) return buffer;
    if (!loading) {
      loading = (async () => {
        try {
          const response = await fetch(url); // same-origin bundled asset
          const bytes = await response.arrayBuffer();
          if (!audio) return null;
          buffer = await audio.decodeAudioData(bytes);
          return buffer;
        } catch {
          return null; // missing codec/asset: stay silent, never throw
        }
      })();
    }
    return loading;
  }

  return {
    async play() {
      if (!Ctx || disposed || playing) return;
      audio ??= new Ctx();
      gain ??= (() => {
        const node = audio.createGain();
        node.gain.value = volume;
        node.connect(audio.destination);
        return node;
      })();
      const decoded = await loadBuffer();
      if (!decoded || disposed || playing || !audio || !gain) return;
      if (audio.state === 'suspended') await audio.resume().catch(() => {});
      source = audio.createBufferSource();
      source.buffer = decoded;
      source.loop = true; // sample-accurate, gapless
      source.connect(gain);
      source.start();
      playing = true;
    },
    stop() {
      if (source) {
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
        source.disconnect();
        source = null;
      }
      playing = false;
    },
    setVolume(next: number) {
      volume = Math.min(1, Math.max(0, next));
      if (gain && audio) {
        // Short ramp avoids zipper noise on slider drags.
        gain.gain.setTargetAtTime(volume, audio.currentTime, 0.03);
      }
    },
    get playing() {
      return playing && !disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (source) {
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
        source.disconnect();
        source = null;
      }
      playing = false;
      buffer = null;
      if (audio) void audio.close().catch(() => {});
      audio = null;
      gain = null;
    },
  };
}
