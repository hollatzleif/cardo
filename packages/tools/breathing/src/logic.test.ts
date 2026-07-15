import { describe, expect, it } from 'vitest';
import {
  buildBreathingContext,
  localDateKey,
  phaseAt,
  phaseLabelKey,
  phaseSequence,
  phaseTargetScale,
  phaseTone,
  sessionPlan,
} from './logic';

describe('phaseSequence', () => {
  it('box breathing is 4-4-4-4', () => {
    expect(phaseSequence('box')).toEqual([
      { key: 'inhale', seconds: 4 },
      { key: 'hold1', seconds: 4 },
      { key: 'exhale', seconds: 4 },
      { key: 'hold2', seconds: 4 },
    ]);
  });

  it('4-7-8 has no second hold', () => {
    expect(phaseSequence('478')).toEqual([
      { key: 'inhale', seconds: 4 },
      { key: 'hold1', seconds: 7 },
      { key: 'exhale', seconds: 8 },
    ]);
  });

  it('custom patterns drop zero-length phases', () => {
    expect(phaseSequence({ inhale: 5, hold1: 0, exhale: 5, hold2: 0 })).toEqual([
      { key: 'inhale', seconds: 5 },
      { key: 'exhale', seconds: 5 },
    ]);
  });

  it('an all-zero custom pattern yields an empty sequence', () => {
    expect(phaseSequence({ inhale: 0, hold1: 0, exhale: 0, hold2: 0 })).toEqual([]);
  });
});

describe('sessionPlan', () => {
  it('repeats the sequence with cumulative ms (box × 2)', () => {
    const plan = sessionPlan('box', 2);
    expect(plan.phases).toHaveLength(8);
    expect(plan.totalMs).toBe(2 * 16_000);
    expect(plan.phases[0]).toMatchObject({ key: 'inhale', cycle: 1, startMs: 0, endMs: 4000 });
    expect(plan.phases[3]).toMatchObject({ key: 'hold2', cycle: 1, startMs: 12_000, endMs: 16_000 });
    expect(plan.phases[4]).toMatchObject({ key: 'inhale', cycle: 2, startMs: 16_000, endMs: 20_000 });
    expect(plan.phases[7]?.endMs).toBe(plan.totalMs);
  });

  it('sums 4-7-8 to 19 s per cycle', () => {
    const plan = sessionPlan('478', 3);
    expect(plan.phases).toHaveLength(9);
    expect(plan.totalMs).toBe(3 * 19_000);
  });

  it('phases are contiguous (no gaps, no overlaps)', () => {
    const plan = sessionPlan('478', 2);
    for (let i = 1; i < plan.phases.length; i += 1) {
      expect(plan.phases[i]?.startMs).toBe(plan.phases[i - 1]?.endMs);
    }
  });

  it('zero or negative cycles yield an empty plan', () => {
    expect(sessionPlan('box', 0).phases).toEqual([]);
    expect(sessionPlan('box', 0).totalMs).toBe(0);
    expect(sessionPlan('box', -3).phases).toEqual([]);
  });

  it('fractional cycle counts floor', () => {
    expect(sessionPlan('box', 1.9).phases).toHaveLength(4);
  });
});

describe('phaseAt', () => {
  const plan = sessionPlan('box', 1); // 4 phases à 4000 ms

  it('start of the session is the first phase', () => {
    const active = phaseAt(plan, 0);
    expect(active?.phase.key).toBe('inhale');
    expect(active?.index).toBe(0);
    expect(active?.remainingSeconds).toBe(4);
  });

  it('boundaries are exact: endMs belongs to the NEXT phase', () => {
    expect(phaseAt(plan, 3999)?.phase.key).toBe('inhale');
    expect(phaseAt(plan, 4000)?.phase.key).toBe('hold1');
    expect(phaseAt(plan, 7999)?.phase.key).toBe('hold1');
    expect(phaseAt(plan, 8000)?.phase.key).toBe('exhale');
    expect(phaseAt(plan, 12_000)?.phase.key).toBe('hold2');
  });

  it('the exact session end (and beyond) is null', () => {
    expect(phaseAt(plan, 15_999)).not.toBeNull();
    expect(phaseAt(plan, 16_000)).toBeNull();
    expect(phaseAt(plan, 999_999)).toBeNull();
  });

  it('negative elapsed is null', () => {
    expect(phaseAt(plan, -1)).toBeNull();
  });

  it('counts remaining seconds down within a phase (ceil)', () => {
    expect(phaseAt(plan, 100)?.remainingSeconds).toBe(4);
    expect(phaseAt(plan, 3001)?.remainingSeconds).toBe(1);
  });

  it('an empty plan has no active phase', () => {
    expect(phaseAt(sessionPlan('box', 0), 0)).toBeNull();
  });
});

describe('labels, scales and tones', () => {
  it('maps every phase key to its i18n label key', () => {
    expect(phaseLabelKey('inhale')).toBe('tool.breathing.phase.inhale');
    expect(phaseLabelKey('hold1')).toBe('tool.breathing.phase.hold1');
    expect(phaseLabelKey('exhale')).toBe('tool.breathing.phase.exhale');
    expect(phaseLabelKey('hold2')).toBe('tool.breathing.phase.hold2');
  });

  it('inhale/hold1 target full scale, exhale/hold2 the resting scale', () => {
    expect(phaseTargetScale('inhale')).toBe(1);
    expect(phaseTargetScale('hold1')).toBe(1);
    expect(phaseTargetScale('exhale')).toBe(0.4);
    expect(phaseTargetScale('hold2')).toBe(0.4);
  });

  it('inhale cues 660 Hz, exhale 440 Hz, holds are silent', () => {
    expect(phaseTone('inhale')).toEqual({ freq: 660, ms: 120 });
    expect(phaseTone('exhale')).toEqual({ freq: 440, ms: 120 });
    expect(phaseTone('hold1')).toBeNull();
    expect(phaseTone('hold2')).toBeNull();
  });
});

describe('localDateKey', () => {
  it('formats with zero padding', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59, 0))).toBe('2026-01-05');
  });
});

describe('buildBreathingContext', () => {
  it('describes a running box session in English', () => {
    const text = buildBreathingContext({ pattern: 'box' }, 2, 'en');
    expect(text).toContain('Box breathing session is running');
    expect(text).toContain('2 session(s) completed today');
  });

  it('describes idle + none in German', () => {
    const text = buildBreathingContext(null, 0, 'de');
    expect(text).toBe('Gerade läuft keine Atemübung. Heute noch keine Einheit abgeschlossen.');
  });

  it('names the 4-7-8 pattern', () => {
    expect(buildBreathingContext({ pattern: '478' }, 0, 'de')).toContain('4-7-8');
  });
});
