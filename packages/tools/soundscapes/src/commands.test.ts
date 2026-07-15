// Node environment on purpose: `Audio` is undefined here, so LoopPlayer
// runs its silent no-op path – exactly like the diagnose scratch runs.
// Commands must still succeed and persist their state.
import { describe, expect, it } from 'vitest';
import { createTestContext } from '@cardo/plugin-api/testing';
import { createTool } from './index';
import { normalizeMixer } from './logic';

async function activatedTool() {
  const ctx = createTestContext();
  const tool = createTool();
  await tool.activate(ctx);
  return { ctx, tool };
}

describe('soundscapes commands in a silent (audio-less) environment', () => {
  it('play without a track resumes the last mix and persists playing=true', async () => {
    const { ctx } = await activatedTool();

    const result = await ctx.commands.execute('soundscapes.play', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('playing')).toBe(true);
    const state = normalizeMixer(await ctx.settings.get('mixer'));
    expect(state.playing).toBe(true);
    expect(state.tracks.rain.enabled).toBe(true); // default mix
  });

  it('play with a track solos that track', async () => {
    const { ctx } = await activatedTool();

    const result = await ctx.commands.execute('soundscapes.play', { track: 'brown-noise' });

    expect(result.ok).toBe(true);
    const state = normalizeMixer(await ctx.settings.get('mixer'));
    expect(state.playing).toBe(true);
    expect(state.tracks['brown-noise'].enabled).toBe(true);
    expect(state.tracks.rain.enabled).toBe(false);
  });

  it('rejects unknown tracks via the zod schema', async () => {
    const { ctx } = await activatedTool();
    const result = await ctx.commands.execute('soundscapes.play', { track: 'techno' });
    expect(result.ok).toBe(false);
  });

  it('stop persists playing=false but keeps the mix', async () => {
    const { ctx } = await activatedTool();
    await ctx.commands.execute('soundscapes.play', { track: 'stream' });

    const result = await ctx.commands.execute('soundscapes.stop', {});

    expect(result.ok).toBe(true);
    expect(result.messageKey?.endsWith('stopped')).toBe(true);
    const state = normalizeMixer(await ctx.settings.get('mixer'));
    expect(state.playing).toBe(false);
    expect(state.tracks.stream.enabled).toBe(true); // mix survives for next play
  });

  it('context reports the current mix', async () => {
    const { ctx } = await activatedTool();
    await ctx.commands.execute('soundscapes.play', { track: 'rain' });

    const result = await ctx.commands.execute('soundscapes.context', {});

    expect(result.ok).toBe(true);
    const text = (result.data as { contextText: string }).contextText;
    expect(text).toContain('Rain');
    expect(text).toContain('playing');
  });

  it('pomodoro coupling: work phase plays, break stops (opt-in only)', async () => {
    const { ctx } = await activatedTool();
    const tick = () => new Promise((r) => setTimeout(r, 0));

    // Without the opt-in nothing happens.
    ctx.events.emit('pomodoro:phase-started', { phase: 'work', at: 'x' });
    await tick();
    expect(normalizeMixer(await ctx.settings.get('mixer')).playing).toBe(false);

    await ctx.settings.set('autoWithPomodoro', true);
    ctx.events.emit('pomodoro:phase-started', { phase: 'work', at: 'x' });
    await tick();
    expect(normalizeMixer(await ctx.settings.get('mixer')).playing).toBe(true);

    // Work phase over → break → silence.
    ctx.events.emit('pomodoro:finished', { phase: 'work', at: 'x' });
    await tick();
    expect(normalizeMixer(await ctx.settings.get('mixer')).playing).toBe(false);

    // A started break phase also keeps it silent.
    ctx.events.emit('pomodoro:phase-started', { phase: 'short-break', at: 'x' });
    await tick();
    expect(normalizeMixer(await ctx.settings.get('mixer')).playing).toBe(false);
  });

  it('deactivate unsubscribes the pomodoro coupling', async () => {
    const { ctx, tool } = await activatedTool();
    await ctx.settings.set('autoWithPomodoro', true);
    await tool.deactivate();

    ctx.events.emit('pomodoro:phase-started', { phase: 'work', at: 'x' });
    await new Promise((r) => setTimeout(r, 0));

    expect(normalizeMixer(await ctx.settings.get('mixer')).playing).toBe(false);
  });
});
