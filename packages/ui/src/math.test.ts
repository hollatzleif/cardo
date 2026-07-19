import { describe, expect, it } from 'vitest';
import { renderMathHtml } from './math';

describe('renderMathHtml', () => {
  it('renders a formula to KaTeX markup', () => {
    const html = renderMathHtml('\\frac{1}{3}', true);
    expect(html).toContain('katex');
    // Display mode wraps the output in the katex-display block.
    expect(html).toContain('katex-display');
  });

  it('inline mode is not display mode', () => {
    const html = renderMathHtml('x^2', false);
    expect(html).toContain('katex');
    expect(html).not.toContain('katex-display');
  });

  it('does not throw on invalid LaTeX (throwOnError:false)', () => {
    expect(() => renderMathHtml('\\frac{', false)).not.toThrow();
  });

  it('renders text-mode commands KaTeX lacks via macros (\\textbullet)', () => {
    const html = renderMathHtml('\\textbullet', false);
    expect(html).toContain('katex');
    // Must resolve to the bullet glyph, not fall through to the red error box.
    // (KaTeX always echoes the source in a MathML <annotation>, so we check the
    // rendered glyph, not the absence of the command name.)
    expect(html).not.toContain('katex-error');
    expect(html).toContain('∙');
  });
});
