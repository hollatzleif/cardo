/**
 * Pure, storage-free logic for the breathing tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

export type PatternId = 'box' | '478';

export type PhaseKey = 'inhale' | 'hold1' | 'exhale' | 'hold2';

export type Phase = {
  key: PhaseKey;
  seconds: number;
};

export type CustomPattern = {
  inhale: number;
  hold1: number;
  exhale: number;
  hold2: number;
};

/**
 * The phase sequence of one breathing cycle. Box breathing is 4-4-4-4,
 * 4-7-8 has no second hold. Custom patterns drop zero-length phases.
 */
export function phaseSequence(pattern: PatternId | CustomPattern): Phase[] {
  const raw: CustomPattern =
    pattern === 'box'
      ? { inhale: 4, hold1: 4, exhale: 4, hold2: 4 }
      : pattern === '478'
        ? { inhale: 4, hold1: 7, exhale: 8, hold2: 0 }
        : pattern;
  const phases: Phase[] = [
    { key: 'inhale', seconds: raw.inhale },
    { key: 'hold1', seconds: raw.hold1 },
    { key: 'exhale', seconds: raw.exhale },
    { key: 'hold2', seconds: raw.hold2 },
  ];
  return phases.filter((p) => p.seconds > 0);
}

export type PlannedPhase = Phase & {
  /** 1-based cycle number this phase belongs to. */
  cycle: number;
  /** Cumulative start of this phase in ms since session start. */
  startMs: number;
  /** Exclusive end of this phase in ms since session start. */
  endMs: number;
};

export type SessionPlan = {
  phases: PlannedPhase[];
  totalMs: number;
  cycles: number;
};

/** Flat timeline of a whole session: `cycles` repetitions of the sequence. */
export function sessionPlan(pattern: PatternId | CustomPattern, cycles: number): SessionPlan {
  const sequence = phaseSequence(pattern);
  const safeCycles = Math.max(0, Math.floor(cycles));
  const phases: PlannedPhase[] = [];
  let at = 0;
  for (let cycle = 1; cycle <= safeCycles; cycle += 1) {
    for (const phase of sequence) {
      const ms = phase.seconds * 1000;
      phases.push({ ...phase, cycle, startMs: at, endMs: at + ms });
      at += ms;
    }
  }
  return { phases, totalMs: at, cycles: safeCycles };
}

export type ActivePhase = {
  phase: PlannedPhase;
  /** Index into plan.phases. */
  index: number;
  /** Whole seconds remaining in this phase (ceil – shows "4" at phase start). */
  remainingSeconds: number;
};

/**
 * The phase active at `elapsedMs`, or null once the session is over.
 * Boundaries are exact: a phase spans [startMs, endMs), so at exactly
 * endMs the NEXT phase is active.
 */
export function phaseAt(plan: SessionPlan, elapsedMs: number): ActivePhase | null {
  if (elapsedMs < 0 || elapsedMs >= plan.totalMs) return null;
  for (let index = 0; index < plan.phases.length; index += 1) {
    const phase = plan.phases[index];
    if (phase !== undefined && elapsedMs >= phase.startMs && elapsedMs < phase.endMs) {
      return {
        phase,
        index,
        remainingSeconds: Math.ceil((phase.endMs - elapsedMs) / 1000),
      };
    }
  }
  return null;
}

/** i18n key of a phase's display label. */
export function phaseLabelKey(key: PhaseKey): string {
  return `tool.breathing.phase.${key}`;
}

/**
 * Target scale of the pacer at the END of a phase: inhale grows to 1,
 * exhale shrinks to the resting size, holds keep the previous extent.
 */
export function phaseTargetScale(key: PhaseKey): number {
  switch (key) {
    case 'inhale':
    case 'hold1':
      return 1;
    case 'exhale':
    case 'hold2':
      return 0.4;
  }
}

/** Sound cue at the START of a phase; holds are silent. */
export function phaseTone(key: PhaseKey): { freq: number; ms: number } | null {
  if (key === 'inhale') return { freq: 660, ms: 120 };
  if (key === 'exhale') return { freq: 440, ms: 120 };
  return null;
}

/** Local date as yyyy-mm-dd (stats doc key). */
export function localDateKey(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

const CONTEXT_LABEL = {
  en: {
    running: (pattern: string) => `A ${pattern} breathing session is running right now.`,
    idle: 'No breathing session is running.',
    done: (n: number) => `${n} session(s) completed today.`,
    none: 'No sessions completed today.',
  },
  de: {
    running: (pattern: string) => `Gerade läuft eine ${pattern}-Atemübung.`,
    idle: 'Gerade läuft keine Atemübung.',
    done: (n: number) => `Heute ${n} Einheit(en) abgeschlossen.`,
    none: 'Heute noch keine Einheit abgeschlossen.',
  },
} as const;

/** Compact snapshot for the assistant: running session + today's completed count. */
export function buildBreathingContext(
  session: { pattern: PatternId } | null,
  completedToday: number,
  language: string,
): string {
  const l = CONTEXT_LABEL[language === 'de' ? 'de' : 'en'];
  const state = session ? l.running(session.pattern === 'box' ? 'Box' : '4-7-8') : l.idle;
  const count = completedToday > 0 ? l.done(completedToday) : l.none;
  return `${state} ${count}`;
}
