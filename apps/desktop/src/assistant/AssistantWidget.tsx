import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WidgetProps } from '@cardo/plugin-api';
import { Button } from '@cardo/ui';
import { getHost } from '../host';
import * as api from './api';
import { buildCommandCatalog, isCommandInScope, type CatalogSource } from './catalog';
import {
  appendChat,
  CHAT_CONTEXT_CHAR_LIMIT,
  chatContext,
  clearChat,
  estimateContextChars,
  loadChat,
  makeChatEntry,
  subscribeChatChanges,
  updateChatEntry,
  type ChatEntry,
  type ChatProposalOutcome,
  type ChatProposalSnapshot,
} from './chats';
import { requestPaletteEdit } from './hostBridge';
import { appendMemory, forgetLines } from './memory';
import { fastestModelId, isLocalModel, modelById, type PromptTemplate } from './models';
import * as profilesModule from './profiles';
import {
  getActive,
  getProfilesState,
  initProfiles,
  onProfilesChange,
  recordProposalOutcome,
  resolveMemoryId,
  setActive,
  type AssistantProfile,
  type AssistantTeam,
  type ResolvedActive,
} from './profiles';
import { buildSystemPrompt } from './prompt';
import { buildCapabilities } from './capabilities';
import { executeProposals, parseProposals } from './proposals';
import { buildRouterPrompt, parseRouterAnswer } from './routing';
import { getAskBeforeExecute, onAssistantSettingsChange } from './store';
import './assistant-widget.css';

/**
 * Braindump widget, persistent-chat edition (v0.5.0): thoughts in, concrete
 * command proposals out – per assistant profile or team, with the full
 * conversation persisted per selection (chats.ts). Everything runs locally;
 * the model answers with a strict JSON contract that is parsed defensively
 * and executed only via the command registry, filtered by the active
 * profile's tool scope.
 *
 * Variants: 'classic' (default) is the single-chat look; 'messenger' adds a
 * chat list (one conversation per profile/team) on the left.
 */

type Setup = 'loading' | 'noProfiles' | 'noModel' | 'ready';

interface Speaker {
  name: string;
  emoji: string;
  color: string;
}

/** Persisted conversation entry, rendered from the chat store. */
interface EntryItem {
  key: string;
  kind: 'entry';
  entry: ChatEntry;
}

/** Session-only items (never persisted): routing notes, hints, questions. */
interface RouteItem {
  key: string;
  kind: 'route';
  text: string;
}

interface NoticeItem {
  key: string;
  kind: 'notice';
  text: string;
}

interface HintItem {
  key: string;
  kind: 'hint';
  text: string;
}

interface DelegationItem {
  key: string;
  kind: 'delegation';
  speaker: Speaker;
  targetId: string;
  targetName: string;
  reason: string;
  /** The original braindump – re-run verbatim when the user hands over. */
  question: string;
  status: 'pending' | 'accepted' | 'declined';
}

interface ForgetItem {
  key: string;
  kind: 'forget';
  speaker: Speaker;
  memoryId: string;
  line: string;
  status: 'pending' | 'done' | 'declined';
}

type FeedItem = EntryItem | RouteItem | NoticeItem | HintItem | DelegationItem | ForgetItem;

/** Optional contract with settings: model-derived competences per model id. */
const modelCompetencesFn = (
  profilesModule as unknown as {
    modelCompetences?: (modelId: string, language: string) => string;
  }
).modelCompetences;

const CLEAR_COMMAND = '/clearchat';
/** Grid units → approximate pixels; below this the messenger collapses. */
const GRID_UNIT_PX = 56;
const NARROW_PX = 520;

function templateFor(modelId: string): PromptTemplate {
  return modelById(modelId)?.template ?? 'chatml';
}

function speakerOf(source: { name: string; emoji: string; color: string }): Speaker {
  return { name: source.name, emoji: source.emoji, color: source.color };
}

function ownerIdOf(active: ResolvedActive): string {
  return active.kind === 'team' ? active.team.id : active.profile.id;
}

/** Model ids that must be installed before the selection is usable. */
function requiredModelIds(active: ResolvedActive, profiles: AssistantProfile[]): string[] {
  if (active.kind === 'profile') return [active.profile.modelId];
  const ids = new Set<string>();
  for (const memberId of active.team.memberIds) {
    const member = profiles.find((p) => p.id === memberId);
    if (member) ids.add(member.modelId);
  }
  return [...ids];
}

function entriesOf(items: FeedItem[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  for (const it of items) if (it.kind === 'entry') entries.push(it.entry);
  return entries;
}

/** One-line preview of an entry for the messenger chat list. */
function snippetOf(entry: ChatEntry): string {
  if (entry.text.trim() !== '') return entry.text;
  const first = entry.proposals?.[0];
  if (first) return first.summary;
  return entry.memory?.[0] ?? '';
}

export function AssistantWidget(props: WidgetProps) {
  const { t, i18n } = useTranslation();
  const [setup, setSetup] = useState<Setup>('loading');
  const [profiles, setProfiles] = useState<AssistantProfile[]>([]);
  const [teams, setTeams] = useState<AssistantTeam[]>([]);
  const [selection, setSelection] = useState<ResolvedActive | null>(null);
  const [installedIds, setInstalledIds] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  /** Ephemeral per-proposal result messages, keyed `${entryId}:${index}`. */
  const [resultMsgs, setResultMsgs] = useState<Record<string, string>>({});
  const [lastByOwner, setLastByOwner] = useState<Record<string, { text: string; at: string }>>({});
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('chat');
  const [claudeInstalled, setClaudeInstalled] = useState(false);
  const [proposalsCollapsed, setProposalsCollapsed] = useState(false);
  const nextKeyRef = useRef(1);
  const busyRef = useRef(false);
  const installedRef = useRef<Set<string>>(new Set());
  const claudeInstalledRef = useRef(false);
  const contextHintShownRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const language = i18n.language.startsWith('de') ? 'de' : 'en';
  const isMessenger = props.variant === 'messenger';
  const narrow = isMessenger && props.size.w * GRID_UNIT_PX < NARROW_PX;

  const ownerId = selection ? ownerIdOf(selection) : null;
  const installedSet = new Set(installedIds);

  const refresh = useCallback(async () => {
    try {
      await initProfiles();
      const state = getProfilesState();
      setProfiles(state.profiles);
      setTeams(state.teams);
      const installed = await api.listModels().catch(() => []);
      installedRef.current = new Set(installed.map((m) => m.id));
      setInstalledIds(installed.map((m) => m.id));
      // Claude profiles count as "installed" iff the CLI is detected –
      // one cached probe (60 s) keeps the switcher cheap.
      const claude = await api.claudeCheckCached();
      claudeInstalledRef.current = claude.installed;
      setClaudeInstalled(claude.installed);
      if (state.profiles.length === 0) {
        setSelection(null);
        setSetup('noProfiles');
        return;
      }
      const active: ResolvedActive | null = getActive() ?? null;
      setSelection(active);
      if (!active) {
        setSetup('noProfiles');
        return;
      }
      const needed = requiredModelIds(active, state.profiles);
      const usable =
        needed.length > 0 &&
        needed.every((id) =>
          isLocalModel(id) ? installedRef.current.has(id) : claudeInstalledRef.current,
        );
      setSetup(usable ? 'ready' : 'noModel');
    } catch {
      setSetup('noModel');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offProfiles = onProfilesChange(() => void refresh());
    const offSettings = onAssistantSettingsChange(() => void refresh());
    return () => {
      offProfiles();
      offSettings();
    };
  }, [refresh]);

  /* ── Persistent chat: load on selection change / mount ───────────────── */

  useEffect(() => {
    if (!ownerId) {
      setFeed([]);
      return;
    }
    let cancelled = false;
    setError(null);
    loadChat(ownerId)
      .then((entries) => {
        if (cancelled) return;
        setFeed(entries.map((entry) => ({ key: entry.id, kind: 'entry', entry })));
      })
      .catch(() => {
        if (!cancelled) setFeed([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  /* Keep a ref of `busy` so the chat-change subscription (a long-lived
     closure) reads the CURRENT value instead of the one captured at
     subscribe time. */
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  /* Surface persisted replies that landed elsewhere: an in-flight generation
     that finished on a now-unmounted instance, or another surface writing to
     the same chat. Reload from the store on a change for THIS chat – but only
     while idle, since a busy instance owns the feed (it also holds ephemeral
     pushItem items that are not persisted and must survive). */
  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    const off = subscribeChatChanges((changedOwnerId) => {
      if (changedOwnerId !== ownerId || busyRef.current) return;
      loadChat(ownerId)
        .then((entries) => {
          if (cancelled) return;
          setFeed(entries.map((entry) => ({ key: entry.id, kind: 'entry', entry })));
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [ownerId]);

  /* Messenger: last-message snippets for every profile/team chat. */
  const ownerKey = [...profiles.map((p) => p.id), ...teams.map((tm) => tm.id)].join(',');
  useEffect(() => {
    if (!isMessenger || ownerKey === '') return;
    let cancelled = false;
    void (async () => {
      const map: Record<string, { text: string; at: string }> = {};
      for (const id of ownerKey.split(',')) {
        const entries = await loadChat(id).catch(() => [] as ChatEntry[]);
        const last = entries[entries.length - 1];
        if (last) map[id] = { text: snippetOf(last), at: last.at };
      }
      if (!cancelled) setLastByOwner(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [isMessenger, ownerKey]);

  /* Auto-scroll to the newest message on every feed change. */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed]);

  /* One-time hint per chat once the prompt context grows heavy. */
  useEffect(() => {
    if (!ownerId) return;
    if (contextHintShownRef.current.has(ownerId)) return;
    if (estimateContextChars(entriesOf(feed)) <= CHAT_CONTEXT_CHAR_LIMIT) return;
    contextHintShownRef.current.add(ownerId);
    const key = `s-${nextKeyRef.current++}`;
    setFeed((prev) => [
      ...prev,
      { key, kind: 'hint', text: String(t('assistant.chat.contextHint')) },
    ]);
  }, [feed, ownerId, t]);

  /* ── Feed helpers ─────────────────────────────────────────────────── */

  function ephemeralKey(): string {
    return `s-${nextKeyRef.current++}`;
  }

  function pushItem(item: FeedItem): void {
    setFeed((prev) => [...prev, item]);
  }

  /** Renders + persists one chat entry (persistence is best effort). */
  async function appendEntryItem(chatOwnerId: string, entry: ChatEntry): Promise<void> {
    setFeed((prev) => [...prev, { key: entry.id, kind: 'entry', entry }]);
    setLastByOwner((prev) => ({
      ...prev,
      [chatOwnerId]: { text: snippetOf(entry), at: entry.at },
    }));
    try {
      await appendChat(chatOwnerId, entry);
    } catch {
      /* history is a convenience – never block the conversation on it */
    }
  }

  /** Patches a persisted entry in the feed AND in the chat store. */
  function patchEntry(entryId: string, patch: Partial<Omit<ChatEntry, 'id'>>): void {
    setFeed((prev) =>
      prev.map((it) =>
        it.kind === 'entry' && it.entry.id === entryId
          ? { ...it, entry: { ...it.entry, ...patch, id: entryId } }
          : it,
      ),
    );
    if (ownerId) void updateChatEntry(ownerId, entryId, patch).catch(() => {});
  }

  function setSnapshotOutcome(
    entry: ChatEntry,
    index: number,
    outcome: ChatProposalOutcome,
    resultMessage?: string,
  ): void {
    const proposals = (entry.proposals ?? []).map((p, i) =>
      i === index ? { ...p, outcome } : p,
    );
    patchEntry(entry.id, { proposals });
    if (resultMessage !== undefined) {
      setResultMsgs((prev) => ({ ...prev, [`${entry.id}:${index}`]: resultMessage }));
    }
  }

  function setDelegationStatus(key: string, status: DelegationItem['status']): void {
    setFeed((prev) =>
      prev.map((it) => (it.key === key && it.kind === 'delegation' ? { ...it, status } : it)),
    );
  }

  function setForgetStatus(key: string, status: ForgetItem['status']): void {
    setFeed((prev) =>
      prev.map((it) => (it.key === key && it.kind === 'forget' ? { ...it, status } : it)),
    );
  }

  function errText(err: unknown): string {
    return String(
      t(api.isInsufficientRam(err) ? 'assistant.widget.ramError' : 'assistant.widget.generateError'),
    );
  }

  function speakerName(speakerId?: string): string {
    return (
      getProfilesState().profiles.find((p) => p.id === speakerId)?.name ??
      String(t('assistant.widget.defaultName'))
    );
  }

  function speakerFor(speakerId?: string): Speaker {
    const profile = getProfilesState().profiles.find((p) => p.id === speakerId);
    if (profile) return speakerOf(profile);
    return { name: String(t('assistant.widget.defaultName')), emoji: '🤖', color: 'accent-1' };
  }

  /**
   * Conversation context for the prompt: the last few user/assistant texts
   * (no cards) as a 'Bisheriger Verlauf' block above the current message.
   */
  function composeUserPrompt(question: string, entries: ChatEntry[]): string {
    const ctx = chatContext(entries);
    if (ctx.length === 0) return question;
    const lines = ctx.map(
      (e) => `${e.role === 'user' ? 'Nutzer' : speakerName(e.speakerId)}: ${e.text}`,
    );
    return `Bisheriger Verlauf:\n${lines.join('\n')}\n\nAktuelle Nachricht: ${question}`;
  }

  /* ── Model + generation pipeline ──────────────────────────────────── */

  async function ensureModel(modelId: string, slot: api.ModelSlot): Promise<void> {
    if ((await api.loadedModel(slot)) !== modelId) {
      setStatus(String(t('assistant.widget.modelLoading')));
      await api.loadModel(modelId, api.CTX_TOKENS, slot);
    }
  }

  async function effectiveAskBeforeExecute(profile: AssistantProfile): Promise<boolean> {
    if (typeof profile.askBeforeExecute === 'boolean') return profile.askBeforeExecute;
    return getAskBeforeExecute();
  }

  /**
   * Generates + persists + renders one answer as the given profile.
   * `question` is the raw braindump (re-run verbatim on delegation),
   * `promptUser` the history-augmented prompt actually sent to the model.
   * Returns false when the model output was unusable.
   */
  async function runAsProfile(
    profile: AssistantProfile,
    question: string,
    promptUser: string,
    memoryId: string,
    slot: 'main' | 'sub',
    chatOwnerId: string,
  ): Promise<boolean> {
    const speaker = speakerOf(profile);
    const modelEntry = modelById(profile.modelId);
    const claudeEntry = modelEntry?.provider === 'claude' ? modelEntry : null;
    if (claudeEntry) {
      // Claude profiles never touch llama.cpp slots – no model loading.
      // Cheap pre-flight (cached 60 s): fail with a helpful card instead of
      // a cryptic CLI error when Claude Code isn't installed.
      const check = await api.claudeCheckCached();
      claudeInstalledRef.current = check.installed;
      setClaudeInstalled(check.installed);
      if (!check.installed) {
        pushItem({
          key: ephemeralKey(),
          kind: 'hint',
          text: String(t('assistant.claude.notInstalled')),
        });
        return false;
      }
    } else {
      await ensureModel(profile.modelId, slot);
    }
    setStatus(String(t('assistant.widget.thinking')));

    const [instructions, personality, memory, competencesDoc] = await Promise.all([
      api.readDoc('profile', profile.id, 'instructions').catch(() => ''),
      api.readDoc('profile', profile.id, 'personality').catch(() => ''),
      api.readDoc('memory', memoryId, 'memory').catch(() => ''),
      api.readDoc('team-competences', 'global', 'competences').catch(() => ''),
    ]);
    const competencesFile = competencesDoc.trim() !== '' ? competencesDoc : profile.competences;

    const host = getHost();
    const state = getProfilesState();
    const others = state.profiles.filter((p) => p.id !== profile.id);
    const delegationEnabled = (profile.delegationAsk ?? true) && others.length > 0;
    const catalog = buildCommandCatalog(
      host.commands.list() as unknown as CatalogSource[],
      (key) => String(t(key)),
    ).filter((entry) => isCommandInScope(entry.id, profile.toolScope));

    // Current-state snapshots: any in-scope `*.context` command is run
    // read-only so the assistant knows existing/completed items (dedupe).
    const currentState: string[] = [];
    for (const entry of host.commands.list() as unknown as CatalogSource[]) {
      if (!entry.id.endsWith('.context') || !isCommandInScope(entry.id, profile.toolScope)) continue;
      try {
        const res = await host.commands.execute(entry.id, {});
        const data = res.ok ? (res.data as { contextText?: unknown } | undefined) : undefined;
        const text = typeof data?.contextText === 'string' ? data.contextText.trim() : '';
        if (text) currentState.push(text);
      } catch {
        // Context is best-effort; a failing provider never blocks the prompt.
      }
    }
    const system = buildSystemPrompt({
      instructions,
      personality,
      memory,
      competencesFile,
      catalog,
      language,
      currentDateIso: new Date().toISOString(),
      delegation: {
        enabled: delegationEnabled,
        ownProfileId: profile.id,
        others: others.map((p) => ({
          id: p.id,
          name: p.name,
          competences: modelCompetencesFn?.(p.modelId, language) ?? p.competences ?? '',
        })),
      },
      // Claude works directly on files in the notes workspace (sandboxed);
      // this adds its Cardo-understanding + hard limits + big-task section.
      agentWorkspace: claudeEntry !== null,
      // Live from the theme + design registries, so the assistant always
      // knows the CURRENT designs/options — never a stale hardcoded list.
      capabilities: buildCapabilities((key) => String(t(key)), language),
      // Live task/data snapshot so it flags duplicates and completed items.
      currentState,
    });

    let raw: string;
    if (claudeEntry) {
      // Same system prompt + history-augmented user message as local models;
      // the response feeds the identical parseProposals pipeline.
      const files = host.services.files;
      let workspaceDir: string | null = files ? await files.getFolder().catch(() => null) : null;
      if (workspaceDir === null && files) {
        workspaceDir = await files.ensureDefaultFolder().catch(() => null);
      }
      try {
        raw = await api.claudeGenerate({
          system,
          user: promptUser,
          model: claudeEntry.cliModel ?? claudeEntry.id,
          workspaceDir: workspaceDir ?? '',
          // Room for multi-file / multi-step work; the Rust bridge clamps to 30
          // and every turn stays confined to the workspace sandbox.
          maxTurns: 24,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes(api.CLAUDE_ERROR_MARKER)) {
          // Auth problem – inline card with the login hint.
          pushItem({
            key: ephemeralKey(),
            kind: 'hint',
            text: String(t('assistant.claude.authError')),
          });
        } else if (msg.includes('timed out')) {
          setError(String(t('assistant.claude.timeout')));
        } else {
          setError(String(t('assistant.claude.generateError')));
        }
        return false;
      }
    } else {
      raw = await api.generate({
        system,
        user: promptUser,
        maxTokens: 1024,
        jsonOnly: true,
        template: templateFor(profile.modelId),
        slot,
      });
    }
    const parsed = parseProposals(
      raw,
      (id: string) => host.commands.has(id),
      state.profiles.map((p) => p.id),
    );
    if (parsed.parseError) {
      setError(String(t('assistant.widget.parseError')));
      return false;
    }

    if (parsed.memory.length > 0) await appendMemory(memoryId, parsed.memory);

    // One persisted entry per answer: reply text + proposal cards + memory.
    let snapshots: ChatProposalSnapshot[];
    const resultMessages = new Map<number, string>();
    if (await effectiveAskBeforeExecute(profile)) {
      snapshots = parsed.proposals.map((p) => ({ ...p, outcome: 'pending' as const }));
    } else {
      // Auto-execute mode: run everything the scope allows, flag the rest.
      const { executed, blocked } = await executeProposals(parsed.proposals, {
        toolScope: profile.toolScope,
      });
      snapshots = [];
      for (const entry of executed) {
        if (entry.result.messageKey) {
          resultMessages.set(snapshots.length, String(t(entry.result.messageKey)));
        }
        snapshots.push({
          ...entry.proposal,
          outcome: entry.result.ok ? ('done' as const) : ('failed' as const),
        });
      }
      for (const proposal of blocked) snapshots.push({ ...proposal, outcome: 'blocked' as const });
    }

    if (parsed.reply !== '' || snapshots.length > 0 || parsed.memory.length > 0) {
      const entry = makeChatEntry({
        role: 'assistant',
        speakerId: profile.id,
        text: parsed.reply,
        ...(snapshots.length > 0 ? { proposals: snapshots } : {}),
        ...(parsed.memory.length > 0 ? { memory: parsed.memory, memoryId } : {}),
      });
      if (resultMessages.size > 0) {
        setResultMsgs((prev) => {
          const next = { ...prev };
          for (const [idx, msg] of resultMessages) next[`${entry.id}:${idx}`] = msg;
          return next;
        });
      }
      await appendEntryItem(chatOwnerId, entry);
    }

    for (const line of parsed.forget) {
      pushItem({ key: ephemeralKey(), kind: 'forget', speaker, memoryId, line, status: 'pending' });
    }

    // Delegation always asks – even in auto-execute mode (safety).
    for (const entry of parsed.delegate) {
      const target = state.profiles.find((p) => p.id === entry.to);
      if (!target || target.id === profile.id) continue;
      pushItem({
        key: ephemeralKey(),
        kind: 'delegation',
        speaker,
        targetId: target.id,
        targetName: target.name,
        reason: entry.reason,
        question,
        status: 'pending',
      });
    }

    return true;
  }

  /** Team flow: leader routes the braindump to a member, member answers. */
  async function runTeam(
    active: Extract<ResolvedActive, { kind: 'team' }>,
    question: string,
    promptUser: string,
  ): Promise<boolean> {
    const team = active.team;
    const state = getProfilesState();
    const members = team.memberIds
      .map((id) => state.profiles.find((p) => p.id === id))
      .filter((p): p is AssistantProfile => p !== undefined);
    const leader = members.find((p) => p.id === team.leaderId) ?? members[0];
    if (!leader) {
      setError(String(t('assistant.team.empty')));
      return false;
    }

    // Routing runs in a llama.cpp slot, so it needs a LOCAL model: a Claude
    // leader falls back to the fastest local member model. All-Claude teams
    // are unusable (the switcher already disables them – this is the guard).
    let routerModelId = leader.modelId;
    if (!isLocalModel(routerModelId)) {
      const localIds = members.map((m) => m.modelId).filter((id) => isLocalModel(id));
      if (localIds.length === 0) {
        setError(String(t('assistant.claude.teamNeedsLocalLeader')));
        return false;
      }
      routerModelId = fastestModelId(localIds, { localOnly: true });
    }

    setStatus(String(t('assistant.team.routing', { leader: leader.name })));
    let routerSlot: 'router' | 'main' = 'router';
    try {
      await ensureModel(routerModelId, 'router');
    } catch (err) {
      if (!api.isInsufficientRam(err)) throw err;
      // Not enough RAM for a dedicated router slot – run sequentially on main.
      routerSlot = 'main';
      await ensureModel(routerModelId, 'main');
    }

    setStatus(String(t('assistant.team.routing', { leader: leader.name })));
    const routerPrompt = buildRouterPrompt(team, members, question);
    const rawAnswer = await api.generate({
      system: routerPrompt.system,
      user: routerPrompt.user,
      maxTokens: 32,
      jsonOnly: false,
      template: templateFor(routerModelId),
      slot: routerSlot,
    });
    const chosenId = parseRouterAnswer(
      rawAnswer,
      members.map((m) => m.id),
      leader.id,
    );
    const member = members.find((m) => m.id === chosenId) ?? leader;

    pushItem({
      key: ephemeralKey(),
      kind: 'route',
      text: String(t('assistant.team.routedTo', { leader: leader.name, member: member.name })),
    });

    // The member answers with their own persona + the shared team memory.
    return runAsProfile(
      member,
      question,
      promptUser,
      resolveMemoryId({ type: 'team', id: team.id }),
      'main',
      team.id,
    );
  }

  /* ── Top-level actions ────────────────────────────────────────────── */

  async function send(): Promise<void> {
    const text = input.trim();
    if (text === '' || busy) return;
    const active = selection;
    if (!active) return;
    const chatOwnerId = ownerIdOf(active);

    // '/clearchat' is a local command – nothing is sent to the model.
    if (text.toLowerCase() === CLEAR_COMMAND) {
      setInput('');
      setError(null);
      try {
        await clearChat(chatOwnerId);
      } catch {
        /* best effort */
      }
      contextHintShownRef.current.delete(chatOwnerId);
      setLastByOwner((prev) => {
        const next = { ...prev };
        delete next[chatOwnerId];
        return next;
      });
      setFeed([
        { key: ephemeralKey(), kind: 'notice', text: String(t('assistant.chat.cleared')) },
      ]);
      return;
    }

    setBusy(true);
    setError(null);
    const promptUser = composeUserPrompt(text, entriesOf(feed));
    await appendEntryItem(chatOwnerId, makeChatEntry({ role: 'user', text }));
    setInput('');
    try {
      if (active.kind === 'team') {
        await runTeam(active, text, promptUser);
      } else {
        await runAsProfile(
          active.profile,
          text,
          promptUser,
          resolveMemoryId({ type: 'profile', id: active.profile.id }),
          'main',
          chatOwnerId,
        );
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  async function switchTo(value: string): Promise<void> {
    const sep = value.indexOf(':');
    if (sep <= 0) return;
    const kind = value.slice(0, sep);
    const id = value.slice(sep + 1);
    if ((kind !== 'profile' && kind !== 'team') || id === '') return;
    setError(null);
    setStatus(String(t('assistant.widget.modelLoading')));
    try {
      await setActive({ type: kind, id });
      await refresh();
      // Warm up the model behind the new selection so the first question is
      // snappy – but only when it is actually installed.
      const active: ResolvedActive | null = getActive() ?? null;
      const modelId =
        active?.kind === 'profile'
          ? active.profile.modelId
          : active
            ? getProfilesState().profiles.find((p) => p.id === active.team.leaderId)?.modelId
            : undefined;
      // Claude profiles have nothing to load – warm-up is local-only.
      if (
        modelId !== undefined &&
        isLocalModel(modelId) &&
        installedRef.current.has(modelId) &&
        (await api.loadedModel('main')) !== modelId
      ) {
        await api.loadModel(modelId, api.CTX_TOKENS, 'main');
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setStatus(null);
    }
  }

  function openChat(kind: 'profile' | 'team', id: string): void {
    setMobileView('chat');
    const value = `${kind}:${id}`;
    const current =
      selection?.kind === 'team' ? `team:${selection.team.id}` : `profile:${selection?.profile.id}`;
    if (value !== current) void switchTo(value);
  }

  async function acceptProposal(entry: ChatEntry, index: number): Promise<void> {
    const snap = entry.proposals?.[index];
    if (!snap || snap.outcome !== 'pending') return;
    const profile = getProfilesState().profiles.find((p) => p.id === entry.speakerId);
    if (!profile) {
      // The answering profile is gone – its tool scope is unknowable.
      setSnapshotOutcome(entry, index, 'blocked');
      return;
    }
    void recordProposalOutcome(profile.id, snap.command, true);
    try {
      const res = await executeProposals(
        [{ command: snap.command, params: snap.params, summary: snap.summary }],
        { toolScope: profile.toolScope },
      );
      const first = res.executed[0];
      if (first) {
        setSnapshotOutcome(
          entry,
          index,
          first.result.ok ? 'done' : 'failed',
          first.result.messageKey ? String(t(first.result.messageKey)) : undefined,
        );
      } else {
        setSnapshotOutcome(entry, index, res.blocked.length > 0 ? 'blocked' : 'failed');
      }
    } catch {
      setSnapshotOutcome(entry, index, 'failed');
    }
  }

  function declineProposal(entry: ChatEntry, index: number): void {
    const snap = entry.proposals?.[index];
    if (!snap || snap.outcome !== 'pending') return;
    if (entry.speakerId) void recordProposalOutcome(entry.speakerId, snap.command, false);
    setSnapshotOutcome(entry, index, 'dismissed');
  }

  function editProposal(entry: ChatEntry, index: number): void {
    const snap = entry.proposals?.[index];
    if (!snap || snap.outcome !== 'pending') return;
    requestPaletteEdit(snap.command, snap.params);
    setSnapshotOutcome(entry, index, 'edited');
  }

  async function acceptDelegation(item: DelegationItem): Promise<void> {
    if (item.status !== 'pending' || busy) return;
    const active = selection;
    const target = getProfilesState().profiles.find((p) => p.id === item.targetId);
    if (!target || !active) {
      setDelegationStatus(item.key, 'declined');
      return;
    }
    setBusy(true);
    setError(null);
    setDelegationStatus(item.key, 'accepted');
    const chatOwnerId = ownerIdOf(active);
    const promptUser = composeUserPrompt(item.question, entriesOf(feed));
    try {
      const memoryId = target.memoryId;
      if (!isLocalModel(target.modelId)) {
        // Claude target: nothing to load, no slot juggling.
        await runAsProfile(target, item.question, promptUser, memoryId, 'main', chatOwnerId);
      } else if ((await api.loadedModel('main')) === target.modelId) {
        // Same model – instant handover, only the docs change.
        await runAsProfile(target, item.question, promptUser, memoryId, 'main', chatOwnerId);
      } else {
        setStatus(String(t('assistant.widget.delegateTakeover', { name: target.name })));
        try {
          await api.loadModel(target.modelId, api.CTX_TOKENS, 'sub');
          await runAsProfile(target, item.question, promptUser, memoryId, 'sub', chatOwnerId);
        } catch (err) {
          if (!api.isInsufficientRam(err)) throw err;
          // No headroom for a second model – swap sequentially on main.
          setStatus(String(t('assistant.widget.delegateTakeover', { name: target.name })));
          await api.loadModel(target.modelId, api.CTX_TOKENS, 'main');
          await runAsProfile(target, item.question, promptUser, memoryId, 'main', chatOwnerId);
        }
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  /** Forget one remembered line straight from a persisted answer card. */
  async function forgetRemembered(entry: ChatEntry, line: string): Promise<void> {
    const memoryId =
      entry.memoryId ??
      getProfilesState().profiles.find((p) => p.id === entry.speakerId)?.memoryId;
    if (memoryId === undefined) return;
    try {
      await forgetLines(memoryId, [line]);
      patchEntry(entry.id, { memory: (entry.memory ?? []).filter((l) => l !== line) });
    } catch {
      setError(String(t('assistant.manage.error')));
    }
  }

  async function confirmForget(item: ForgetItem): Promise<void> {
    if (item.status !== 'pending') return;
    try {
      await forgetLines(item.memoryId, [item.line]);
      setForgetStatus(item.key, 'done');
    } catch {
      setError(String(t('assistant.manage.error')));
    }
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  /* ── Usability (installed models / detected Claude CLI) ──────────── */

  function modelAvailable(modelId: string): boolean {
    return isLocalModel(modelId) ? installedSet.has(modelId) : claudeInstalled;
  }

  function profileUsable(p: AssistantProfile): boolean {
    return modelAvailable(p.modelId);
  }

  function teamUsable(team: AssistantTeam): boolean {
    const members = team.memberIds
      .map((id) => profiles.find((p) => p.id === id))
      .filter((p): p is AssistantProfile => p !== undefined);
    if (members.length === 0 || !members.every((m) => modelAvailable(m.modelId))) return false;
    // Routing needs a local model: a Claude leader falls back to the
    // fastest local member – without any local member the team is unusable.
    const leader = members.find((m) => m.id === team.leaderId) ?? members[0];
    if (leader && !isLocalModel(leader.modelId)) {
      return members.some((m) => isLocalModel(m.modelId));
    }
    return true;
  }

  const firstUsableProfile = profiles.find((p) => profileUsable(p)) ?? null;

  /* ── Rendering ────────────────────────────────────────────────────── */

  function avatarCircle(speaker: Pick<Speaker, 'emoji' | 'color'>, small: boolean): JSX.Element {
    return (
      <span
        className={small ? 'aw-avatar aw-avatar--sm' : 'aw-avatar'}
        style={{ backgroundColor: `var(--palette-${speaker.color})` }}
        aria-hidden
      >
        {speaker.emoji}
      </span>
    );
  }

  function speakerChip(speaker: Speaker, label?: string): JSX.Element {
    return (
      <div className="aw-speaker">
        {avatarCircle(speaker, true)}
        <span className="aw-speaker__name">{label ?? speaker.name}</span>
      </div>
    );
  }

  function outcomeLine(outcome: ChatProposalOutcome, resultMessage?: string): JSX.Element {
    const cls =
      outcome === 'done'
        ? ' aw-card__status--ok'
        : outcome === 'failed'
          ? ' aw-card__status--fail'
          : outcome === 'blocked'
            ? ' aw-card__status--blocked'
            : '';
    return (
      <p className={`aw-card__status${cls}`}>
        {outcome === 'done' && `✓ ${t('assistant.widget.done')}`}
        {outcome === 'failed' && `✗ ${t('assistant.widget.failed')}`}
        {outcome === 'blocked' && t('assistant.widget.blocked')}
        {outcome === 'dismissed' && t('assistant.widget.dismissed')}
        {outcome === 'edited' && t('assistant.widget.editSent')}
        {resultMessage ? ` · ${resultMessage}` : ''}
      </p>
    );
  }

  function proposalCard(
    entry: ChatEntry,
    index: number,
    snap: ChatProposalSnapshot,
    speaker: Speaker,
  ): JSX.Element {
    return (
      <div key={`${entry.id}:p${index}`} className="aw-card c-card">
        {speakerChip(speaker)}
        <p className="aw-card__summary">{snap.summary}</p>
        {snap.outcome === 'pending' ? (
          <div className="aw-card__actions">
            <Button variant="primary" onClick={() => void acceptProposal(entry, index)}>
              {t('assistant.widget.yes')}
            </Button>
            <Button onClick={() => editProposal(entry, index)}>{t('assistant.widget.edit')}</Button>
            <Button variant="ghost" onClick={() => declineProposal(entry, index)}>
              {t('assistant.widget.no')}
            </Button>
          </div>
        ) : (
          outcomeLine(snap.outcome, resultMsgs[`${entry.id}:${index}`])
        )}
      </div>
    );
  }

  function memoryBlock(entry: ChatEntry): JSX.Element {
    return (
      <div className="aw-memory">
        <p className="aw-memory__title">{t('assistant.widget.rememberedTitle')}</p>
        <ul className="aw-memory__list">
          {(entry.memory ?? []).map((line) => (
            <li key={line} className="aw-memory__line">
              <span className="aw-memory__text">{line}</span>
              <button
                type="button"
                className="aw-forget-x"
                aria-label={t('assistant.widget.forgetLine')}
                title={String(t('assistant.widget.forgetLine'))}
                onClick={() => void forgetRemembered(entry, line)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  function renderEntry(entry: ChatEntry): JSX.Element {
    if (entry.role === 'user') {
      return (
        <div key={entry.id} className="aw-msg-row">
          <div className="aw-msg aw-msg--user">{entry.text}</div>
        </div>
      );
    }
    if (entry.role === 'system') {
      return (
        <p key={entry.id} className="aw-route">
          {entry.text}
        </p>
      );
    }
    const speaker = speakerFor(entry.speakerId);
    return (
      <div key={entry.id} className="aw-turn">
        {entry.text !== '' && (
          <div className="aw-card c-card">
            {speakerChip(speaker, String(t('assistant.widget.answers', { name: speaker.name })))}
            <p className="aw-reply">{entry.text}</p>
          </div>
        )}
        {/* Pending proposals are managed in the collapsible panel below the
            chat; resolved ones stay inline as a compact history line. */}
        {(entry.proposals ?? [])
          .map((snap, index) => ({ snap, index }))
          .filter(({ snap }) => snap.outcome !== 'pending')
          .map(({ snap, index }) => proposalCard(entry, index, snap, speaker))}
        {(entry.memory?.length ?? 0) > 0 && memoryBlock(entry)}
      </div>
    );
  }

  function renderItem(item: FeedItem): JSX.Element {
    switch (item.kind) {
      case 'entry':
        return renderEntry(item.entry);
      case 'route':
      case 'notice':
        return (
          <p key={item.key} className="aw-route">
            {item.text}
          </p>
        );
      case 'hint':
        return (
          <div key={item.key} className="aw-hintcard">
            {item.text}
          </div>
        );
      case 'delegation':
        return (
          <div key={item.key} className="aw-card c-card">
            {speakerChip(item.speaker)}
            <p className="aw-card__summary">
              {t('assistant.widget.delegateQuestion', { name: item.targetName, reason: item.reason })}
            </p>
            {item.status === 'pending' ? (
              <div className="aw-card__actions">
                <Button variant="primary" disabled={busy} onClick={() => void acceptDelegation(item)}>
                  {t('assistant.widget.delegateAccept')}
                </Button>
                <Button variant="ghost" onClick={() => setDelegationStatus(item.key, 'declined')}>
                  {t('assistant.widget.delegateKeep')}
                </Button>
              </div>
            ) : (
              <p className="aw-card__status">
                {item.status === 'accepted'
                  ? t('assistant.widget.delegateDone')
                  : t('assistant.widget.dismissed')}
              </p>
            )}
          </div>
        );
      case 'forget':
        return (
          <div key={item.key} className="aw-card c-card">
            {speakerChip(item.speaker)}
            <p className="aw-card__summary">
              {t('assistant.widget.forgetConfirm', { line: item.line })}
            </p>
            {item.status === 'pending' ? (
              <div className="aw-card__actions">
                <Button variant="primary" onClick={() => void confirmForget(item)}>
                  {t('assistant.widget.yes')}
                </Button>
                <Button variant="ghost" onClick={() => setForgetStatus(item.key, 'declined')}>
                  {t('assistant.widget.no')}
                </Button>
              </div>
            ) : (
              <p className="aw-card__status">
                {item.status === 'done'
                  ? t('assistant.widget.forgotten')
                  : t('assistant.widget.dismissed')}
              </p>
            )}
          </div>
        );
    }
  }

  function relTime(iso: string): string {
    const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return String(t('assistant.chat.time.now'));
    if (minutes < 60) return String(t('assistant.chat.time.minutes', { count: minutes }));
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return String(t('assistant.chat.time.hours', { count: hours }));
    return String(t('assistant.chat.time.days', { count: Math.floor(hours / 24) }));
  }

  function chatListItem(
    kind: 'profile' | 'team',
    id: string,
    visual: Speaker,
    usable: boolean,
  ): JSX.Element {
    const value = `${kind}:${id}`;
    const isActive = selectValue === value;
    const last = lastByOwner[id];
    const cls = `aw-chatlist__item${isActive ? ' aw-chatlist__item--active' : ''}${
      usable ? '' : ' aw-chatlist__item--disabled'
    }`;
    return (
      <button
        key={value}
        type="button"
        className={cls}
        disabled={!usable || busy}
        onClick={() => openChat(kind, id)}
      >
        {avatarCircle(visual, false)}
        <span className="aw-chatlist__meta">
          <span className="aw-chatlist__name">
            {visual.name}
            {!usable && ` – ${t('assistant.widget.modelMissing')}`}
          </span>
          <span className="aw-chatlist__snippet">
            {last ? last.text : t('assistant.chat.empty')}
          </span>
        </span>
        {last && <span className="aw-chatlist__time">{relTime(last.at)}</span>}
      </button>
    );
  }

  if (setup === 'loading') {
    return (
      <div className="aw-root aw-empty">
        <p className="c-muted">{t('common.loading')}</p>
      </div>
    );
  }

  const activeVisual = selection
    ? selection.kind === 'team'
      ? speakerOf(selection.team)
      : speakerOf(selection.profile)
    : null;
  const selectValue = selection
    ? selection.kind === 'team'
      ? `team:${selection.team.id}`
      : `profile:${selection.profile.id}`
    : '';

  // The header (avatar + switcher) renders in EVERY state – hiding the
  // switcher on 'noModel' was the dead end users kept getting trapped in.
  const header = (
    <header className="aw-header">
      {narrow && mobileView === 'chat' && (
        <button
          type="button"
          className="aw-back"
          aria-label={t('assistant.chat.back')}
          title={String(t('assistant.chat.back'))}
          onClick={() => setMobileView('list')}
        >
          ‹
        </button>
      )}
      {activeVisual && avatarCircle(activeVisual, false)}
      {profiles.length > 0 && (
        <select
          className="c-input aw-switcher"
          aria-label={t('assistant.widget.switchLabel')}
          value={selectValue}
          disabled={busy}
          onChange={(e) => void switchTo(e.target.value)}
        >
          <optgroup label={String(t('assistant.widget.profilesGroup'))}>
            {profiles.map((p) => {
              const usable = profileUsable(p);
              return (
                <option key={p.id} value={`profile:${p.id}`} disabled={!usable}>
                  {`${p.emoji} ${p.name}${usable ? '' : ` – ${t('assistant.widget.modelMissing')}`}`}
                </option>
              );
            })}
          </optgroup>
          {teams.length > 0 && (
            <optgroup label={String(t('assistant.team.group'))}>
              {teams.map((team) => {
                const usable = teamUsable(team);
                return (
                  <option key={team.id} value={`team:${team.id}`} disabled={!usable}>
                    {`👥 ${team.name}${usable ? '' : ` – ${t('assistant.widget.modelMissing')}`}`}
                  </option>
                );
              })}
            </optgroup>
          )}
        </select>
      )}
    </header>
  );

  let body: JSX.Element;
  if (setup === 'noProfiles') {
    body = (
      <div className="aw-empty-body">
        <p className="c-muted">{t('assistant.widget.noProfiles')}</p>
      </div>
    );
  } else if (setup === 'noModel') {
    body = (
      <div className="aw-empty-body">
        <p className="c-muted">{t('assistant.widget.noModel')}</p>
        {firstUsableProfile && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void switchTo(`profile:${firstUsableProfile.id}`)}
          >
            {t('assistant.widget.switchToProfile', { name: firstUsableProfile.name })}
          </Button>
        )}
        {error !== null && <p className="aw-error">{error}</p>}
      </div>
    );
  } else {
    body = (
      <>
        {(busy || status !== null) && (
          <div className="aw-status">
            <span className="aw-spinner" aria-hidden />
            <span className="c-muted">{status ?? t('assistant.widget.thinking')}</span>
          </div>
        )}

        <div className="aw-scroll" ref={scrollRef}>
          {feed.length === 0 && !busy && (
            <p className="aw-route">{t('assistant.chat.empty')}</p>
          )}
          {feed.map((item) => renderItem(item))}
          {error !== null && <p className="aw-error">{error}</p>}
        </div>

        {(() => {
          const pending = feed.flatMap((item) =>
            item.kind === 'entry'
              ? (item.entry.proposals ?? [])
                  .map((snap, index) => ({ entry: item.entry, index, snap }))
                  .filter((p) => p.snap.outcome === 'pending')
              : [],
          );
          if (pending.length === 0) return null;
          return (
            <div className="aw-proposals">
              <button
                type="button"
                className="aw-proposals__head"
                aria-expanded={!proposalsCollapsed}
                onClick={() => setProposalsCollapsed((v) => !v)}
              >
                <span className="aw-proposals__caret">{proposalsCollapsed ? '▸' : '▾'}</span>
                {t('assistant.widget.proposalsTitle', { count: pending.length })}
              </button>
              {!proposalsCollapsed && (
                <div className="aw-proposals__list">
                  {pending.map(({ entry, index, snap }) =>
                    proposalCard(entry, index, snap, speakerFor(entry.speakerId)),
                  )}
                </div>
              )}
            </div>
          );
        })()}

        <div className="aw-composer">
          <textarea
            className="c-input aw-input"
            placeholder={t('assistant.chat.placeholder')}
            value={input}
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <Button variant="primary" disabled={busy || input.trim() === ''} onClick={() => void send()}>
            {t('assistant.widget.send')}
          </Button>
        </div>
      </>
    );
  }

  const showList = isMessenger && (!narrow || mobileView === 'list');
  const showChat = !isMessenger || !narrow || mobileView === 'chat';

  return (
    <div className={`aw-root${isMessenger ? ' aw-root--messenger' : ''}`}>
      {showList && (
        <aside className="aw-chatlist" aria-label={String(t('assistant.chat.listLabel'))}>
          {profiles.map((p) => chatListItem('profile', p.id, speakerOf(p), profileUsable(p)))}
          {teams.map((team) => chatListItem('team', team.id, speakerOf(team), teamUsable(team)))}
          {profiles.length === 0 && (
            <p className="aw-route">{t('assistant.widget.noProfiles')}</p>
          )}
        </aside>
      )}
      {showChat && (
        <div className="aw-main">
          {header}
          {body}
        </div>
      )}
    </div>
  );
}
