import { getHost } from '../host';
import { fetchWithTimeout } from '../host/net';
import { fetchAppInfo } from '../host/backend';
import { POLLS_WORKER_URL } from '../polls/config';

/**
 * Inbox feed (announcements + polls) from the Cardo server.
 * Transparency principle: the feed is OFF by default. Only after the user
 * explicitly enables the inbox does Cardo check the feed (on launch and
 * hourly). Voting sends poll id, option and an anonymous device hash –
 * nothing else, ever.
 */

export interface FeedItem {
  id: string;
  kind: 'poll' | 'announcement';
  open: boolean;
  createdAt: string;
  payload: {
    question?: Record<string, string>;
    options?: Array<{ id: string; label: Record<string, string> }>;
    title?: Record<string, string>;
    body?: Record<string, string>;
  };
  results?: { total: number; counts: Record<string, number> };
}

interface InboxState {
  items: FeedItem[];
  unread: number;
  enabled: boolean;
  loaded: boolean;
  error: boolean;
}

let state: InboxState = { items: [], unread: 0, enabled: false, loaded: false, error: false };
const listeners = new Set<(s: InboxState) => void>();
let pollTimer: number | null = null;

function setState(next: Partial<InboxState>): void {
  state = { ...state, ...next };
  for (const cb of listeners) cb(state);
}

export function getInboxState(): InboxState {
  return state;
}

export function onInboxChange(cb: (s: InboxState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function getSeen(): Promise<string[]> {
  const doc = (await getHost().backend.get('core.settings', 'inbox.seen')) as {
    value?: string[];
  } | null;
  return doc?.value ?? [];
}

export async function isInboxEnabled(): Promise<boolean> {
  const doc = (await getHost().backend.get('core.settings', 'inbox.enabled')) as {
    value?: boolean;
  } | null;
  return doc?.value === true;
}

export async function setInboxEnabled(enabled: boolean): Promise<void> {
  await getHost().backend.set('core.settings', 'inbox.enabled', { value: enabled });
  setState({ enabled });
  if (enabled) await refreshFeed();
  else stopPolling();
}

export async function refreshFeed(): Promise<void> {
  try {
    const response = await fetchWithTimeout(`${POLLS_WORKER_URL}/feed`);
    if (!response.ok) throw new Error(`feed http ${response.status}`);
    const res = (await response.json()) as { items: FeedItem[] };
    const seen = new Set(await getSeen());
    const items = res.items ?? [];
    setState({
      items,
      unread: items.filter((i) => !seen.has(i.id)).length,
      loaded: true,
      error: false,
    });
  } catch {
    setState({ error: true, loaded: true });
  }
}

/** Opening the inbox marks everything currently in the feed as seen. */
export async function markAllSeen(): Promise<void> {
  const ids = state.items.map((i) => i.id);
  await getHost().backend.set('core.settings', 'inbox.seen', { value: ids });
  setState({ unread: 0 });
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Called once at startup: only acts when the user opted in. */
export async function initInbox(): Promise<void> {
  const enabled = await isInboxEnabled();
  setState({ enabled });
  if (!enabled) return;
  window.setTimeout(() => void refreshFeed(), 15_000);
  pollTimer = window.setInterval(() => void refreshFeed(), 60 * 60 * 1000);
}

/* ── Voting ──────────────────────────────────────────────────────────── */

export async function deviceHash(): Promise<string> {
  const info = await fetchAppInfo();
  const bytes = new TextEncoder().encode(`cardo-poll:${info.deviceId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getVoted(): Promise<Record<string, string>> {
  const doc = (await getHost().backend.get('core.settings', 'polls.voted')) as {
    value?: Record<string, string>;
  } | null;
  return doc?.value ?? {};
}

/** Returns true when the vote was accepted (or already counted). */
export async function votePoll(pollId: string, optionId: string): Promise<boolean> {
  try {
    const device = await deviceHash();
    const res = await fetchWithTimeout(`${POLLS_WORKER_URL}/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ poll: pollId, option: optionId, device }),
    });
    if (!res.ok && res.status !== 409) return false;
    const voted = { ...(await getVoted()), [pollId]: optionId };
    await getHost().backend.set('core.settings', 'polls.voted', { value: voted });
    await refreshFeed();
    return true;
  } catch {
    return false;
  }
}
