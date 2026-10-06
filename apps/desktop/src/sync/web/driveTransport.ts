import {
  batchFileName,
  encodeBatchFile,
  isBatchFileName,
  parseCursor,
  pullBatchFiles,
  selectDue,
  type EncryptedOp,
  type PullBatch,
  type SyncTransport,
} from '@cardo/sync';
import { fetchWithTimeout } from '../../host/net';

/**
 * Google Drive transport for the web app – the same hub as the desktop's
 * sync_gdrive.rs: encrypted batch files in the hidden appDataFolder, same
 * names, same JSON, same look-back cursor (@cardo/sync lookback.ts).
 * One instance = one sync round: the hub is listed once and the listing is
 * reused for every pull call of the round (a join reads hundreds of files).
 */

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
// Generous: a phone on mobile data may need a while for one big batch file
// (flashcard media travel as documents). Each attempt gets the full time.
const LIST_TIMEOUT_MS = 60_000;
const FILE_TIMEOUT_MS = 180_000;
/** Attempts per request for timeouts, network errors, 429 and 5xx. */
const ATTEMPTS = 4;
const BACKOFF_MS = [1_000, 4_000, 12_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raised when Google needs the user to sign in again (401 / no token). */
export class NeedsGoogleAuth extends Error {
  constructor() {
    super('google sign-in needed');
    this.name = 'NeedsGoogleAuth';
  }
}

export class DriveError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

export interface DriveAuth {
  /** A valid access token, or throws NeedsGoogleAuth. */
  token(): Promise<string>;
  /** The token was rejected (401): drop it. */
  invalidate(): void;
}

export interface DriveProgress {
  filesRead: number;
  filesTotal: number;
}

export class DriveTransport implements SyncTransport {
  private listing: Map<string, string> | null = null;
  private filesTotal = 0;
  private filesRead = 0;

  constructor(
    private readonly auth: DriveAuth,
    private readonly onProgress?: (p: DriveProgress) => void,
  ) {}

  /**
   * One Drive call, retried on transient trouble (timeout, network, 429,
   * 5xx). `read` consumes the body INSIDE the attempt, so a download that
   * times out halfway is retried as a whole. Re-sent uploads are harmless:
   * receivers skip ops whose id they already know.
   */
  private async call<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    read: (r: Response) => Promise<T>,
  ): Promise<T> {
    let lastError: Error = new DriveError('Drive request failed');
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 12_000);
      const token = await this.auth.token();
      try {
        const response = await fetchWithTimeout(
          url,
          {
            ...init,
            headers: {
              ...(init.headers as Record<string, string>),
              Authorization: `Bearer ${token}`,
            },
          },
          timeoutMs,
        );
        if (response.status === 401) {
          this.auth.invalidate();
          throw new NeedsGoogleAuth();
        }
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get('Retry-After'));
          if (Number.isFinite(retryAfter) && retryAfter > 0)
            await sleep(Math.min(retryAfter, 60) * 1000);
          lastError = new DriveError(
            `Drive request failed: HTTP ${response.status}`,
            response.status,
          );
          continue;
        }
        if (!response.ok) {
          throw new DriveError(`Drive request failed: HTTP ${response.status}`, response.status);
        }
        return await read(response);
      } catch (e) {
        if (e instanceof NeedsGoogleAuth || (e instanceof DriveError && e.status !== undefined))
          throw e;
        // Timeout / network drop (also while reading the body): retry.
        lastError = new DriveError(`Drive unreachable: ${(e as Error).message}`);
      }
    }
    throw lastError;
  }

  /** Every batch file name → id in the app data folder. */
  async listBatchFiles(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        fields: 'nextPageToken,files(id,name)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const body = (await this.call(`${FILES_URL}?${params}`, {}, LIST_TIMEOUT_MS, (r) =>
        r.json(),
      )) as {
        files?: Array<{ id?: string; name?: string }>;
        nextPageToken?: string;
      };
      for (const f of body.files ?? []) {
        if (f.id && f.name && isBatchFileName(f.name)) files.set(f.name, f.id);
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }

  async push(ops: EncryptedOp[]): Promise<void> {
    if (ops.length === 0) return;
    // Our own upload changes the hub; a later pull this round must re-list.
    this.listing = null;
    const boundary = 'cardo-sync-boundary';
    const metadata = JSON.stringify({ name: batchFileName(), parents: ['appDataFolder'] });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${encodeBatchFile(ops)}\r\n--${boundary}--`;
    await this.call(
      `${UPLOAD_URL}?uploadType=multipart`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
      FILE_TIMEOUT_MS,
      async () => undefined,
    );
  }

  async pull(since: string): Promise<PullBatch> {
    const now = Date.now();
    if (!this.listing) {
      this.listing = await this.listBatchFiles();
      // Progress counts the whole round, not just this batch of files.
      this.filesTotal = selectDue(
        parseCursor(since),
        [...this.listing.keys()].sort(),
        Number.MAX_SAFE_INTEGER,
        now,
      ).length;
      this.filesRead = 0;
    }
    const files = this.listing;
    const names = [...files.keys()];
    return pullBatchFiles(
      names,
      since,
      async (name) => {
        const id = files.get(name)!;
        const text = await this.call(
          `${FILES_URL}/${encodeURIComponent(id)}?alt=media`,
          {},
          FILE_TIMEOUT_MS,
          (r) => r.text(),
        );
        this.filesRead++;
        this.onProgress?.({ filesRead: this.filesRead, filesTotal: this.filesTotal });
        return text;
      },
      now,
    );
  }
}
