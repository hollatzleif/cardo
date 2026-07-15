import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  WidgetProps,
} from '@cardo/plugin-api';
import { createLoopPlayer, type LoopPlayer } from '@cardo/ui';
import manifest from '../manifest.json';
import rainUrl from './assets/rain.wav';
import whiteNoiseUrl from './assets/white-noise.wav';
import brownNoiseUrl from './assets/brown-noise.wav';
import streamUrl from './assets/stream.wav';
import {
  TRACKS,
  TRACK_IDS,
  buildSoundscapesContext,
  defaultMixer,
  effectiveVolume,
  enabledTracks,
  mixerReducer,
  normalizeMixer,
  type MixerAction,
  type MixerState,
  type TrackId,
} from './logic';

/** Bundled loop assets – everything ships with Cardo, nothing is loaded
 * from the network (that's why this tool stays privacy-green). */
const TRACK_URLS: Record<TrackId, string> = {
  rain: rainUrl,
  'white-noise': whiteNoiseUrl,
  'brown-noise': brownNoiseUrl,
  stream: streamUrl,
};

/**
 * Soundscapes – a small ambience mixer on bundled loops.
 *
 * All audio flows through @cardo/ui's LoopPlayer, which degrades to a
 * silent no-op wherever Audio is unavailable (jsdom, diagnose scratch
 * runs) – commands therefore always succeed, they just stay quiet.
 */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const players = new Map<TrackId, LoopPlayer>();
  const eventUnsubs: Array<() => void> = [];

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadState(c: ToolContext): Promise<MixerState> {
    return normalizeMixer(await c.settings.get<MixerState>('mixer'));
  }

  /** Make the audible world match the state: lazy players, live volumes. */
  function syncPlayers(state: MixerState): void {
    for (const id of TRACK_IDS) {
      const volume = effectiveVolume(state.tracks[id], state.master);
      const shouldPlay = state.playing && volume > 0;
      let player = players.get(id);
      if (!player) {
        if (!shouldPlay) continue; // created lazily, only when first needed
        player = createLoopPlayer(TRACK_URLS[id], volume);
        players.set(id, player);
      }
      player.setVolume(volume);
      if (shouldPlay) void player.play();
      else player.stop();
    }
  }

  function disposePlayers(): void {
    for (const player of players.values()) player.dispose();
    players.clear();
  }

  /**
   * The one write path: reduce, persist, and (optionally) apply audio.
   * Self-tests pass `audio: false` so diagnose runs stay silent.
   */
  async function applyAction(
    c: ToolContext,
    action: MixerAction,
    audio: boolean,
  ): Promise<MixerState> {
    const state = mixerReducer(await loadState(c), action);
    await c.settings.set('mixer', state);
    if (audio) syncPlayers(state);
    return state;
  }

  /* ── Widget ─────────────────────────────────────────────────────────── */

  function SoundscapesWidget(props: WidgetProps) {
    const [state, setState] = useState<MixerState | null>(null);
    const [autoPomodoro, setAutoPomodoro] = useState(false);
    const pomodoroAvailable = ctx?.commands.has('pomodoro.start') ?? false;

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [mixer, auto] = await Promise.all([
        loadState(c),
        c.settings.get<boolean>('autoWithPomodoro'),
      ]);
      setState(mixer);
      setAutoPomodoro(auto === true);
    }, []);

    useEffect(() => {
      let mounted = true;
      const safeReload = () => {
        if (mounted) void reload();
      };
      safeReload();
      const unsub = ctx?.settings.subscribe(safeReload);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [reload]);

    if (!state) {
      return (
        <div className="c-muted" style={{ padding: 'var(--space-3)' }}>
          …
        </div>
      );
    }

    const dispatch = (action: MixerAction) => {
      const c = ctx;
      if (!c) return;
      void applyAction(c, action, true).then(setState);
    };

    const slider = (value: number, onChange: (v: number) => void, label: string) => (
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        aria-label={label}
        title={label}
        style={{ flex: 1, minWidth: 48, accentColor: 'var(--accent)' }}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
    );

    const playButton = (big = false) => (
      <button
        className={`c-btn ${state.playing ? 'c-btn--primary' : 'c-btn--ghost'}`}
        style={big ? { fontSize: '1.4em', padding: 'var(--space-2) var(--space-4)' } : undefined}
        aria-label={state.playing ? t('tool.soundscapes.stop') : t('tool.soundscapes.play')}
        title={state.playing ? t('tool.soundscapes.stop') : t('tool.soundscapes.play')}
        onClick={() => dispatch({ type: state.playing ? 'stop' : 'play' })}
      >
        {state.playing ? '■' : '▶'}
      </button>
    );

    const masterSlider = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', width: '100%' }}>
        <span className="c-muted" style={{ fontSize: '0.85em', flexShrink: 0 }}>
          {t('tool.soundscapes.master')}
        </span>
        {slider(
          state.master,
          (v) => dispatch({ type: 'set-master', volume: v }),
          t('tool.soundscapes.master'),
        )}
      </div>
    );

    const pomodoroRow = pomodoroAvailable ? (
      <label
        className="c-muted"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          fontSize: '0.8em',
          flexShrink: 0,
        }}
      >
        <input
          type="checkbox"
          checked={autoPomodoro}
          style={{ accentColor: 'var(--accent)' }}
          onChange={(e) => {
            setAutoPomodoro(e.target.checked);
            void ctx?.settings.set('autoWithPomodoro', e.target.checked);
          }}
        />
        {t('tool.soundscapes.settings.autoWithPomodoro')}
      </label>
    ) : null;

    let body;
    if (props.variant === 'minimal') {
      body = (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-3)',
          }}
        >
          {playButton(true)}
          {masterSlider}
        </div>
      );
    } else if (props.variant === 'single') {
      const active = enabledTracks(state)[0] ?? 'rain';
      body = (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-3)',
          }}
        >
          <select
            className="c-input"
            value={active}
            aria-label={t('tool.soundscapes.trackLabel')}
            title={t('tool.soundscapes.trackLabel')}
            style={{ width: 'auto' }}
            onChange={(e) => dispatch({ type: 'solo', track: e.target.value as TrackId })}
          >
            {TRACKS.map((track) => (
              <option key={track.id} value={track.id}>
                {t(track.labelKey)}
              </option>
            ))}
          </select>
          {playButton(true)}
          {masterSlider}
        </div>
      );
    } else {
      /* mixer (default) */
      body = (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
            {playButton()}
            {masterSlider}
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
            }}
          >
            {TRACKS.map((track) => {
              const trackState = state.tracks[track.id];
              const audible = state.playing && effectiveVolume(trackState, state.master) > 0;
              return (
                <div
                  key={track.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                >
                  <button
                    className="c-btn c-btn--ghost"
                    style={{
                      padding: '0 var(--space-1)',
                      color: trackState.enabled ? 'var(--accent)' : 'var(--text-muted)',
                      flexShrink: 0,
                    }}
                    aria-label={t('tool.soundscapes.toggleTrack', { track: t(track.labelKey) })}
                    aria-pressed={trackState.enabled}
                    title={t('tool.soundscapes.toggleTrack', { track: t(track.labelKey) })}
                    onClick={() => dispatch({ type: 'toggle-track', track: track.id })}
                  >
                    {audible ? '●' : '○'}
                  </button>
                  <span
                    style={{
                      width: '38%',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                    className={trackState.enabled ? undefined : 'c-muted'}
                  >
                    {t(track.labelKey)}
                  </span>
                  {slider(
                    trackState.volume,
                    (v) => dispatch({ type: 'set-volume', track: track.id, volume: v }),
                    t('tool.soundscapes.volumeLabel', { track: t(track.labelKey) }),
                  )}
                </div>
              );
            })}
          </div>
          {pomodoroRow}
        </>
      );
    }

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          height: '100%',
          padding: 'var(--space-2)',
          overflow: 'hidden',
        }}
      >
        {body}
      </div>
    );
  }

  /* ── Tool ───────────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'soundscapes.play',
        titleKey: 'tool.soundscapes.command.play',
        descriptionKey: 'tool.soundscapes.command.playDesc',
        icon: '▶',
        params: z.object({
          track: z.enum(['rain', 'white-noise', 'brown-noise', 'stream']).optional(),
        }),
        // In silent contexts (diagnose scratch, jsdom) LoopPlayer no-ops,
        // so this probe just flips persisted state – no sound, no failure.
        selfTestParams: {},
        async run(params): Promise<CommandResult> {
          if (params.track) {
            await applyAction(context, { type: 'solo', track: params.track }, false);
          }
          await applyAction(context, { type: 'play' }, true);
          return { ok: true, messageKey: 'tool.soundscapes.msg.playing' };
        },
      });

      context.commands.register({
        id: 'soundscapes.stop',
        titleKey: 'tool.soundscapes.command.stop',
        descriptionKey: 'tool.soundscapes.command.stopDesc',
        icon: '■',
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          await applyAction(context, { type: 'stop' }, true);
          return { ok: true, messageKey: 'tool.soundscapes.msg.stopped' };
        },
      });

      context.commands.register({
        id: 'soundscapes.context',
        titleKey: 'tool.soundscapes.command.context',
        descriptionKey: 'tool.soundscapes.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const state = await loadState(context);
          return {
            ok: true,
            data: { contextText: buildSoundscapesContext(state, context.i18n.language) },
          };
        },
      });

      // Pomodoro coupling (opt-in via the autoWithPomodoro setting):
      // ambience follows the work phases and pauses for breaks.
      const onPhase = (payload: Record<string, unknown>, started: boolean) => {
        void (async () => {
          if ((await context.settings.get<boolean>('autoWithPomodoro')) !== true) return;
          const phase = typeof payload.phase === 'string' ? payload.phase : '';
          if (started) {
            await applyAction(context, phase === 'work' ? { type: 'play' } : { type: 'stop' }, true);
          } else if (phase === 'work') {
            // A finished work phase means break time – back to silence.
            await applyAction(context, { type: 'stop' }, true);
          }
        })();
      };
      eventUnsubs.push(
        context.events.on('pomodoro:phase-started', (p) => onPhase(p, true)),
        context.events.on('pomodoro:finished', (p) => onPhase(p, false)),
      );
    },

    deactivate() {
      for (const unsub of eventUnsubs.splice(0)) unsub();
      disposePlayers();
      ctx = null;
    },

    Widget: SoundscapesWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'mixer-logic': {
          const base = defaultMixer();
          const solo = mixerReducer(base, { type: 'solo', track: 'stream' });
          if (enabledTracks(solo).join(',') !== 'stream') {
            return { status: 'fail', detail: `solo broke: ${enabledTracks(solo).join(',')}` };
          }
          const loud = mixerReducer(base, { type: 'set-volume', track: 'rain', volume: 9 });
          if (loud.tracks.rain.volume !== 1) {
            return { status: 'fail', detail: `volume not clamped: ${loud.tracks.rain.volume}` };
          }
          const eff = effectiveVolume({ enabled: true, volume: 0.5 }, 0.5);
          if (Math.abs(eff - 0.25) > 1e-9) {
            return { status: 'fail', detail: `effective volume off: ${eff}` };
          }
          if (effectiveVolume({ enabled: false, volume: 1 }, 1) !== 0) {
            return { status: 'fail', detail: 'disabled track is not silent' };
          }
          return { status: 'pass', detail: 'reducer + volume math verified' };
        }
        case 'commands': {
          // Exercised through the same applyAction path the commands use,
          // with audio: false – diagnose must stay silent.
          const played = await applyAction(testCtx, { type: 'play' }, false);
          const persisted = normalizeMixer(await testCtx.settings.get('mixer'));
          if (!played.playing || !persisted.playing) {
            return { status: 'fail', detail: 'play did not persist playing=true' };
          }
          if (enabledTracks(persisted).length === 0) {
            return { status: 'fail', detail: 'play left an all-silent mix' };
          }
          const stopped = await applyAction(testCtx, { type: 'stop' }, false);
          const after = normalizeMixer(await testCtx.settings.get('mixer'));
          if (stopped.playing || after.playing) {
            return { status: 'fail', detail: 'stop did not persist playing=false' };
          }
          return { status: 'pass', detail: 'play/stop state machine roundtrips through settings' };
        }
        case 'render':
          return typeof SoundscapesWidget === 'function' && SoundscapesWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
