/** Pure logic for the quick-capture inbox – no React, no ToolContext. */

export type ItemDoc = {
  /** Doc id ("item:<uuid>") duplicated inside the body: query() returns bodies WITHOUT ids. */
  id: string;
  type: 'item';
  text: string;
  createdAt: string;
};

/** Storage doc the host's global shortcut pokes (via quickcapture.focus) to focus the input. */
export type UiDoc = { id: string; type: 'ui'; focusRequested: number };

export const UI_DOC_ID = 'ui';
export const ITEM_PREFIX = 'item:';

export function makeId(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${ITEM_PREFIX}${uuid}`;
}

export function makeItem(text: string, now: Date = new Date()): ItemDoc {
  return { id: makeId(), type: 'item', text: text.trim(), createdAt: now.toISOString() };
}

/** Newest first; id as tie-breaker so the order is stable. */
export function sortItems(items: ItemDoc[]): ItemDoc[] {
  return [...items].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}

export function isCapturable(text: string): boolean {
  return text.trim().length > 0;
}
