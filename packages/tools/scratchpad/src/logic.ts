/**
 * Pure, storage-free logic for the scratchpad tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

/**
 * Append `text` as a new line: exactly one newline separates the existing
 * content from the appended text, regardless of whether the content already
 * ends with a trailing newline. Empty content just becomes the text.
 */
export function appendLine(content: string, text: string): string {
  if (content === '') return text;
  const separator = content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}${text}`;
}

/** The first `n` lines of `content` (fewer if the content is shorter). */
export function firstLines(content: string, n: number): string {
  if (n <= 0 || content === '') return '';
  return content.split('\n').slice(0, n).join('\n');
}

/** Total line count (a trailing newline does not start a new line). */
export function countLines(content: string): number {
  if (content === '') return 0;
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed.split('\n').length;
}

/**
 * Assistant "current state" context: size summary plus the first 10 lines,
 * so the assistant knows what is already on the pad before appending.
 */
export function buildScratchpadContext(content: string, language: string): string {
  const de = language === 'de';
  if (content.trim() === '') {
    return de ? 'Der Schmierzettel ist leer.' : 'The scratchpad is empty.';
  }
  const lines = countLines(content);
  const head = firstLines(content, 10);
  const summary = de
    ? `Schmierzettel (${lines} Zeile${lines === 1 ? '' : 'n'}, ${content.length} Zeichen).`
    : `Scratchpad (${lines} line${lines === 1 ? '' : 's'}, ${content.length} characters).`;
  const heading = de ? 'Erste Zeilen' : 'First lines';
  return `${summary} ${heading}:\n${head}`;
}
