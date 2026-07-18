/**
 * Media handling for the flashcards tool: images, audio and video referenced
 * by cards. Pure and framework-free so it unit-tests in plain node.
 *
 * Storage/sync model: media are kept as ordinary tool documents (type
 * "media", base64 payload) under the flashcards namespace, so they ride the
 * SAME end-to-end-encrypted op pipeline as everything else – no separate file
 * lane, no plaintext on any transport. The honest tradeoff (flagged in the
 * plan): large media inflate the sync, so a per-file soft cap applies and the
 * tool shows the total media size.
 */

/** Per-file soft cap. Above this the tool refuses the import and explains why. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export type MediaDoc = {
  id: string;
  type: 'media';
  /** The filename cards reference (e.g. "cat.jpg", "hello.mp3"). Unique. */
  name: string;
  mime: string;
  /** Decoded byte size. */
  size: number;
  /** base64 payload (no "data:" prefix). */
  data: string;
  createdAt: string;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function mimeFromName(name: string): string {
  return MIME_BY_EXT[extensionOf(name)] ?? 'application/octet-stream';
}

/** A safe, referenceable media name: no path parts, known media extension. */
export function isMediaName(name: string): boolean {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return extensionOf(name) in MIME_BY_EXT;
}

/** Decoded byte size of a base64 string. `len` counts data chars only (no
 *  padding/whitespace), so the decoded size is simply floor(len * 3 / 4). */
export function base64Size(b64: string): number {
  const len = b64.replace(/[^A-Za-z0-9+/]/g, '').length;
  return Math.floor((len * 3) / 4);
}

export function mediaId(name: string): string {
  return `media:${name}`;
}

export function makeMediaDoc(name: string, dataBase64: string, now: Date = new Date()): MediaDoc {
  if (!isMediaName(name)) throw new Error(`unsafe media name: ${name}`);
  return {
    id: mediaId(name),
    type: 'media',
    name,
    mime: mimeFromName(name),
    size: base64Size(dataBase64),
    data: dataBase64,
    createdAt: now.toISOString(),
  };
}

export function dataUrl(doc: Pick<MediaDoc, 'mime' | 'data'>): string {
  return `data:${doc.mime};base64,${doc.data}`;
}

export function totalMediaBytes(docs: Array<Pick<MediaDoc, 'size'>>): number {
  return docs.reduce((sum, d) => sum + d.size, 0);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ── Media references inside card HTML ────────────────────────────────────── */

const SRC_RE = /\b(?:src)\s*=\s*"([^"]+)"|\bsrc\s*=\s*'([^']+)'/gi;
const SOUND_RE = /\[sound:([^\]]+)\]/gi;

/** Every media filename a card references (via src="…" or [sound:…]). */
export function mediaReferences(html: string): string[] {
  const names = new Set<string>();
  for (const m of html.matchAll(SRC_RE)) {
    const name = (m[1] ?? m[2] ?? '').trim();
    if (isMediaName(name)) names.add(name);
  }
  for (const m of html.matchAll(SOUND_RE)) {
    const name = m[1]!.trim();
    if (isMediaName(name)) names.add(name);
  }
  return [...names];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite media references to inline data URLs so a card renders offline. Runs
 * AFTER the renderer's sanitizer (the data URLs are ours, not user input):
 *   <img src="cat.jpg">   → <img src="data:image/jpeg;base64,…">
 *   [sound:hi.mp3]        → <audio controls src="data:audio/mpeg;base64,…">
 * Unknown references are left untouched (they simply won't load).
 */
export function resolveMedia(html: string, dataUrlByName: Map<string, string>): string {
  let out = html;
  for (const [name, url] of dataUrlByName) {
    const esc = escapeRegExp(name);
    out = out.replace(new RegExp(`(src\\s*=\\s*)("|')${esc}\\2`, 'gi'), `$1$2${url}$2`);
  }
  out = out.replace(SOUND_RE, (match, name: string) => {
    const url = dataUrlByName.get(name.trim());
    return url ? `<audio controls src="${url}"></audio>` : match;
  });
  return out;
}
