/*
 * The Markdown renderer moved to @cardo/ui so other tools (e.g. scratchpad)
 * can share it. This shim keeps the notes-internal import path and its
 * existing tests stable.
 */
export { escapeHtml, renderInline, renderMarkdown } from '@cardo/ui';
