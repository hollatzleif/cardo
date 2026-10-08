/**
 * `files.notes` content hash – port of `content_hash()` in
 * apps/desktop/src-tauri/src/sync_files.rs: lowercase hex SHA-256 over the
 * raw UTF-8 bytes of the file content (no newline or Unicode normalization,
 * a BOM is hashed as-is). A notes doc is `{ content, hash }`.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import { toHex, utf8Encode } from './bytes';

export function notesContentHash(content: string): string {
  return toHex(sha256(utf8Encode(content)));
}
