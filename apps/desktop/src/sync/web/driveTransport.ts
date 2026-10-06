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
const LIST_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 30_000;

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

  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const token = await this.auth.token();
    let response: Response;
    try {
      response = await fetchWithTimeout(
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
    } catch (e) {
      throw new DriveError(`Drive unreachable: ${(e as Error).message}`);
    }
    if (response.status === 401) {
      this.auth.invalidate();
      throw new NeedsGoogleAuth();
    }
    if (!response.ok)
      throw new DriveError(`Drive request failed: HTTP ${response.status}`, response.status);
    return response;
  }

  /** Every batch file name → id in the app data folder. */
  async listBatchFiles(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        orderBy: 'name',
        fields: 'nextPageToken,files(id,name)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const body = (await (
        await this.request(`${FILES_URL}?${params}`, {}, LIST_TIMEOUT_MS)
      ).json()) as {
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
    await this.request(
      `${UPLOAD_URL}?uploadType=multipart`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
      FILE_TIMEOUT_MS,
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
        const response = await this.request(
          `${FILES_URL}/${encodeURIComponent(id)}?alt=media`,
          {},
          FILE_TIMEOUT_MS,
        );
        const text = await response.text();
        this.filesRead++;
        this.onProgress?.({ filesRead: this.filesRead, filesTotal: this.filesTotal });
        return text;
      },
      now,
    );
  }
}
