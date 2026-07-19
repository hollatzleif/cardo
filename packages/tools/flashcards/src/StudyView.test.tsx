// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { basicNoteType, makeNote, makeCard, type CardDoc, type NoteDoc, type NoteTypeDoc } from './model';
import { StudyView } from './StudyView';

let container: HTMLElement;
let root: Root;

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

async function click(el: Element | null): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function fixture(): { noteType: NoteTypeDoc; note: NoteDoc; card: CardDoc } {
  const noteType = basicNoteType();
  const note = makeNote(noteType.id, { Vorderseite: 'hola', Rückseite: 'hallo' });
  const card = makeCard({ noteId: note.id, templateIndex: 0, deckId: 'd1' }, '2026-07-17');
  return { noteType, note, card };
}

const counts = { new: 1, learning: 0, review: 0 };

describe('StudyView', () => {
  it('shows the front, reveals the back, and rates via a button', async () => {
    const { noteType, note, card } = fixture();
    const onRate = vi.fn();
    await render(
      <StudyView
        card={card}
        noteType={noteType}
        note={note}
        counts={counts}
        answered={0}
        canUndo={false}
        onRate={onRate}
        onUndo={() => {}}
      />,
    );

    expect(container.querySelector('.flashcards-study__side')!.textContent).toContain('hola');
    expect(container.querySelector('.flashcards-study__answers')).toBeNull();

    await click(container.querySelector('.flashcards-study__show'));
    expect(container.querySelector('.flashcards-study__side')!.textContent).toContain('hallo');
    expect(container.querySelector('.flashcards-study__answers')).not.toBeNull();

    await click(container.querySelector('.flashcards-study__answer--good'));
    expect(onRate).toHaveBeenCalledWith('good');
  });

  it('keyboard: space reveals then space answers Good', async () => {
    const { noteType, note, card } = fixture();
    const onRate = vi.fn();
    await render(
      <StudyView
        card={card}
        noteType={noteType}
        note={note}
        counts={counts}
        answered={0}
        canUndo={false}
        onRate={onRate}
        onUndo={() => {}}
      />,
    );

    // Keys are scoped to the widget: dispatch on the (focusable) study
    // container, not window, so a keypress in another widget can't reach it.
    const studyEl = () => container.querySelector('.flashcards-study')!;
    await act(async () => {
      studyEl().dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(container.querySelector('.flashcards-study__answers')).not.toBeNull();

    await act(async () => {
      studyEl().dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onRate).toHaveBeenCalledWith('good');
  });

  it('shows the finished message and an undo button when the queue is empty', async () => {
    const onUndo = vi.fn();
    await render(
      <StudyView
        card={null}
        noteType={null}
        note={null}
        counts={{ new: 0, learning: 0, review: 0 }}
        answered={5}
        canUndo
        onRate={() => {}}
        onUndo={onUndo}
        finished
      />,
    );
    expect(container.querySelector('.flashcards-study__empty')!.textContent).toContain('Fertig');
    await click(container.querySelector('.flashcards-study__undo'));
    expect(onUndo).toHaveBeenCalled();
  });
});
