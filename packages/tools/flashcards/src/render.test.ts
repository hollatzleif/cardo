// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  clozeOrdinals,
  renderCard,
  renderCloze,
  sanitizeHtml,
  substitute,
} from './render';

describe('field substitution', () => {
  it('substitutes fields and leaves unknown ones empty', () => {
    const out = substitute({
      template: '{{Front}} → {{Back}} {{Missing}}',
      fields: { Front: 'hola', Back: 'hallo' },
      side: 'front',
    });
    expect(out).toBe('hola → hallo ');
  });

  it('{{FrontSide}} injects the rendered front on the back', () => {
    const out = substitute({
      template: '{{FrontSide}}<hr>{{Back}}',
      fields: { Back: 'answer' },
      side: 'back',
      frontSide: 'question',
    });
    expect(out).toBe('question<hr>answer');
  });

  it('{{text:Field}} strips HTML', () => {
    const out = substitute({
      template: '{{text:Body}}',
      fields: { Body: '<b>bold</b> &amp; plain' },
      side: 'front',
    });
    expect(out).toBe('bold & plain');
  });
});

describe('conditionals', () => {
  it('shows #Field only when non-empty, ^Field only when empty', () => {
    const tpl = '{{#Extra}}has:{{Extra}}{{/Extra}}{{^Extra}}none{{/Extra}}';
    expect(substitute({ template: tpl, fields: { Extra: 'x' }, side: 'front' })).toBe('has:x');
    expect(substitute({ template: tpl, fields: { Extra: '' }, side: 'front' })).toBe('none');
  });

  it('handles nested conditionals', () => {
    const tpl = '{{#A}}A{{#B}}B{{/B}}{{/A}}';
    expect(substitute({ template: tpl, fields: { A: '1', B: '1' }, side: 'front' })).toBe('AB');
    expect(substitute({ template: tpl, fields: { A: '1', B: '' }, side: 'front' })).toBe('A');
    expect(substitute({ template: tpl, fields: { A: '', B: '1' }, side: 'front' })).toBe('');
  });
});

describe('cloze', () => {
  it('lists distinct ordinals ascending', () => {
    expect(clozeOrdinals('{{c2::b}} and {{c1::a}} and {{c1::again}}')).toEqual([1, 2]);
  });

  it('hides the active ordinal on the front, reveals it on the back', () => {
    const text = 'The {{c1::mitochondria}} is the {{c2::powerhouse}}.';
    expect(renderCloze(text, 1, 'front')).toBe('The <span class="cloze">[...]</span> is the powerhouse.');
    expect(renderCloze(text, 1, 'back')).toBe(
      'The <span class="cloze">mitochondria</span> is the powerhouse.',
    );
  });

  it('uses the hint when present', () => {
    expect(renderCloze('{{c1::Paris::capital}}', 1, 'front')).toBe(
      '<span class="cloze">[capital]</span>',
    );
  });
});

describe('sanitizer', () => {
  it('drops <script> entirely', () => {
    expect(sanitizeHtml('<b>ok</b><script>alert(1)</script>')).toBe('<b>ok</b>');
  });

  it('strips event handlers and javascript: urls', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)" onclick="x()">link</a>');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('onclick');
    expect(out).toContain('link');
  });

  it('keeps safe formatting, images and relative media src', () => {
    const out = sanitizeHtml('<img src="cat.jpg" alt="cat"><b>hi</b><hr>');
    expect(out).toContain('<img');
    expect(out).toContain('src="cat.jpg"');
    expect(out).toContain('<b>hi</b>');
  });

  it('unwraps unknown tags but keeps their text', () => {
    expect(sanitizeHtml('<marquee>scroll</marquee>')).toBe('scroll');
  });

  it('removes iframes completely', () => {
    expect(sanitizeHtml('<iframe src="https://evil"></iframe>text')).toBe('text');
  });
});

describe('renderCard end-to-end', () => {
  it('renders math via KaTeX and survives sanitizing', () => {
    const out = renderCard({
      template: 'Solve $x^2$ now',
      fields: {},
      side: 'front',
    });
    expect(out).toContain('katex');
    expect(out).toContain('Solve');
    expect(out).toContain('now');
    expect(out).not.toContain('$x^2$');
  });

  it('a full card: fields + conditional + sanitize together', () => {
    const out = renderCard({
      template: '{{Word}}{{#Note}}<div class="note">{{Note}}</div>{{/Note}}<script>x</script>',
      fields: { Word: 'Haus', Note: 'noun' },
      side: 'front',
    });
    expect(out).toContain('Haus');
    expect(out).toContain('class="note"');
    expect(out).toContain('noun');
    expect(out).not.toContain('<script>');
  });

  it('a price like "$5" is left as literal text, not math', () => {
    const out = renderCard({ template: 'costs $5 today', fields: {}, side: 'front' });
    expect(out).toContain('costs $5 today');
    expect(out).not.toContain('katex');
  });
});
