import { describe, expect, it } from 'vitest';
import { appendLine, buildScratchpadContext, countLines, firstLines } from './logic';

describe('appendLine', () => {
  it('returns the text alone for empty content', () => {
    expect(appendLine('', 'hello')).toBe('hello');
  });

  it('separates with exactly one newline when content has no trailing newline', () => {
    expect(appendLine('a', 'b')).toBe('a\nb');
  });

  it('does not double the newline when content ends with one', () => {
    expect(appendLine('a\n', 'b')).toBe('a\nb');
  });

  it('keeps additional trailing blank lines the user typed', () => {
    expect(appendLine('a\n\n', 'b')).toBe('a\n\nb');
  });

  it('appends multiline text verbatim', () => {
    expect(appendLine('a', 'b\nc')).toBe('a\nb\nc');
  });

  it('appends an empty line when text is empty', () => {
    expect(appendLine('a', '')).toBe('a\n');
    expect(appendLine('', '')).toBe('');
  });
});

describe('firstLines', () => {
  it('returns the first n lines', () => {
    expect(firstLines('a\nb\nc\nd', 2)).toBe('a\nb');
  });

  it('returns everything when the content is shorter', () => {
    expect(firstLines('a\nb', 10)).toBe('a\nb');
  });

  it('handles empty content and non-positive n', () => {
    expect(firstLines('', 5)).toBe('');
    expect(firstLines('a\nb', 0)).toBe('');
    expect(firstLines('a\nb', -1)).toBe('');
  });

  it('keeps empty lines inside the head', () => {
    expect(firstLines('a\n\nb\nc', 3)).toBe('a\n\nb');
  });
});

describe('countLines', () => {
  it('counts lines without letting a trailing newline add one', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
  });
});

describe('buildScratchpadContext', () => {
  it('reports an empty pad in both languages', () => {
    expect(buildScratchpadContext('', 'en')).toBe('The scratchpad is empty.');
    expect(buildScratchpadContext('   \n  ', 'de')).toBe('Der Schmierzettel ist leer.');
  });

  it('summarizes size and shows the first lines', () => {
    const text = buildScratchpadContext('one\ntwo', 'en');
    expect(text).toBe('Scratchpad (2 lines, 7 characters). First lines:\none\ntwo');
  });

  it('uses singular forms for one line', () => {
    expect(buildScratchpadContext('x', 'en')).toContain('(1 line, 1 characters)');
    expect(buildScratchpadContext('x', 'de')).toContain('(1 Zeile, 1 Zeichen)');
  });

  it('caps the preview at 10 lines', () => {
    const content = Array.from({ length: 14 }, (_, i) => `line${i}`).join('\n');
    const text = buildScratchpadContext(content, 'en');
    expect(text).toContain('line9');
    expect(text).not.toContain('line10');
    expect(text).toContain('14 lines');
  });
});
