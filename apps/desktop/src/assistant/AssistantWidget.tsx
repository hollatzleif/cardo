import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WidgetProps } from '@cardo/plugin-api';
import { Button } from '@cardo/ui';
import { getHost } from '../host';
import * as api from './api';
import { buildCommandCatalog, isCommandInScope, type CatalogSource } from './catalog';
import { requestPaletteEdit } from './hostBridge';
import { appendMemory, forgetLines } from './memory';
import { modelById, type PromptTemplate } from './models';
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
import { executeProposals, parseProposals, type AssistantProposal } from './proposals';
import { buildRouterPrompt, parseRouterAnswer } from './routing';
import { getAskBeforeExecute, onAssistantSettingsChange } from './store';
import './assistant-widget.css';

/**
 * Braindump widget, multi-assistant edition (v0.4.0): thoughts in, concrete
 * command proposals out – now per assistant profile or team. Everything runs
 * locally; the model answers with a strict JSON contract that is parsed
 * defensively and executed only via the command registry, filtered by the
 * active profile's tool scope.
 */

type Setup = 'loading' | 'noProfiles' | 'noModel' | 'ready';

interface Speaker {
  name: string;
  emoji: string;
  color: string;
}

type ProposalStatus = 'pending' | 'done' | 'failed' | 'dismissed' | 'edited' | 'blocked';

interface ReplyItem {
  id: number;
  type: 'reply';
  speaker: Speaker;
  text: string;
}

interface RouteItem {
  id: number;
  type: 'route';
  text: string;
}

interface ProposalItem {
  id: number;
  type: 'proposal';
  speaker: Speaker;
  profileId: string;
  toolScope: AssistantProfile['toolScope'];
  proposal: AssistantProposal;
  status: ProposalStatus;
  resultMessage?: string;
}

interface DelegationItem {
  id: number;
  type: 'delegation';
  speaker: Speaker;
  targetId: string;
  targetName: string;
  reason: string;
  /** The original braindump – re-run verbatim when the user hands over. */
  question: string;
  status: 'pending' | 'accepted' | 'declined';
}

interface MemoryItem {
  id: number;
  type: 'memory';
  speaker: Speaker;
  memoryId: string;
  lines: string[];
}

interface ForgetItem {
  id: number;
  type: 'forget';
  speaker: Speaker;
  memoryId: string;
  line: string;
  status: 'pending' | 'done' | 'declined';
}

type FeedItem = ReplyItem | RouteItem | ProposalItem | DelegationItem | MemoryItem | ForgetItem;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function templateFor(modelId: string): PromptTemplate {
  return modelById(modelId)?.template ?? 'chatml';
}

function speakerOf(source: { name: string; emoji: string; color: string }): Speaker {
  return { name: source.name, emoji: source.emoji, color: source.color };
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

export function AssistantWidget(_props: WidgetProps) {
  const { t, i18n } = useTranslation();
  const [setup, setSetup] = useState<Setup>('loading');
  const [profiles, setProfiles] = useState<AssistantProfile[]>([]);
  const [teams, setTeams] = useState<AssistantTeam[]>([]);
  const [selection, setSelection] = useState<ResolvedActive | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const nextIdRef = useRef(1);

  const language = i18n.language.startsWith('de') ? 'de' : 'en';

  const refresh = useCallback(async () => {
    try {
      await initProfiles();
      const state = getProfilesState();
      setProfiles(state.profiles);
      setTeams(state.teams);
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
      const installed = await api.listModels();
      const needed = requiredModelIds(active, state.profiles);
      const usable =
        needed.length > 0 && needed.every((id) => installed.some((m) => m.id === id));
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

  /* ── Feed helpers ─────────────────────────────────────────────────── */

  function push(item: DistributiveOmit<FeedItem, 'id'>): void {
    const id = nextIdRef.current++;
    setFeed((prev) => [...prev, { ...item, id } as FeedItem]);
  }

  function setProposalStatus(id: number, status: ProposalStatus, resultMessage?: string): void {
    setFeed((prev) =>
      prev.map((it) => (it.id === id && it.type === 'proposal' ? { ...it, status, resultMessage } : it)),
    );
  }

  function setDelegationStatus(id: number, status: DelegationItem['status']): void {
    setFeed((prev) =>
      prev.map((it) => (it.id === id && it.type === 'delegation' ? { ...it, status } : it)),
    );
  }

  function setForgetStatus(id: number, status: ForgetItem['status']): void {
    setFeed((prev) =>
      prev.map((it) => (it.id === id && it.type === 'forget' ? { ...it, status } : it)),
    );
  }

  function removeMemoryLine(id: number, line: string): void {
    setFeed((prev) =>
      prev.flatMap((it) => {
        if (it.id !== id || it.type !== 'memory') return [it];
        const lines = it.lines.filter((l) => l !== line);
        return lines.length === 0 ? [] : [{ ...it, lines }];
      }),
    );
  }

  function errText(err: unknown): string {
    return String(
      t(api.isInsufficientRam(err) ? 'assistant.widget.ramError' : 'assistant.widget.generateError'),
    );
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
   * Generates + renders one answer as the given profile.
   * Returns false when the model output was unusable (input stays put).
   */
  async function runAsProfile(
    profile: AssistantProfile,
    question: string,
    memoryId: string,
    slot: 'main' | 'sub',
  ): Promise<boolean> {
    const speaker = speakerOf(profile);
    await ensureModel(profile.modelId, slot);
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
        others: others.map((p) => ({ id: p.id, name: p.name, competences: p.competences })),
      },
    });

    const raw = await api.generate({
      system,
      user: question,
      maxTokens: 1024,
      jsonOnly: true,
      template: templateFor(profile.modelId),
      slot,
    });
    const parsed = parseProposals(
      raw,
      (id: string) => host.commands.has(id),
      state.profiles.map((p) => p.id),
    );
    if (parsed.parseError) {
      setError(String(t('assistant.widget.parseError')));
      return false;
    }

    if (parsed.reply !== '') push({ type: 'reply', speaker, text: parsed.reply });

    if (parsed.memory.length > 0) {
      await appendMemory(memoryId, parsed.memory);
      push({ type: 'memory', speaker, memoryId, lines: parsed.memory });
    }

    for (const line of parsed.forget) {
      push({ type: 'forget', speaker, memoryId, line, status: 'pending' });
    }

    if (await effectiveAskBeforeExecute(profile)) {
      for (const proposal of parsed.proposals) {
        push({
          type: 'proposal',
          speaker,
          profileId: profile.id,
          toolScope: profile.toolScope,
          proposal,
          status: 'pending',
        });
      }
    } else {
      // Auto-execute mode: run everything the scope allows, flag the rest.
      const { executed, blocked } = await executeProposals(parsed.proposals, {
        toolScope: profile.toolScope,
      });
      for (const entry of executed) {
        push({
          type: 'proposal',
          speaker,
          profileId: profile.id,
          toolScope: profile.toolScope,
          proposal: entry.proposal,
          status: entry.result.ok ? 'done' : 'failed',
          resultMessage: entry.result.messageKey ? String(t(entry.result.messageKey)) : undefined,
        });
      }
      for (const proposal of blocked) {
        push({
          type: 'proposal',
          speaker,
          profileId: profile.id,
          toolScope: profile.toolScope,
          proposal,
          status: 'blocked',
        });
      }
    }

    // Delegation always asks – even in auto-execute mode (safety).
    for (const entry of parsed.delegate) {
      const target = state.profiles.find((p) => p.id === entry.to);
      if (!target || target.id === profile.id) continue;
      push({
        type: 'delegation',
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
  async function runTeam(active: Extract<ResolvedActive, { kind: 'team' }>, question: string): Promise<boolean> {
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

    setStatus(String(t('assistant.team.routing', { leader: leader.name })));
    let routerSlot: 'router' | 'main' = 'router';
    try {
      await ensureModel(leader.modelId, 'router');
    } catch (err) {
      if (!api.isInsufficientRam(err)) throw err;
      // Not enough RAM for a dedicated router slot – run sequentially on main.
      routerSlot = 'main';
      await ensureModel(leader.modelId, 'main');
    }

    setStatus(String(t('assistant.team.routing', { leader: leader.name })));
    const routerPrompt = buildRouterPrompt(team, members, question);
    const rawAnswer = await api.generate({
      system: routerPrompt.system,
      user: routerPrompt.user,
      maxTokens: 32,
      jsonOnly: false,
      template: templateFor(leader.modelId),
      slot: routerSlot,
    });
    const chosenId = parseRouterAnswer(
      rawAnswer,
      members.map((m) => m.id),
      leader.id,
    );
    const member = members.find((m) => m.id === chosenId) ?? leader;

    push({
      type: 'route',
      text: String(t('assistant.team.routedTo', { leader: leader.name, member: member.name })),
    });

    // The member answers with their own persona + the shared team memory.
    return runAsProfile(member, question, resolveMemoryId({ type: 'team', id: team.id }), 'main');
  }

  /* ── Top-level actions ────────────────────────────────────────────── */

  async function send(): Promise<void> {
    const text = input.trim();
    if (text === '' || busy) return;
    const active = selection;
    if (!active) return;
    setBusy(true);
    setError(null);
    setFeed([]);
    try {
      const ok =
        active.kind === 'team'
          ? await runTeam(active, text)
          : await runAsProfile(
              active.profile,
              text,
              resolveMemoryId({ type: 'profile', id: active.profile.id }),
              'main',
            );
      if (ok) setInput('');
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
      // Warm up the model behind the new selection so the first question is snappy.
      const active: ResolvedActive | null = getActive() ?? null;
      const modelId =
        active?.kind === 'profile'
          ? active.profile.modelId
          : active
            ? getProfilesState().profiles.find((p) => p.id === active.team.leaderId)?.modelId
            : undefined;
      if (modelId !== undefined && (await api.loadedModel('main')) !== modelId) {
        await api.loadModel(modelId, api.CTX_TOKENS, 'main');
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setStatus(null);
    }
  }

  async function acceptProposal(item: ProposalItem): Promise<void> {
    if (item.status !== 'pending') return;
    void recordProposalOutcome(item.profileId, item.proposal.command, true);
    try {
      const res = await executeProposals([item.proposal], { toolScope: item.toolScope });
      const first = res.executed[0];
      if (first) {
        setProposalStatus(
          item.id,
          first.result.ok ? 'done' : 'failed',
          first.result.messageKey ? String(t(first.result.messageKey)) : undefined,
        );
      } else {
        setProposalStatus(item.id, res.blocked.length > 0 ? 'blocked' : 'failed');
      }
    } catch {
      setProposalStatus(item.id, 'failed');
    }
  }

  function declineProposal(item: ProposalItem): void {
    if (item.status !== 'pending') return;
    void recordProposalOutcome(item.profileId, item.proposal.command, false);
    setProposalStatus(item.id, 'dismissed');
  }

  function editProposal(item: ProposalItem): void {
    if (item.status !== 'pending') return;
    requestPaletteEdit(item.proposal.command, item.proposal.params);
    setProposalStatus(item.id, 'edited');
  }

  async function acceptDelegation(item: DelegationItem): Promise<void> {
    if (item.status !== 'pending' || busy) return;
    const target = getProfilesState().profiles.find((p) => p.id === item.targetId);
    if (!target) {
      setDelegationStatus(item.id, 'declined');
      return;
    }
    setBusy(true);
    setError(null);
    setDelegationStatus(item.id, 'accepted');
    try {
      const memoryId = target.memoryId;
      if ((await api.loadedModel('main')) === target.modelId) {
        // Same model – instant handover, only the docs change.
        await runAsProfile(target, item.question, memoryId, 'main');
      } else {
        setStatus(String(t('assistant.widget.delegateTakeover', { name: target.name })));
        try {
          await api.loadModel(target.modelId, api.CTX_TOKENS, 'sub');
          await runAsProfile(target, item.question, memoryId, 'sub');
        } catch (err) {
          if (!api.isInsufficientRam(err)) throw err;
          // No headroom for a second model – swap sequentially on main.
          setStatus(String(t('assistant.widget.delegateTakeover', { name: target.name })));
          await api.loadModel(target.modelId, api.CTX_TOKENS, 'main');
          await runAsProfile(target, item.question, memoryId, 'main');
        }
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  async function forgetRemembered(item: MemoryItem, line: string): Promise<void> {
    try {
      await forgetLines(item.memoryId, [line]);
      removeMemoryLine(item.id, line);
    } catch {
      setError(String(t('assistant.manage.error')));
    }
  }

  async function confirmForget(item: ForgetItem): Promise<void> {
    if (item.status !== 'pending') return;
    try {
      await forgetLines(item.memoryId, [item.line]);
      setForgetStatus(item.id, 'done');
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

  function proposalStatusLine(item: ProposalItem): JSX.Element {
    const cls =
      item.status === 'done'
        ? ' aw-card__status--ok'
        : item.status === 'failed'
          ? ' aw-card__status--fail'
          : item.status === 'blocked'
            ? ' aw-card__status--blocked'
            : '';
    return (
      <p className={`aw-card__status${cls}`}>
        {item.status === 'done' && `✓ ${t('assistant.widget.done')}`}
        {item.status === 'failed' && `✗ ${t('assistant.widget.failed')}`}
        {item.status === 'blocked' && t('assistant.widget.blocked')}
        {item.status === 'dismissed' && t('assistant.widget.dismissed')}
        {item.status === 'edited' && t('assistant.widget.editSent')}
        {item.resultMessage ? ` · ${item.resultMessage}` : ''}
      </p>
    );
  }

  function renderItem(item: FeedItem): JSX.Element {
    switch (item.type) {
      case 'route':
        return (
          <p key={item.id} className="aw-route">
            {item.text}
          </p>
        );
      case 'reply':
        return (
          <div key={item.id} className="aw-card c-card">
            {speakerChip(item.speaker, String(t('assistant.widget.answers', { name: item.speaker.name })))}
            <p className="aw-reply">{item.text}</p>
          </div>
        );
      case 'proposal':
        return (
          <div key={item.id} className="aw-card c-card">
            {speakerChip(item.speaker)}
            <p className="aw-card__summary">{item.proposal.summary}</p>
            {item.status === 'pending' ? (
              <div className="aw-card__actions">
                <Button variant="primary" onClick={() => void acceptProposal(item)}>
                  {t('assistant.widget.yes')}
                </Button>
                <Button onClick={() => editProposal(item)}>{t('assistant.widget.edit')}</Button>
                <Button variant="ghost" onClick={() => declineProposal(item)}>
                  {t('assistant.widget.no')}
                </Button>
              </div>
            ) : (
              proposalStatusLine(item)
            )}
          </div>
        );
      case 'delegation':
        return (
          <div key={item.id} className="aw-card c-card">
            {speakerChip(item.speaker)}
            <p className="aw-card__summary">
              {t('assistant.widget.delegateQuestion', { name: item.targetName, reason: item.reason })}
            </p>
            {item.status === 'pending' ? (
              <div className="aw-card__actions">
                <Button variant="primary" disabled={busy} onClick={() => void acceptDelegation(item)}>
                  {t('assistant.widget.delegateAccept')}
                </Button>
                <Button variant="ghost" onClick={() => setDelegationStatus(item.id, 'declined')}>
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
      case 'memory':
        return (
          <div key={item.id} className="aw-memory">
            <p className="aw-memory__title">{t('assistant.widget.rememberedTitle')}</p>
            <ul className="aw-memory__list">
              {item.lines.map((line) => (
                <li key={line} className="aw-memory__line">
                  <span className="aw-memory__text">{line}</span>
                  <button
                    type="button"
                    className="aw-forget-x"
                    aria-label={t('assistant.widget.forgetLine')}
                    title={String(t('assistant.widget.forgetLine'))}
                    onClick={() => void forgetRemembered(item, line)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      case 'forget':
        return (
          <div key={item.id} className="aw-card c-card">
            {speakerChip(item.speaker)}
            <p className="aw-card__summary">
              {t('assistant.widget.forgetConfirm', { line: item.line })}
            </p>
            {item.status === 'pending' ? (
              <div className="aw-card__actions">
                <Button variant="primary" onClick={() => void confirmForget(item)}>
                  {t('assistant.widget.yes')}
                </Button>
                <Button variant="ghost" onClick={() => setForgetStatus(item.id, 'declined')}>
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

  if (setup === 'loading') {
    return (
      <div className="aw-root aw-empty">
        <p className="c-muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (setup === 'noProfiles') {
    return (
      <div className="aw-root aw-empty">
        <p className="c-muted">{t('assistant.widget.noProfiles')}</p>
      </div>
    );
  }

  if (setup === 'noModel') {
    return (
      <div className="aw-root aw-empty">
        <p className="c-muted">{t('assistant.widget.noModel')}</p>
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

  return (
    <div className="aw-root">
      <header className="aw-header">
        {activeVisual && avatarCircle(activeVisual, false)}
        <select
          className="c-input aw-switcher"
          aria-label={t('assistant.widget.switchLabel')}
          value={selectValue}
          disabled={busy}
          onChange={(e) => void switchTo(e.target.value)}
        >
          {profiles.length > 0 && (
            <optgroup label={String(t('assistant.widget.profilesGroup'))}>
              {profiles.map((p) => (
                <option key={p.id} value={`profile:${p.id}`}>
                  {`${p.emoji} ${p.name}`}
                </option>
              ))}
            </optgroup>
          )}
          {teams.length > 0 && (
            <optgroup label={String(t('assistant.team.group'))}>
              {teams.map((team) => (
                <option key={team.id} value={`team:${team.id}`}>
                  {`👥 ${team.name}`}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </header>

      {(busy || status !== null) && (
        <div className="aw-status">
          <span className="aw-spinner" aria-hidden />
          <span className="c-muted">{status ?? t('assistant.widget.thinking')}</span>
        </div>
      )}

      <div className="aw-scroll">
        {error !== null && <p className="aw-error">{error}</p>}
        {feed.map((item) => renderItem(item))}
      </div>

      <div className="aw-composer">
        <textarea
          className="c-input aw-input"
          placeholder={t('assistant.widget.placeholder')}
          value={input}
          rows={2}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onComposerKeyDown}
        />
        <Button variant="primary" disabled={busy || input.trim() === ''} onClick={() => void send()}>
          {t('assistant.widget.send')}
        </Button>
      </div>
    </div>
  );
}
