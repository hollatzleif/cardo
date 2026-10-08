/**
 * Node-only transport over a real folder of `.cardo-ops` files, in the exact
 * sync_folder.rs layout (`<root>/ops/…`, write-then-rename). Used for
 * interop fixtures with the Rust implementation.
 */
import { mkdirSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { batchFileName, encodeBatchFile, pullBatchFiles } from '../batchFile';
import type { EncryptedOp, PullBatch, SyncTransport } from '../types';

export class FolderHub implements SyncTransport {
  readonly opsDir: string;

  constructor(root: string) {
    this.opsDir = join(root, 'ops');
    mkdirSync(this.opsDir, { recursive: true });
  }

  async push(ops: EncryptedOp[]): Promise<void> {
    if (ops.length === 0) return;
    const name = batchFileName();
    const tmp = join(this.opsDir, `.${name}.tmp`);
    await writeFile(tmp, encodeBatchFile(ops));
    await rename(tmp, join(this.opsDir, name));
  }

  async pull(since: string): Promise<PullBatch> {
    const names = await readdir(this.opsDir);
    return pullBatchFiles(names, since, (name) => readFile(join(this.opsDir, name), 'utf8'));
  }
}
