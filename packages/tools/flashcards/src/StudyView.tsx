/**
 * Study session view. Purely prop-driven (no storage/Tauri coupling) so it
 * renders in tests and is mounted with live data by the tool shell. Shows the
 * current card's front, reveals the back on demand, and offers the four Anki
 * answer buttons plus undo. Keyboard: Space reveals / answers Good, 1–4 rate,
 * u undoes.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { renderCard } from './render';
import type { CardDoc, NoteDoc, NoteTypeDoc } from './model';
import type { QueueCounts, Rating } from './session';

export interface StudyLabels {
  show: string;
  again: string;
  hard: string;
  good: string;
  easy: string;
  undo: string;
  done: string;
  empty: string;
}

export const DEFAULT_STUDY_LABELS: StudyLabels = {
  show: 'Antwort zeigen',
  again: 'Nochmal',
  hard: 'Schwer',
  good: 'Gut',
  easy: 'Leicht',
  undo: 'Rückgängig',
  done: 'Fertig für heute 🎉',
  empty: 'Keine Karten fällig',
};

export interface StudyViewProps {
  /** The current card, or null when the queue is empty/finished. */
  card: CardDoc | null;
  noteType: NoteTypeDoc | null;
  note: NoteDoc | null;
  counts: QueueCounts;
  answered: number;
  canUndo: boolean;
  onRate: (rating: Rating) => void;
  onUndo: () => void;
  labels?: Partial<StudyLabels>;
  /** Whether the empty state means "all done" (true) vs "nothing due" (false). */
  finished?: boolean;
}

function pickTemplate(noteType: NoteTypeDoc, card: CardDoc) {
  if (noteType.cloze) {
    return { template: noteType.templates[0]!, clozeOrdinal: card.templateIndex + 1 };
  }
  return {
    template: noteType.templates[card.templateIndex] ?? noteType.templates[0]!,
    clozeOrdinal: undefined,
  };
}

export function StudyView(props: StudyViewProps): JSX.Element {
  const labels = { ...DEFAULT_STUDY_LABELS, ...props.labels };
  const { card, noteType, note, onRate, onUndo, canUndo } = props;
  const [revealed, setRevealed] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef(0);

  // Reset reveal + timer whenever the card changes.
  useEffect(() => {
    setRevealed(false);
    setSeconds(0);
    startRef.current = 0;
  }, [card?.id]);

  // A 1s ticker for the elapsed-time badge (uses a counter, not Date, to stay
  // deterministic under fake timers in tests).
  useEffect(() => {
    if (!card) return undefined;
    const handle = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(handle);
    // Restart the ticker per card, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id]);

  const rendered = useMemo(() => {
    if (!card || !noteType || !note) return null;
    const { template, clozeOrdinal } = pickTemplate(noteType, card);
    const front = renderCard({
      template: template.front,
      fields: note.fields,
      side: 'front',
      clozeOrdinal,
    });
    const back = renderCard({
      template: template.back,
      fields: note.fields,
      side: 'back',
      frontSide: front,
      clozeOrdinal,
    });
    return { front, back, css: noteType.css };
  }, [card, noteType, note]);

  const rate = useCallback(
    (r: Rating) => {
      setRevealed(false);
      onRate(r);
    },
    [onRate],
  );

  // Keyboard shortcuts are scoped to THIS widget: the handler sits on the study
  // container (which is focusable), so Space/1–4/u only act when this card has
  // keyboard focus. A global window listener would fire while the user types in
  // another widget (e.g. hitting Space in a snippet editor would flip the card).
  const onKey = (e: ReactKeyboardEvent): void => {
    if (e.key === ' ') {
      e.preventDefault();
      if (!revealed) setRevealed(true);
      else rate('good');
    } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
      rate((['again', 'hard', 'good', 'easy'] as const)[Number(e.key) - 1]!);
    } else if (e.key.toLowerCase() === 'u' && canUndo) {
      onUndo();
    }
  };

  if (!card || !noteType || !note || !rendered) {
    return (
      <div
        className="flashcards-study flashcards-study--empty"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-3)', textAlign: 'center' }}
      >
        <p className="flashcards-study__empty" style={{ margin: 0, color: 'var(--text-muted)' }}>
          {props.finished ? labels.done : labels.empty}
        </p>
        {canUndo && (
          <button type="button" className="flashcards-study__undo c-btn" onClick={onUndo}>
            {labels.undo}
          </button>
        )}
      </div>
    );
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  const answerBtn = (rating: Rating, label: string, cls: string, color: string) => (
    <button
      type="button"
      className={`flashcards-study__answer ${cls} c-btn`}
      style={{ flex: 1, minWidth: 0, border: `1px solid ${color}`, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      onClick={() => rate(rating)}
    >
      {label}
    </button>
  );

  return (
    <div
      className="flashcards-study"
      tabIndex={0}
      onKeyDown={onKey}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)', outline: 'none' }}
    >
      <style>{rendered.css}</style>
      <header
        className="flashcards-study__bar"
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 13, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
      >
        <span className="flashcards-study__count flashcards-study__count--new" style={{ color: 'var(--chart-1, var(--accent))' }} title={labels.again}>
          ● {props.counts.new}
        </span>
        <span className="flashcards-study__count flashcards-study__count--learning" style={{ color: 'var(--warning)' }}>
          ● {props.counts.learning}
        </span>
        <span className="flashcards-study__count flashcards-study__count--review" style={{ color: 'var(--success)' }}>
          ● {props.counts.review}
        </span>
        <span className="flashcards-study__timer" style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>
          {`${mm}:${ss}`}
        </span>
      </header>

      <div
        className="flashcards-study__card card"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}
      >
        <div
          className="flashcards-study__side"
          style={{ width: '100%' }}
          // Content is sanitized by renderCard's allowlist sanitizer.
          dangerouslySetInnerHTML={{ __html: revealed ? rendered.back : rendered.front }}
        />
      </div>

      {!revealed ? (
        <button
          type="button"
          className="flashcards-study__show c-btn c-btn--primary"
          style={{ flexShrink: 0 }}
          onClick={() => setRevealed(true)}
        >
          {labels.show}
        </button>
      ) : (
        <div className="flashcards-study__answers" style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
          {answerBtn('again', labels.again, 'flashcards-study__answer--again', 'var(--danger)')}
          {answerBtn('hard', labels.hard, 'flashcards-study__answer--hard', 'var(--warning)')}
          {answerBtn('good', labels.good, 'flashcards-study__answer--good', 'var(--success)')}
          {answerBtn('easy', labels.easy, 'flashcards-study__answer--easy', 'var(--accent)')}
        </div>
      )}

      {canUndo && (
        <button type="button" className="flashcards-study__undo c-btn c-btn--ghost" style={{ flexShrink: 0, fontSize: 12 }} onClick={onUndo}>
          {labels.undo}
        </button>
      )}
    </div>
  );
}
