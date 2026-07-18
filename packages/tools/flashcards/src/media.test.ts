import { describe, it, expect } from 'vitest';
import {
  base64Size,
  dataUrl,
  extensionOf,
  formatBytes,
  isMediaName,
  makeMediaDoc,
  mediaReferences,
  mimeFromName,
  resolveMedia,
  totalMediaBytes,
} from './media';

describe('names & mime', () => {
  it('derives extension and mime', () => {
    expect(extensionOf('cat.JPG')).toBe('jpg');
    expect(mimeFromName('cat.jpg')).toBe('image/jpeg');
    expect(mimeFromName('hi.mp3')).toBe('audio/mpeg');
    expect(mimeFromName('clip.webm')).toBe('video/webm');
    expect(mimeFromName('what.xyz')).toBe('application/octet-stream');
  });

  it('rejects unsafe or non-media names', () => {
    expect(isMediaName('cat.jpg')).toBe(true);
    expect(isMediaName('../cat.jpg')).toBe(false);
    expect(isMediaName('sub/cat.jpg')).toBe(false);
    expect(isMediaName('sub\\cat.jpg')).toBe(false);
    expect(isMediaName('notes.txt')).toBe(false); // not a media extension
    expect(isMediaName('')).toBe(false);
  });
});

describe('base64 size', () => {
  it('computes decoded bytes including padding', () => {
    // "hi" → "aGk=" (2 bytes), "hello" → "aGVsbG8=" (5 bytes)
    expect(base64Size('aGk=')).toBe(2);
    expect(base64Size('aGVsbG8=')).toBe(5);
    expect(base64Size('')).toBe(0);
  });
});

describe('makeMediaDoc', () => {
  it('builds a doc with id/mime/size', () => {
    const doc = makeMediaDoc('cat.png', 'aGVsbG8=');
    expect(doc.id).toBe('media:cat.png');
    expect(doc.mime).toBe('image/png');
    expect(doc.size).toBe(5);
    expect(doc.type).toBe('media');
  });

  it('refuses unsafe names', () => {
    expect(() => makeMediaDoc('../evil.png', 'AA==')).toThrow();
  });

  it('dataUrl wraps mime + base64', () => {
    expect(dataUrl({ mime: 'image/png', data: 'AAAA' })).toBe('data:image/png;base64,AAAA');
  });
});

describe('size helpers', () => {
  it('sums and formats', () => {
    expect(totalMediaBytes([{ size: 100 }, { size: 2000 }])).toBe(2100);
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('media references', () => {
  it('finds img src and [sound:…] references, ignoring non-media', () => {
    const html = '<img src="cat.jpg"> and <img src="http://x/y.png"> [sound:hi.mp3] [sound:x.txt]';
    expect(mediaReferences(html).sort()).toEqual(['cat.jpg', 'hi.mp3'].sort());
  });
});

describe('resolveMedia', () => {
  it('rewrites src to data URLs and [sound:…] to <audio>', () => {
    const map = new Map([
      ['cat.jpg', 'data:image/jpeg;base64,AAA'],
      ['hi.mp3', 'data:audio/mpeg;base64,BBB'],
    ]);
    const out = resolveMedia('<img src="cat.jpg"> [sound:hi.mp3]', map);
    expect(out).toContain('src="data:image/jpeg;base64,AAA"');
    expect(out).toContain('<audio controls src="data:audio/mpeg;base64,BBB">');
    expect(out).not.toContain('[sound:hi.mp3]');
  });

  it('leaves unknown references untouched', () => {
    const out = resolveMedia('<img src="missing.jpg"> [sound:gone.mp3]', new Map());
    expect(out).toContain('src="missing.jpg"');
    expect(out).toContain('[sound:gone.mp3]');
  });

  it('does not confuse similar names', () => {
    const map = new Map([['a.png', 'data:image/png;base64,X']]);
    const out = resolveMedia('<img src="a.png"><img src="ba.png">', map);
    expect(out).toContain('src="data:image/png;base64,X"');
    expect(out).toContain('src="ba.png"'); // untouched
  });
});
