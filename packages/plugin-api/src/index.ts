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
  /**
   * i18n key of a one-line usage description for the AI assistant's command
   * catalog (what the command does, when to use it). Optional but strongly
   * recommended for every palette/assistant-visible command.
   */
  descriptionKey?: string;
  /** Zod schema of the parameters. Exportable as JSON Schema → future AI function-calling. */
  params: z.ZodType<P>;
  run(params: P): Promise<CommandResult>;
  /** Show in the command palette (default true). */
  palette?: boolean;
  /**
   * Expose in the AI assistant's command catalog. Defaults to the palette
   * visibility – set explicitly to decouple the two (e.g. a palette-hidden
   * command the assistant may still propose, or vice versa).
   */
  assistant?: boolean;
  icon?: string;
  /** Example parameters for the diagnostics run against the scratch database. */
  selfTestParams?: P;
  /**
   * Conscious opt-out from self-test coverage, with a one-line reason. Use ONLY
   * when a command genuinely cannot run against the scratch database (it must
   * hit the network, start real audio, open a native dialog, …). The coverage
   * gate accepts a command that has EITHER selfTestParams OR this flag – so a
   * missing self-test is always a deliberate, reviewable choice, never a silent
   * gap.
   */
  selfTestExempt?: string;
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
  /** Lists browsable files (text/image/pdf/html) with a kind hint. */
  browse(): Promise<FileBrowseEntry[]>;
  /** Reads an image file as a base64 data: URL for in-app preview. */
  readDataUrl(name: string): Promise<string>;
  /** Opens a file (e.g. PDF/HTML) in the OS default application. */
  openExternal(name: string): Promise<void>;
}

export type FileKind = 'text' | 'image' | 'pdf' | 'html';

export interface FileBrowseEntry {
  name: string;
  kind: FileKind;
  modifiedMs: number;
  size: number;
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

/* ── Legal sources (paragraphs tool) ───────────────────────────────────── */

export interface LegalSourceInfo {
  id: string;
  name: string;
  jurisdiction: string;
  /** Needs a user-supplied API key before it can fetch (e.g. FR / PISTE). */
  requiresKey: boolean;
  /** Hosts this source is allowed to contact. */
  hosts: string[];
}
export interface LegalBook {
  id: string;
  name: string;
}
export interface LegalNorm {
  id: string;
  label: string;
}
export interface FetchedNorm {
  text: string;
  /** Date the text is current as of (yyyy-mm-dd, or empty). */
  stand: string;
  sourceUrl: string;
}

/**
 * Read-only access to official legal sources (the paragraphs tool). Backed by
 * the host's allow-listed, Rust-side adapters – tools never fetch legal sites
 * themselves. Undefined outside the Tauri host (browser dev / diagnose
 * scratch), so the tool must degrade to its offline path.
 */
export interface LegalApi {
  sources(): Promise<LegalSourceInfo[]>;
  listBooks(sourceId: string): Promise<LegalBook[]>;
  listNorms(sourceId: string, book: string): Promise<LegalNorm[]>;
  fetchNorm(sourceId: string, book: string, norm: string, section: string): Promise<FetchedNorm>;
  pisteKeyPresent(): Promise<boolean>;
  setPisteKey(clientId: string, clientSecret: string): Promise<void>;
  clearPisteKey(): Promise<void>;
}

/* ── Anki import/export (flashcards tool) ──────────────────────────────── */

export interface AnkiTemplateData {
  name: string;
  qfmt: string;
  afmt: string;
}
export interface AnkiNoteTypeData {
  id: string;
  name: string;
  fields: string[];
  templates: AnkiTemplateData[];
  css: string;
  cloze: boolean;
}
export interface AnkiCardData {
  id: string;
  noteId: string;
  ord: number;
  deckId: string;
  phase: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
}
export interface AnkiCollection {
  noteTypes: AnkiNoteTypeData[];
  decks: Array<{ id: string; name: string }>;
  notes: Array<{ id: string; noteTypeId: string; fields: string[]; tags: string[] }>;
  cards: AnkiCardData[];
  media: Array<{ name: string; dataBase64: string }>;
}

/**
 * Native Anki `.apkg`/`.colpkg` import & export (flashcards tool). Opens the OS
 * file dialog and parses/writes via the host's Rust adapter. Undefined outside
 * the Tauri host (browser dev / diagnose scratch).
 */
export interface AnkiApi {
  /** Pick an .apkg/.colpkg file and parse it; null if the user cancelled. */
  importFile(): Promise<AnkiCollection | null>;
  /** Pick a save path and write the collection as .apkg; false if cancelled. */
  exportFile(collection: AnkiCollection): Promise<boolean>;
}

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
  /** Official legal sources (paragraphs tool); undefined outside the host. */
  legal?: LegalApi;
  /** Anki .apkg import/export (flashcards tool); undefined outside the host. */
  anki?: AnkiApi;
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
