import type { ComponentType } from 'react';
import type { z } from 'zod';
import type { ToolManifest } from './manifest';

export * from './manifest';

/* ── Storage ──────────────────────────────────────────────────────────── */

export type FieldFilter = {
  field: string;
  op: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'in';
  value: unknown;
};

export type StorageQuery = {
  where?: FieldFilter[];
  orderBy?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
};

export type ChangeEvent = {
  namespace: string;
  docId: string;
  operation: 'create' | 'update' | 'delete';
};

/**
 * Namespaced storage handed to a tool by the host.
 * The namespace is fixed by the host – a tool can never address foreign data.
 * Every write is additionally recorded in the change log (sync/team foundation).
 */
export interface ToolStorage {
  get<T>(id: string): Promise<T | null>;
  set<T extends Record<string, unknown>>(id: string, value: T): Promise<void>;
  delete(id: string): Promise<void>;
  query<T>(q?: StorageQuery): Promise<T[]>;
  subscribe(cb: (change: ChangeEvent) => void): () => void;
}

/* ── Events ───────────────────────────────────────────────────────────── */

/** Typed cross-tool events. Extended by tools via declaration merging. */
export interface CardoEvents {
  'core:theme-changed': { themeId: string };
  'core:language-changed': { language: string };
  'core:edit-mode-changed': { editing: boolean };
  [key: `${string}:${string}`]: Record<string, unknown>;
}

export interface EventBus {
  emit<K extends keyof CardoEvents & string>(event: K, payload: CardoEvents[K]): void;
  on<K extends keyof CardoEvents & string>(
    event: K,
    cb: (payload: CardoEvents[K]) => void,
  ): () => void;
}

/* ── Commands ─────────────────────────────────────────────────────────── */

export type CommandResult = {
  ok: boolean;
  /** i18n key of a user-facing message (toast) */
  messageKey?: string;
  data?: unknown;
};

export interface CommandSpec<P = unknown> {
  /** "<toolId>.<action>", e.g. "todo.create" */
  id: string;
  titleKey: string;
  /** Zod schema of the parameters. Exportable as JSON Schema → future AI function-calling. */
  params: z.ZodType<P>;
  run(params: P): Promise<CommandResult>;
  /** Show in the command palette (default true). */
  palette?: boolean;
  icon?: string;
  /** Example parameters for the diagnostics run against the scratch database. */
  selfTestParams?: P;
}

/* ── Services exposed to tools ────────────────────────────────────────── */

export interface NotificationsApi {
  notify(opts: { titleKey: string; bodyKey?: string; vars?: Record<string, unknown> }): Promise<void>;
}

export interface SchedulerApi {
  /** Fire a command at a specific time. Persisted – survives restarts. Returns schedule id. */
  scheduleAt(when: Date, commandId: string, params: unknown): Promise<string>;
  cancel(scheduleId: string): Promise<void>;
  list(): Promise<Array<{ id: string; when: string; commandId: string }>>;
}

export interface SettingsApi {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  subscribe(cb: () => void): () => void;
}

export interface I18nApi {
  t(key: string, vars?: Record<string, unknown>): string;
  language: string;
}

/** Tools receive colors ONLY as semantic tokens. */
export interface ThemeTokensApi {
  /** Returns a CSS var reference like "var(--accent)" – never a raw color. */
  token(
    name:
      | 'bg-canvas'
      | 'bg-widget'
      | 'bg-widget-hover'
      | 'text-primary'
      | 'text-muted'
      | 'border-subtle'
      | 'accent'
      | 'accent-text'
      | 'success'
      | 'warning'
      | 'danger'
      | 'info'
      | `chart-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`,
  ): string;
}

/**
 * Markdown-file access for tools with the "file-read"/"file-write"
 * permission (e.g. notes). Files are addressed by NAME only – the host
 * resolves them inside one user-chosen folder; tools never see paths
 * outside it. Undefined when the host provides no file backend
 * (e.g. the diagnose scratch context).
 */
export interface FilesApi {
  /** Opens the OS folder picker. Returns the chosen folder path or null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** Currently configured folder (display only), or null. */
  getFolder(): Promise<string | null>;
  /** Ensures a zero-setup default folder exists and returns its path. */
  ensureDefaultFolder(): Promise<string>;
  setFolder(path: string): Promise<string>;
  list(): Promise<Array<{ name: string; modifiedMs: number; size: number }>>;
  read(name: string): Promise<string>;
  write(name: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Reveals the folder in the OS file manager (Finder/Explorer/…). */
  reveal(): Promise<void>;
}

/* ── Cross-tool search ─────────────────────────────────────────────────── */

/** One hit in the global search (command palette). */
export interface SearchResult {
  title: string;
  subtitle?: string;
  /** Icon hint, e.g. "✓" for a todo. */
  icon?: string;
  /** Invoked when the user picks the result. */
  action(): void | Promise<void>;
}

export type SearchProvider = (query: string) => Promise<SearchResult[]>;

export interface ToolContext {
  storage: ToolStorage;
  events: EventBus;
  commands: {
    register<P>(spec: CommandSpec<P>): void;
    /**
     * Execute ANY registered command – the sanctioned path for tool-to-tool
     * automation (same interface the palette, shortcuts and the future AI
     * assistant use). Unknown command ids reject.
     */
    execute(id: string, params: unknown): Promise<CommandResult>;
    /** Whether a command is currently registered (guard for optional tools). */
    has(id: string): boolean;
  };
  /** Contribute results to the global search (Cmd/Ctrl+K). */
  search: { register(provider: SearchProvider): void };
  settings: SettingsApi;
  notifications: NotificationsApi;
  scheduler: SchedulerApi;
  i18n: I18nApi;
  theme: ThemeTokensApi;
  files?: FilesApi;
}

/* ── Self-tests ───────────────────────────────────────────────────────── */

export type SelfTestResult =
  | { status: 'pass'; detail?: string }
  | { status: 'warn'; detail: string }
  | { status: 'fail'; detail: string };

/** Context for self-tests: same shape as ToolContext but backed by the scratch DB. */
export type SelfTestContext = ToolContext;

/* ── The tool itself ──────────────────────────────────────────────────── */

export interface WidgetProps {
  instanceId: string;
  widgetId: string;
  variant?: string;
  size: { w: number; h: number };
  editing: boolean;
}

export interface CardoTool {
  manifest: ToolManifest;
  activate(ctx: ToolContext): Promise<void> | void;
  deactivate(): Promise<void> | void;
  Widget: ComponentType<WidgetProps>;
  SettingsPanel?: ComponentType;
  runSelfTest(testId: string, ctx: SelfTestContext): Promise<SelfTestResult>;
}
