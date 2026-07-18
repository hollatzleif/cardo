/**
 * Study session view. Purely prop-driven (no storage/Tauri coupling) so it
 * renders in tests and is mounted with live data by the tool shell. Shows the
 * current card's front, reveals the back on demand, and offers the four Anki
 * answer buttons plus undo. Keyboard: Space reveals / answers Good, 1–4 rate,
 * u undoes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

  // Keyboard shortcuts.
  useEffect(() => {
    if (!card) return undefined;
    const onKey = (e: KeyboardEvent): void => {
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // card?.id (identity), not the card object, drives re-binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, revealed, canUndo, rate, onUndo]);

  if (!card || !noteType || !note || !rendered) {
    return (
      <div className="flashcards-study flashcards-study--empty">
        <p className="flashcards-study__empty">{props.finished ? labels.done : labels.empty}</p>
        {canUndo && (
          <button type="button" className="flashcards-study__undo" onClick={onUndo}>
            {labels.undo}
          </button>
        )}
      </div>
    );
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <div className="flashcards-study">
      <style>{rendered.css}</style>
      <header className="flashcards-study__bar">
        <span className="flashcards-study__count flashcards-study__count--new">{props.counts.new}</span>
        <span className="flashcards-study__count flashcards-study__count--learning">
          {props.counts.learning}
        </span>
        <span className="flashcards-study__count flashcards-study__count--review">
          {props.counts.review}
        </span>
        <span className="flashcards-study__timer">{`${mm}:${ss}`}</span>
      </header>

      <div className="flashcards-study__card card">
        <div
          className="flashcards-study__side"
          // Content is sanitized by renderCard's allowlist sanitizer.
          dangerouslySetInnerHTML={{ __html: revealed ? rendered.back : rendered.front }}
        />
      </div>

      {!revealed ? (
        <button
          type="button"
          className="flashcards-study__show c-btn c-btn--primary"
          onClick={() => setRevealed(true)}
        >
          {labels.show}
        </button>
      ) : (
        <div className="flashcards-study__answers">
          <button type="button" className="flashcards-study__answer flashcards-study__answer--again" onClick={() => rate('again')}>
            {labels.again}
          </button>
          <button type="button" className="flashcards-study__answer flashcards-study__answer--hard" onClick={() => rate('hard')}>
            {labels.hard}
          </button>
          <button type="button" className="flashcards-study__answer flashcards-study__answer--good" onClick={() => rate('good')}>
            {labels.good}
          </button>
          <button type="button" className="flashcards-study__answer flashcards-study__answer--easy" onClick={() => rate('easy')}>
            {labels.easy}
          </button>
        </div>
      )}

      {canUndo && (
        <button type="button" className="flashcards-study__undo" onClick={onUndo}>
          {labels.undo}
        </button>
      )}
    </div>
  );
}
