import katex from 'katex';

/**
 * Common LaTeX text-mode commands KaTeX does not implement, mapped to a
 * supported equivalent. Without these, decks/notes that use e.g. `\textbullet`
 * render a red error box instead of the symbol. Extend as real cards need it.
 */
const MACROS: Record<string, string> = {
  '\\textbullet': '\\bullet',
  '\\textperiodcentered': '\\cdot',
  '\\textdegree': '^{\\circ}',
  '\\textpm': '\\pm',
  '\\texttimes': '\\times',
  '\\textdiv': '\\div',
  '\\textasciitilde': '\\sim',
  '\\textasciicircum': '\\wedge',
  '\\textbackslash': '\\backslash',
  '\\textendash': '\\text{–}',
  '\\textemdash': '\\text{—}',
  '\\textrightarrow': '\\rightarrow',
  '\\textleftarrow': '\\leftarrow',
};

/**
 * Renders a LaTeX snippet to a safe HTML string via KaTeX.
 *
 * `trust: false` (KaTeX default) blocks \href/\url and other command
 * injection, so the returned markup is safe to inject with
 * dangerouslySetInnerHTML. On a syntax error we fall back to the raw source
 * shown in the error color instead of throwing, so a single bad formula never
 * breaks the whole note. The consuming app must load `katex/dist/katex.min.css`
 * once for the output to be styled (fonts are bundled same-origin).
 */
export function renderMathHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: false,
      output: 'htmlAndMathml',
      macros: MACROS,
    });
  } catch {
    // renderToString with throwOnError:false almost never throws, but guard
    // anyway: show the source verbatim rather than crash the renderer.
    const escaped = tex
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<code class="katex-error">${escaped}</code>`;
  }
}
