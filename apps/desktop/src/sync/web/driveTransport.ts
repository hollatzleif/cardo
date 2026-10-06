import {
  batchFileName,
  decodeBatchFile,
  encodeBatchFile,
  isBatchFileName,
  BatchFileError,
  type EncryptedOp,
  type PullBatch,
  type SyncTransport,
} from '@cardo/sync';
import { fetchWithTimeout } from '../../host/net';
import { advance, parseCursor, renderCursor, selectNames } from './lookback';

/**
 * Google Drive transport for the web app – the same hub as the desktop's
 * sync_gdrive.rs: encrypted batch files in the hidden appDataFolder, same
 * names and JSON. Only the local cursor differs (lookback, see lookback.ts).
 */

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_PER_PULL = 50;
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
    const cursor = parseCursor(since);
    const files = await this.listBatchFiles();
    const names = [...files.keys()];
    const next = selectNames(names, cursor, FILES_PER_PULL);
    if (next.length === 0) return { ops: [], nextCursor: since };

    const unread = selectNames(names, cursor, Number.MAX_SAFE_INTEGER).length;
    const ops: EncryptedOp[] = [];
    let done = 0;
    for (const name of next) {
      const id = files.get(name)!;
      const text = await (
        await this.request(`${FILES_URL}/${encodeURIComponent(id)}?alt=media`, {}, FILE_TIMEOUT_MS)
      ).text();
      try {
        ops.push(...(decodeBatchFile(text) ?? []));
      } catch (e) {
        // A broken file must not wedge sync forever: skip it (it is marked
        // as read below) – the engine reports nothing for it.
        if (!(e instanceof BatchFileError)) throw e;
      }
      done++;
      this.onProgress?.({ filesRead: done, filesTotal: unread });
    }
    return { ops, nextCursor: renderCursor(advance(cursor, next)) };
  }
}
