/** In-memory hub with the folder transport's file layout – for tests. */
import { batchFileName, encodeBatchFile, pullBatchFiles } from '../batchFile';
import type { EncryptedOp, PullBatch, SyncTransport } from '../types';

export class MemoryHub implements SyncTransport {
  /** Batch file name → raw file text, exactly what a cloud backend would hold. */
  readonly files = new Map<string, string>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async push(ops: EncryptedOp[]): Promise<void> {
    if (ops.length === 0) return;
    this.files.set(batchFileName(this.#now()), encodeBatchFile(ops));
  }

  async pull(since: string): Promise<PullBatch> {
    return pullBatchFiles([...this.files.keys()], since, async (name) => this.files.get(name) ?? '');
  }
}
