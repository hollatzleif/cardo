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
  /** Releases the audio context and element. The player is unusable after. */
  dispose(): void;
}

/**
 * Gapless-ish loop player for a bundled audio asset (soundscapes). Uses a
 * plain HTMLAudioElement with `loop` – good enough for ambience tracks with
 * loop-friendly edges – plus a gain node for live volume control.
 */
export function createLoopPlayer(url: string, initialVolume = 0.5): LoopPlayer {
  const supported = typeof Audio !== 'undefined';
  const element = supported ? new Audio(url) : null;
  if (element) {
    element.loop = true;
    element.volume = Math.min(1, Math.max(0, initialVolume));
  }
  let disposed = false;

  return {
    async play() {
      if (!element || disposed) return;
      try {
        await element.play();
      } catch {
        // Autoplay policies / missing codec: stay silent rather than throw.
      }
    },
    stop() {
      if (!element || disposed) return;
      element.pause();
      element.currentTime = 0;
    },
    setVolume(volume: number) {
      if (!element || disposed) return;
      element.volume = Math.min(1, Math.max(0, volume));
    },
    get playing() {
      return element !== null && !disposed && !element.paused;
    },
    dispose() {
      if (!element || disposed) return;
      element.pause();
      element.src = '';
      disposed = true;
    },
  };
}
