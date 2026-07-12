import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Button, Input } from '@cardo/ui';
import { getHost } from '../host';
import { toolFactories } from '../host/tools';
import * as api from './api';
import { generateInstructions, generatePersonality, resolveDocLanguage } from './docs';
import {
  MODEL_CATALOG,
  fastestModelId,
  modelById,
  rateModels,
  type ModelDef,
  type ModelRating,
  type RatedModel,
} from './models';
import {
  createMemory,
  createProfile,
  createTeam,
  competenceSuggestions,
  deleteMemory,
  deleteProfile,
  deleteTeam,
  duplicateProfile,
  exportProfile,
  getProfilesState,
  importProfile,
  initProfiles,
  memoryUsers,
  onProfilesChange,
  renameMemory,
  setActive,
  updateProfile,
  updateTeam,
  type ActiveSelection,
  type AssistantProfile,
  type AssistantTeam,
  type CompetenceSuggestion,
  type MemoryMeta,
  type ProfileExport,
  type ProfilesState,
} from './profiles';
import { generateTeamCompetences } from './competences';
import {
  defaultPersona,
  getAskBeforeExecute,
  setAskBeforeExecute,
  type AssistantPersona,
  type PersonaLanguage,
  type PersonaStyle,
} from './store';
import './assistant.css';
import './assistant-settings.css';

/**
 * Assistant settings tab (v0.4, multi-assistant):
 * 1. Active assistant/team card.
 * 2. Collapsible "more assistants & teams" (profiles, teams, import/export,
 *    creation flow with template → persona → model → memory → tools → look).
 * 3. Global model management (install honors license consents, delete is
 *    blocked while a profile uses the model).
 * 4. Competence-learning banner.
 * 5. Global toggles (askBeforeExecute, delegation suggestions).
 * 6. Advanced: per-profile docs, memory manager, team competences.
 *
 * With exactly one profile and no teams this collapses to the familiar
 * v0.3 view: the top card, model list, toggles and customize button all
 * act on that single assistant directly.
 */

/* ── Shared helpers ──────────────────────────────────────────────────── */

function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function ramGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

const ACCENT_TOKENS = [
  'accent-1',
  'accent-2',
  'accent-3',
  'accent-4',
  'accent-5',
  'accent-6',
  'accent-7',
  'accent-8',
] as const;

interface ToolOption {
  id: string;
  nameKey: string;
}

const NS = 'core.settings';

/** New global toggle: suggest delegating tasks to better-suited assistants. */
async function getDelegationAsk(): Promise<boolean> {
  const doc = (await getHost().backend.get(NS, 'assistant.delegationAsk')) as {
    value?: boolean;
  } | null;
  return doc?.value !== false; // default true
}

async function setDelegationAsk(value: boolean): Promise<void> {
  await getHost().backend.set(NS, 'assistant.delegationAsk', { value });
}

/**
 * (Re)writes the global team competences doc (scope 'team-competences',
 * id 'global') from every profile's competences, preserving the
 * user-maintained '## Notizen' section.
 */
async function regenerateTeamCompetencesDoc(): Promise<void> {
  const { profiles } = getProfilesState();
  const existing = await api.readDoc('team-competences', 'global', 'competences').catch(() => '');
  const content = generateTeamCompetences(
    profiles.map((p) => ({ name: p.name, competences: p.competences })),
    existing,
  );
  await api.writeDoc('team-competences', 'global', 'competences', content);
}

function RatingBadge({ rated }: { rated: RatedModel }) {
  const { t } = useTranslation();
  const cls: Record<ModelRating, string> = {
    great: 'assistant-badge--great',
    ok: 'assistant-badge--ok',
    slow: 'assistant-badge--slow',
    tooBig: 'assistant-badge--toobig',
  };
  return (
    <span className={`assistant-badge ${cls[rated.rating]}`}>
      {t(`assistant.rating.${rated.rating}`)}
      {rated.rating !== 'tooBig' && ` · ${t(`assistant.speed.${rated.speed}`)}`}
    </span>
  );
}

function Avatar({ emoji, color, small }: { emoji: string; color: string; small?: boolean }) {
  return (
    <span
      className={`as-avatar${small ? ' as-avatar--sm' : ''}`}
      style={{ background: `var(--palette-${color})` }}
      aria-hidden
    >
      {emoji}
    </span>
  );
}

function MemoryBadge({ memoryId, memories }: { memoryId: string; memories: MemoryMeta[] }) {
  const { t } = useTranslation();
  const name = memories.find((m) => m.id === memoryId)?.name;
  if (!name) return null;
  return <span className="assistant-badge">{t('assistant.memory.badge', { name })}</span>;
}

function ColorDots({ value, onChange }: { value: string; onChange(color: string): void }) {
  return (
    <div className="as-color-dots">
      {ACCENT_TOKENS.map((token) => (
        <button
          key={token}
          type="button"
          className={`as-color-dot${value === token ? ' as-color-dot--active' : ''}`}
          style={{ background: `var(--palette-${token})` }}
          onClick={() => onChange(token)}
        />
      ))}
    </div>
  );
}

function ToolScopeField({
  toolOptions,
  allTools,
  setAllTools,
  toolIds,
  setToolIds,
}: {
  toolOptions: ToolOption[];
  allTools: boolean;
  setAllTools(v: boolean): void;
  toolIds: ReadonlySet<string>;
  setToolIds(ids: Set<string>): void;
}) {
  const { t } = useTranslation();
  const toggle = (id: string) => {
    const next = new Set(toolIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setToolIds(next);
  };
  return (
    <div className="awizard-field">
      <label className="awizard-choice">
        <input type="checkbox" checked={allTools} onChange={(e) => setAllTools(e.target.checked)} />
        {t('assistant.tools.all')}
      </label>
      {!allTools && (
        <>
          <span className="c-muted">{t('assistant.tools.pickHint')}</span>
          <div className="awizard-choices">
            {toolOptions.map((o) => (
              <label key={o.id} className="awizard-choice">
                <input type="checkbox" checked={toolIds.has(o.id)} onChange={() => toggle(o.id)} />
                {t(o.nameKey)}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Persona form (creation flow + "Assistent anpassen") ─────────────── */

function PersonaForm({
  initial,
  submitLabel,
  cancelLabel,
  onSubmit,
  onCancel,
  children,
}: {
  initial: AssistantPersona | null;
  submitLabel: string;
  cancelLabel?: string;
  onSubmit(persona: AssistantPersona): void;
  onCancel?: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const base = initial ?? defaultPersona();
  const [assistantName, setAssistantName] = useState(base.assistantName);
  const [userName, setUserName] = useState(base.userName);
  const [style, setStyle] = useState<PersonaStyle>(base.style);
  const [language, setLanguage] = useState<PersonaLanguage>(base.language);
  const [extra, setExtra] = useState(base.extra);

  const styles: PersonaStyle[] = ['concise', 'friendly', 'detailed'];
  const languages: PersonaLanguage[] = ['de', 'en', 'app'];

  return (
    <div className="awizard-form">
      <label className="awizard-field">
        <span>{t('assistant.persona.nameQuestion')}</span>
        <Input value={assistantName} onChange={(e) => setAssistantName(e.target.value)} />
      </label>
      <label className="awizard-field">
        <span>{t('assistant.persona.callYouQuestion')}</span>
        <Input value={userName} onChange={(e) => setUserName(e.target.value)} />
      </label>
      <div className="awizard-field">
        <span>{t('assistant.persona.styleQuestion')}</span>
        <div className="awizard-choices">
          {styles.map((s) => (
            <label key={s} className="awizard-choice">
              <input
                type="radio"
                name="assistant-style"
                checked={style === s}
                onChange={() => setStyle(s)}
              />
              {t(`assistant.persona.style.${s}`)}
            </label>
          ))}
        </div>
      </div>
      <div className="awizard-field">
        <span>{t('assistant.persona.languageQuestion')}</span>
        <div className="awizard-choices">
          {languages.map((l) => (
            <label key={l} className="awizard-choice">
              <input
                type="radio"
                name="assistant-language"
                checked={language === l}
                onChange={() => setLanguage(l)}
              />
              {t(`assistant.persona.language.${l}`)}
            </label>
          ))}
        </div>
      </div>
      <label className="awizard-field">
        <span>{t('assistant.persona.extraQuestion')}</span>
        <textarea
          className="c-input assistant-textarea"
          rows={3}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
        />
      </label>
      {children}
      <div className="awizard-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
        )}
        <Button
          variant="primary"
          onClick={() => onSubmit({ assistantName, userName, style, language, extra })}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/* ── License consent (Gemma) ─────────────────────────────────────────── */

function GemmaConsent({
  entry,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  entry: ModelDef;
  confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  return (
    <div className="as-consent c-card">
      <strong>{t('assistant.license.consentTitle')}</strong>
      <p>
        {t('assistant.license.consentText', {
          model: entry.label,
          name: entry.license.name ?? '',
        })}
      </p>
      <a href={entry.license.url} target="_blank" rel="noreferrer">
        {t('assistant.license.view')}
      </a>
      <label className="awizard-choice">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        {t('assistant.license.consentCheckbox')}
      </label>
      <div className="awizard-actions">
        <Button variant="primary" disabled={!checked} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/* ── Model picker card (creation flow) ───────────────────────────────── */

function ModelPickerCard({
  entry,
  rated,
  installed,
  selected,
  onSelect,
}: {
  entry: ModelDef;
  rated: RatedModel | null;
  installed: boolean;
  selected: boolean;
  onSelect(): void;
}) {
  const { t } = useTranslation();
  const disabled = rated?.rating === 'tooBig';
  const meta = [
    gb(entry.sizeBytes),
    t('assistant.model.ramNeed', { ram: ramGb(entry.ramNeedMb) }),
    ...(entry.moeActiveB ? [t('assistant.model.moeActive', { b: entry.moeActiveB })] : []),
  ].join(' · ');
  return (
    <button
      type="button"
      className={`awizard-model${selected ? ' awizard-model--selected' : ''}${
        disabled ? ' awizard-model--disabled' : ''
      }`}
      disabled={disabled}
      onClick={onSelect}
    >
      <strong>
        {rated?.recommended && '⭐ '}
        {entry.label}
      </strong>
      {rated?.recommended && <span className="c-muted"> · {t('assistant.wizard.recommended')}</span>}
      <span className="c-muted awizard-model__meta">{meta}</span>
      {rated && <RatingBadge rated={rated} />}
      <span className="as-model-lines">
        <span>
          {t('assistant.model.strengths')}: {t(entry.strengthsKey)}
        </span>
        <span>
          {t('assistant.model.weaknesses')}: {t(entry.weaknessesKey)}
        </span>
        <span>
          {t('assistant.model.idealFor')}: {t(entry.idealForKey)}
        </span>
      </span>
      {entry.license.notice === 'llama' && (
        <span className="c-muted">{t('assistant.model.builtWithLlama')}</span>
      )}
      <span className="c-muted awizard-model__meta">
        {installed ? t('assistant.model.installed') : t('assistant.flow.willDownload')}
      </span>
    </button>
  );
}

/* ── Install-then-create runner (last flow step) ─────────────────────── */

function InstallAndCreate({
  entry,
  needsDownload,
  create,
  onDone,
  onBack,
}: {
  entry: ModelDef;
  needsDownload: boolean;
  create(): Promise<void>;
  onDone(): void;
  onBack(): void;
}) {
  const { t } = useTranslation();
  const needsConsent = needsDownload && entry.license.notice === 'gemma-consent';
  const [phase, setPhase] = useState<'consent' | 'run' | 'creating' | 'error'>(
    needsConsent ? 'consent' : 'run',
  );
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (phase !== 'run' || startedRef.current) return;
    startedRef.current = true;
    let active = true;
    const off = api.onDownloadProgress((p) => {
      if (active && p.id === entry.id) setProgress({ done: p.downloadedBytes, total: p.totalBytes });
    });
    void (async () => {
      try {
        if (needsDownload) await api.downloadModel(entry.id, entry.url);
        if (!active) return;
        setPhase('creating');
        await create();
        if (active) onDone();
      } catch {
        if (active) {
          startedRef.current = false;
          setPhase('error');
        }
      }
    })();
    return () => {
      active = false;
      off();
    };
  }, [phase, entry, needsDownload, create, onDone]);

  if (phase === 'consent') {
    return (
      <GemmaConsent
        entry={entry}
        confirmLabel={t('assistant.manage.install')}
        onConfirm={() => setPhase('run')}
        onCancel={onBack}
      />
    );
  }

  if (phase === 'error') {
    return (
      <div className="awizard-step">
        <p className="assistant-error">{t('assistant.wizard.downloadError')}</p>
        <div className="awizard-actions">
          <Button onClick={onBack}>{t('assistant.wizard.back')}</Button>
        </div>
      </div>
    );
  }

  if (phase === 'creating' || !needsDownload) {
    return <p className="c-muted">{t('assistant.flow.creating')}</p>;
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="awizard-step">
      <h4>{t('assistant.wizard.downloadTitle', { model: entry.label })}</h4>
      <div className="awizard-progress">
        <div className="awizard-progress__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="c-muted">
        {progress
          ? `${gb(progress.done)} / ${gb(progress.total)} (${pct}%)`
          : t('assistant.wizard.starting')}
      </p>
      <div className="awizard-actions">
        <Button
          variant="ghost"
          onClick={() => {
            void api.cancelDownload(entry.id).catch(() => {});
            onBack();
          }}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/* ── New assistant flow ──────────────────────────────────────────────── */

const TEMPLATES = [
  { id: 'secretary', emoji: '🗂️', color: 'accent-1', style: 'concise' as PersonaStyle },
  { id: 'planner', emoji: '🗓️', color: 'accent-4', style: 'detailed' as PersonaStyle },
  { id: 'coach', emoji: '💪', color: 'accent-6', style: 'friendly' as PersonaStyle },
  { id: 'blank', emoji: '🤖', color: 'accent-2', style: 'friendly' as PersonaStyle },
] as const;

type FlowStep = 'template' | 'persona' | 'model' | 'memory' | 'tools' | 'look' | 'install' | 'done';

function NewAssistantFlow({
  memories,
  installedIds,
  rated,
  hw,
  toolOptions,
  firstRun,
  onClose,
}: {
  memories: MemoryMeta[];
  installedIds: string[];
  rated: RatedModel[];
  hw: api.AssistantHwInfo | null;
  toolOptions: ToolOption[];
  firstRun?: boolean;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const recommendedId = rated.find((r) => r.recommended)?.model.id ?? null;

  const [step, setStep] = useState<FlowStep>('template');
  const [persona, setPersonaState] = useState<AssistantPersona>(defaultPersona());
  const [competences, setCompetences] = useState('');
  const [emoji, setEmoji] = useState('🤖');
  const [color, setColor] = useState('accent-2');
  const [modelId, setModelId] = useState<string | null>(recommendedId);
  const [memMode, setMemMode] = useState<'share' | 'own'>(memories.length > 0 ? 'share' : 'own');
  const [shareId, setShareId] = useState(memories[0]?.id ?? '');
  const [ownName, setOwnName] = useState('');
  const [allTools, setAllTools] = useState(true);
  const [toolIds, setToolIds] = useState<Set<string>>(new Set(toolOptions.map((o) => o.id)));

  const entry = modelId ? modelById(modelId) : null;

  function chooseTemplate(tpl: (typeof TEMPLATES)[number]) {
    setEmoji(tpl.emoji);
    setColor(tpl.color);
    setPersonaState({
      ...defaultPersona(),
      style: tpl.style,
      extra: tpl.id === 'blank' ? '' : t(`assistant.templates.${tpl.id}.extra`),
    });
    setCompetences(tpl.id === 'blank' ? '' : t(`assistant.templates.${tpl.id}.competences`));
    setStep('persona');
  }

  const create = useCallback(async () => {
    if (!modelId) return;
    const lang = resolveDocLanguage(persona, i18n.language);
    const name = persona.assistantName.trim() || t('assistant.widget.defaultName');
    const created = await createProfile({
      name,
      emoji,
      color,
      modelId,
      memoryChoice:
        memMode === 'share' && shareId
          ? { share: shareId }
          : { own: ownName.trim() || t('assistant.memory.defaultOwnName', { name }) },
      competences,
      toolScope: allTools ? null : [...toolIds],
      personality: generatePersonality(persona, lang),
      instructions: generateInstructions(lang),
    });
    if (firstRun) await setActive({ type: 'profile', id: created.id });
  }, [
    modelId,
    persona,
    emoji,
    color,
    memMode,
    shareId,
    ownName,
    competences,
    allTools,
    toolIds,
    firstRun,
    i18n.language,
    t,
  ]);

  const handleCreated = useCallback(() => {
    if (firstRun) setStep('done');
    else onClose();
  }, [firstRun, onClose]);

  const stepTitle = (n: number, key: string) => (
    <h4>
      {t('assistant.flow.stepOf', { n, total: 6 })} · {t(key)}
    </h4>
  );

  return (
    <div className="as-flow">
      {step === 'template' && (
        <>
          {stepTitle(1, 'assistant.flow.templateTitle')}
          <div className="awizard-models">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className="awizard-model"
                onClick={() => chooseTemplate(tpl)}
              >
                <Avatar emoji={tpl.emoji} color={tpl.color} small />
                <strong>{t(`assistant.templates.${tpl.id}.name`)}</strong>
                <span className="c-muted awizard-model__meta">
                  {t(`assistant.templates.${tpl.id}.desc`)}
                </span>
              </button>
            ))}
          </div>
          {!firstRun && (
            <div className="awizard-actions">
              <Button variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
            </div>
          )}
        </>
      )}

      {step === 'persona' && (
        <>
          {stepTitle(2, 'assistant.wizard.personaTitle')}
          <PersonaForm
            initial={persona}
            submitLabel={t('assistant.wizard.continue')}
            cancelLabel={t('assistant.wizard.back')}
            onCancel={() => setStep('template')}
            onSubmit={(p) => {
              setPersonaState(p);
              setStep('model');
            }}
          >
            <label className="awizard-field">
              <span>{t('assistant.flow.competencesLabel')}</span>
              <textarea
                className="c-input assistant-textarea"
                rows={3}
                value={competences}
                onChange={(e) => setCompetences(e.target.value)}
              />
              <span className="c-muted">{t('assistant.flow.competencesHint')}</span>
            </label>
          </PersonaForm>
        </>
      )}

      {step === 'model' && (
        <>
          {stepTitle(3, 'assistant.flow.modelTitle')}
          {hw && (
            <p className="c-muted">
              {t('assistant.wizard.checkIntro', {
                ram: ramGb(hw.totalRamMb),
                cores: hw.cpuCores,
                chip: hw.appleSilicon ? 'Apple Silicon' : hw.arch,
              })}
            </p>
          )}
          <div className="awizard-models">
            {rated.map((r) => {
              const e = r.model;
              return (
                <ModelPickerCard
                  key={r.model.id}
                  entry={e}
                  rated={r}
                  installed={installedIds.includes(r.model.id)}
                  selected={modelId === r.model.id}
                  onSelect={() => setModelId(r.model.id)}
                />
              );
            })}
          </div>
          <div className="awizard-actions">
            <Button variant="ghost" onClick={() => setStep('persona')}>
              {t('assistant.wizard.back')}
            </Button>
            <Button variant="primary" disabled={!modelId} onClick={() => setStep('memory')}>
              {t('assistant.wizard.continue')}
            </Button>
          </div>
        </>
      )}

      {step === 'memory' && (
        <>
          {stepTitle(4, 'assistant.flow.memoryTitle')}
          {memories.length > 0 && (
            <label className="awizard-choice">
              <input
                type="radio"
                name="assistant-memory-mode"
                checked={memMode === 'share'}
                onChange={() => setMemMode('share')}
              />
              {t('assistant.memory.share')}
              <select
                className="c-input settings__select"
                value={shareId}
                disabled={memMode !== 'share'}
                onChange={(e) => setShareId(e.target.value)}
              >
                {memories.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <span className="c-muted">{t('assistant.memory.recommended')}</span>
            </label>
          )}
          <label className="awizard-choice">
            <input
              type="radio"
              name="assistant-memory-mode"
              checked={memMode === 'own'}
              onChange={() => setMemMode('own')}
            />
            {t('assistant.memory.own')}
          </label>
          {memMode === 'own' && (
            <Input
              value={ownName}
              placeholder={t('assistant.memory.ownName')}
              onChange={(e) => setOwnName(e.target.value)}
            />
          )}
          <p className="c-muted">{t('assistant.memory.whyShare')}</p>
          <div className="awizard-actions">
            <Button variant="ghost" onClick={() => setStep('model')}>
              {t('assistant.wizard.back')}
            </Button>
            <Button variant="primary" onClick={() => setStep('tools')}>
              {t('assistant.wizard.continue')}
            </Button>
          </div>
        </>
      )}

      {step === 'tools' && (
        <>
          {stepTitle(5, 'assistant.flow.toolsTitle')}
          <ToolScopeField
            toolOptions={toolOptions}
            allTools={allTools}
            setAllTools={setAllTools}
            toolIds={toolIds}
            setToolIds={setToolIds}
          />
          <div className="awizard-actions">
            <Button variant="ghost" onClick={() => setStep('memory')}>
              {t('assistant.wizard.back')}
            </Button>
            <Button variant="primary" onClick={() => setStep('look')}>
              {t('assistant.wizard.continue')}
            </Button>
          </div>
        </>
      )}

      {step === 'look' && (
        <>
          {stepTitle(6, 'assistant.flow.lookTitle')}
          <div className="awizard-field">
            <span>{t('assistant.flow.emojiLabel')}</span>
            <Input
              className="as-emoji-input"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
            />
          </div>
          <div className="awizard-field">
            <span>{t('assistant.flow.colorLabel')}</span>
            <ColorDots value={color} onChange={setColor} />
          </div>
          <div className="as-badges">
            <Avatar emoji={emoji} color={color} />
            <strong>{persona.assistantName || t('assistant.widget.defaultName')}</strong>
          </div>
          <div className="awizard-actions">
            <Button variant="ghost" onClick={() => setStep('tools')}>
              {t('assistant.wizard.back')}
            </Button>
            <Button variant="primary" disabled={!entry} onClick={() => setStep('install')}>
              {t('assistant.flow.create')}
            </Button>
          </div>
        </>
      )}

      {step === 'install' && entry && (
        <InstallAndCreate
          entry={entry}
          needsDownload={!installedIds.includes(entry.id)}
          create={create}
          onDone={handleCreated}
          onBack={() => setStep('look')}
        />
      )}

      {step === 'done' && (
        <div className="awizard-step">
          <h4>{t('assistant.wizard.doneTitle')}</h4>
          <p>{t('assistant.wizard.doneBody')}</p>
          <div className="awizard-actions">
            <Button variant="primary" onClick={onClose}>
              {t('common.ok')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Profile editor ──────────────────────────────────────────────────── */

function ProfileEditor({
  profile,
  toolOptions,
  installedIds,
  onClose,
}: {
  profile: AssistantProfile;
  toolOptions: ToolOption[];
  installedIds: string[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const allIds = toolOptions.map((o) => o.id);
  const scope: string[] = profile.toolScope ?? allIds;
  const [name, setName] = useState<string>(profile.name);
  const [emoji, setEmoji] = useState<string>(profile.emoji);
  const [color, setColor] = useState<string>(profile.color);
  const [modelId, setModelId] = useState<string>(profile.modelId);
  const [competences, setCompetences] = useState<string>(profile.competences);
  const [allTools, setAllTools] = useState(profile.toolScope === null);
  const [toolIds, setToolIds] = useState<Set<string>>(new Set(scope));

  async function saveIt() {
    await updateProfile(profile.id, {
      name: name.trim() || profile.name,
      emoji,
      color,
      modelId,
      competences,
      toolScope: allTools ? null : [...toolIds],
    });
    onClose();
  }

  return (
    <div className="awizard-form">
      <h4>{t('assistant.profiles.editTitle', { name: profile.name })}</h4>
      <label className="awizard-field">
        <span>{t('assistant.profiles.nameLabel')}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="awizard-field">
        <span>{t('assistant.flow.emojiLabel')}</span>
        <Input className="as-emoji-input" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
      </div>
      <div className="awizard-field">
        <span>{t('assistant.flow.colorLabel')}</span>
        <ColorDots value={color} onChange={setColor} />
      </div>
      <label className="awizard-field">
        <span>{t('assistant.profiles.modelLabel')}</span>
        <select
          className="c-input settings__select"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
        >
          {MODEL_CATALOG.map((m: ModelDef) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {installedIds.includes(m.id) ? '' : ` – ${t('assistant.profiles.modelMissing')}`}
            </option>
          ))}
        </select>
      </label>
      <label className="awizard-field">
        <span>{t('assistant.flow.competencesLabel')}</span>
        <textarea
          className="c-input assistant-textarea"
          rows={3}
          value={competences}
          onChange={(e) => setCompetences(e.target.value)}
        />
        <span className="c-muted">{t('assistant.flow.competencesHint')}</span>
      </label>
      <ToolScopeField
        toolOptions={toolOptions}
        allTools={allTools}
        setAllTools={setAllTools}
        toolIds={toolIds}
        setToolIds={setToolIds}
      />
      <div className="awizard-actions">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void saveIt()}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

/* ── Team form (create + edit) ───────────────────────────────────────── */

function TeamForm({
  initial,
  profiles,
  memories,
  onClose,
}: {
  initial: AssistantTeam | null;
  profiles: AssistantProfile[];
  memories: MemoryMeta[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState<string>(initial?.name ?? '');
  const [emoji, setEmoji] = useState<string>(initial?.emoji ?? '👥');
  const [color, setColor] = useState<string>(initial?.color ?? 'accent-3');
  const [memberIds, setMemberIds] = useState<string[]>(initial?.memberIds ?? []);
  const [leaderId, setLeaderId] = useState<string>(initial?.leaderId ?? '');
  const [memMode, setMemMode] = useState<'share' | 'own'>(
    initial || memories.length > 0 ? 'share' : 'own',
  );
  const [shareId, setShareId] = useState<string>(initial?.memoryId ?? memories[0]?.id ?? '');
  const [ownName, setOwnName] = useState('');
  const [saving, setSaving] = useState(false);

  const members = profiles.filter((p) => memberIds.includes(p.id));
  const fastest = members.length > 0 ? fastestModelId(members.map((m) => m.modelId)) : null;
  const recommendedLeaderId = members.find((m) => m.modelId === fastest)?.id ?? null;
  const effectiveLeaderId = memberIds.includes(leaderId)
    ? leaderId
    : (recommendedLeaderId ?? memberIds[0] ?? '');

  function toggleMember(id: string) {
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  }

  const valid = name.trim().length > 0 && memberIds.length >= 2 && effectiveLeaderId !== '';

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const ownMemoryName = ownName.trim() || t('assistant.memory.defaultOwnName', { name: name.trim() });
      if (initial) {
        // Edits patch the memoryId directly; a new own memory is created first.
        const memoryId = memMode === 'own' ? (await createMemory(ownMemoryName)).id : shareId;
        await updateTeam(initial.id, {
          name: name.trim(),
          emoji,
          color,
          memberIds,
          leaderId: effectiveLeaderId,
          memoryId,
        });
      } else {
        await createTeam({
          name: name.trim(),
          emoji,
          color,
          memberIds,
          leaderId: effectiveLeaderId,
          memoryChoice:
            memMode === 'share' && shareId ? { share: shareId } : { own: ownMemoryName },
        });
      }
      await regenerateTeamCompetencesDoc();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="awizard-form">
      <h4>{initial ? t('assistant.teams.editTitle', { name: initial.name }) : t('assistant.teams.new')}</h4>
      <label className="awizard-field">
        <span>{t('assistant.profiles.nameLabel')}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="awizard-field">
        <span>{t('assistant.flow.emojiLabel')}</span>
        <Input className="as-emoji-input" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
      </div>
      <div className="awizard-field">
        <span>{t('assistant.flow.colorLabel')}</span>
        <ColorDots value={color} onChange={setColor} />
      </div>
      <div className="awizard-field">
        <span>{t('assistant.teams.membersLabel')}</span>
        <div className="awizard-choices">
          {profiles.map((p) => (
            <label key={p.id} className="awizard-choice">
              <input
                type="checkbox"
                checked={memberIds.includes(p.id)}
                onChange={() => toggleMember(p.id)}
              />
              <Avatar emoji={p.emoji} color={p.color} small />
              {p.name}
            </label>
          ))}
        </div>
      </div>
      {members.length >= 2 && (
        <label className="awizard-field">
          <span>{t('assistant.teams.leaderLabel')}</span>
          <select
            className="c-input settings__select"
            value={effectiveLeaderId}
            onChange={(e) => setLeaderId(e.target.value)}
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.id === recommendedLeaderId ? ` ${t('assistant.teams.leaderFastest')}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="awizard-field">
        <span>{t('assistant.flow.memoryTitle')}</span>
        {memories.length > 0 && (
          <label className="awizard-choice">
            <input
              type="radio"
              name="team-memory-mode"
              checked={memMode === 'share'}
              onChange={() => setMemMode('share')}
            />
            {t('assistant.memory.share')}
            <select
              className="c-input settings__select"
              value={shareId}
              disabled={memMode !== 'share'}
              onChange={(e) => setShareId(e.target.value)}
            >
              {memories.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="c-muted">{t('assistant.memory.recommended')}</span>
          </label>
        )}
        <label className="awizard-choice">
          <input
            type="radio"
            name="team-memory-mode"
            checked={memMode === 'own'}
            onChange={() => setMemMode('own')}
          />
          {t('assistant.memory.own')}
        </label>
        {memMode === 'own' && (
          <Input
            value={ownName}
            placeholder={t('assistant.memory.ownName')}
            onChange={(e) => setOwnName(e.target.value)}
          />
        )}
        <p className="c-muted">{t('assistant.memory.whyShare')}</p>
      </div>
      {memberIds.length < 2 && <p className="c-muted">{t('assistant.teams.needTwo')}</p>}
      <div className="awizard-actions">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={!valid || saving} onClick={() => void submit()}>
          {initial ? t('common.save') : t('assistant.teams.create')}
        </Button>
      </div>
    </div>
  );
}

/* ── Competence learning banner ──────────────────────────────────────── */

function CompetenceBanner({
  suggestions,
  profiles,
  toolNames,
  onHandled,
}: {
  suggestions: CompetenceSuggestion[];
  profiles: AssistantProfile[];
  toolNames: Map<string, string>;
  onHandled(): void;
}) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  // One banner at a time; 'accepted' is the count of successful proposals.
  const items = suggestions.map((s) => ({ ...s, key: `${s.profileId}|${s.toolId}` }));
  const current = items.find(
    (s) => !dismissed.has(s.key) && profiles.some((p) => p.id === s.profileId),
  );
  if (!current) return null;
  const profile = profiles.find((p) => p.id === current.profileId);
  if (!profile) return null;
  const tool = toolNames.get(current.toolId) ?? current.toolId;

  const hide = () => setDismissed(new Set([...dismissed, current.key]));

  async function accept() {
    if (!profile || !current) return;
    // The appended line names the tool id as well, so the suggestion engine
    // (competencesMentionTool) recognises it as covered.
    const line = t('assistant.competence.appendLine', { tool, toolId: current.toolId });
    await updateProfile(profile.id, {
      competences: profile.competences ? `${profile.competences}\n${line}` : line,
    });
    await regenerateTeamCompetencesDoc();
    hide();
    onHandled();
  }

  return (
    <div className="as-banner c-card">
      <p>{t('assistant.competence.banner', { name: profile.name, count: current.accepted, tool })}</p>
      <div className="awizard-actions">
        <Button variant="primary" onClick={() => void accept()}>
          {t('assistant.competence.accept')}
        </Button>
        <Button variant="ghost" onClick={hide}>
          {t('assistant.competence.ignore')}
        </Button>
      </div>
    </div>
  );
}

/* ── Global model management ─────────────────────────────────────────── */

function ModelManageRow({
  rated,
  entry,
  installed,
  isActiveModel,
  usedByNames,
  canUse,
  onUse,
  onChanged,
}: {
  rated: RatedModel;
  entry: ModelDef;
  installed: boolean;
  isActiveModel: boolean;
  usedByNames: string[];
  canUse: boolean;
  onUse(): void;
  onChanged(): void;
}) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);
  const [pct, setPct] = useState(0);
  const [failed, setFailed] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);

  useEffect(
    () =>
      api.onDownloadProgress((p) => {
        if (p.id === entry.id && p.totalBytes > 0) {
          setPct(Math.round((p.downloadedBytes / p.totalBytes) * 100));
        }
      }),
    [entry.id],
  );

  async function doDownload() {
    setConsentOpen(false);
    setDownloading(true);
    setFailed(false);
    setPct(0);
    try {
      await api.downloadModel(entry.id, entry.url);
      onChanged();
    } catch {
      setFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  function install() {
    if (entry.license.notice === 'gemma-consent') setConsentOpen(true);
    else void doDownload();
  }

  async function remove() {
    if (!window.confirm(t('assistant.manage.deleteConfirm'))) return;
    await api.deleteModel(entry.id).catch(() => {});
    onChanged();
  }

  const blocked = usedByNames.length > 0;

  return (
    <>
      <div className="assistant-modelrow c-card">
        <div className="assistant-modelrow__info">
          <strong>{entry.label}</strong>
          {isActiveModel && (
            <span className="assistant-badge assistant-badge--great">
              {t('assistant.manage.active')}
            </span>
          )}
          <span className="c-muted">
            {gb(entry.sizeBytes)} · {t('assistant.model.ramNeed', { ram: ramGb(entry.ramNeedMb) })}
          </span>
          <RatingBadge rated={rated} />
          {entry.license.notice === 'llama' && (
            <span className="c-muted">{t('assistant.model.builtWithLlama')}</span>
          )}
          {installed && blocked && (
            <span className="c-muted">
              {t('assistant.manage.deleteBlockedByProfile', { names: usedByNames.join(', ') })}
            </span>
          )}
          {failed && <span className="assistant-error">{t('assistant.manage.error')}</span>}
        </div>
        <div className="assistant-modelrow__actions">
          {downloading ? (
            <>
              <div className="awizard-progress assistant-modelrow__progress">
                <div className="awizard-progress__fill" style={{ width: `${pct}%` }} />
              </div>
              <Button variant="ghost" onClick={() => void api.cancelDownload(entry.id).catch(() => {})}>
                {t('common.cancel')}
              </Button>
            </>
          ) : installed ? (
            <>
              {canUse && <Button onClick={onUse}>{t('assistant.manage.use')}</Button>}
              <Button
                variant="danger"
                disabled={blocked}
                title={blocked ? t('assistant.manage.deleteBlockedByProfile', { names: usedByNames.join(', ') }) : undefined}
                onClick={() => void remove()}
              >
                {t('common.delete')}
              </Button>
            </>
          ) : (
            <Button variant="primary" disabled={rated.rating === 'tooBig'} onClick={install}>
              {t('assistant.manage.install')}
            </Button>
          )}
        </div>
      </div>
      {consentOpen && (
        <GemmaConsent
          entry={entry}
          confirmLabel={t('assistant.manage.install')}
          onConfirm={() => void doDownload()}
          onCancel={() => setConsentOpen(false)}
        />
      )}
    </>
  );
}

/* ── Advanced: per-profile docs ──────────────────────────────────────── */

const PROFILE_DOC_KINDS = ['personality', 'instructions'] as const;

function ProfileDocs({ profiles }: { profiles: AssistantProfile[] }) {
  const { t } = useTranslation();
  const [pid, setPid] = useState<string>(profiles[0]?.id ?? '');
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [savedKind, setSavedKind] = useState<string | null>(null);

  useEffect(() => {
    if (!profiles.some((p) => p.id === pid)) setPid(profiles[0]?.id ?? '');
  }, [profiles, pid]);

  useEffect(() => {
    if (!pid) return;
    let active = true;
    void (async () => {
      const loaded: Record<string, string> = {};
      for (const kind of PROFILE_DOC_KINDS) {
        loaded[kind] = await api.readDoc('profile', pid, kind).catch(() => '');
      }
      if (active) setTexts(loaded);
    })();
    return () => {
      active = false;
    };
  }, [pid]);

  async function save(kind: (typeof PROFILE_DOC_KINDS)[number]) {
    await api.writeDoc('profile', pid, kind, texts[kind] ?? '');
    setSavedKind(kind);
    window.setTimeout(() => setSavedKind((k) => (k === kind ? null : k)), 2000);
  }

  return (
    <div className="assistant-advanced__doc">
      <strong>{t('assistant.advanced.profileDocsTitle')}</strong>
      <select className="c-input settings__select" value={pid} onChange={(e) => setPid(e.target.value)}>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.emoji} {p.name}
          </option>
        ))}
      </select>
      {PROFILE_DOC_KINDS.map((kind) => (
        <div key={kind} className="assistant-advanced__doc">
          <span>{t(`assistant.manage.doc.${kind}`)}</span>
          <textarea
            className="c-input assistant-textarea assistant-textarea--doc"
            rows={8}
            value={texts[kind] ?? ''}
            onChange={(e) => setTexts((prev) => ({ ...prev, [kind]: e.target.value }))}
          />
          <div className="awizard-actions">
            <Button onClick={() => void save(kind)}>{t('common.save')}</Button>
            {savedKind === kind && <span className="c-muted">{t('assistant.manage.saved')}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Advanced: memory manager ────────────────────────────────────────── */

function MemoryManager({ memories }: { memories: MemoryMeta[] }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const u: Record<string, string[]> = {};
      const tx: Record<string, string> = {};
      for (const m of memories) {
        try {
          u[m.id] = memoryUsers(m.id);
        } catch {
          u[m.id] = [];
        }
        tx[m.id] = await api.readDoc('memory', m.id, 'memory').catch(() => '');
      }
      if (active) {
        setUsers(u);
        setTexts(tx);
      }
    })();
    return () => {
      active = false;
    };
  }, [memories]);

  async function save(id: string) {
    await api.writeDoc('memory', id, 'memory', texts[id] ?? '');
    setSavedId(id);
    window.setTimeout(() => setSavedId((k) => (k === id ? null : k)), 2000);
  }

  async function rename(m: MemoryMeta) {
    const name = window.prompt(t('assistant.advanced.renamePrompt'), m.name);
    if (name?.trim()) await renameMemory(m.id, name.trim());
  }

  async function remove(m: MemoryMeta) {
    if (!window.confirm(t('assistant.advanced.memoryDeleteConfirm', { name: m.name }))) return;
    await deleteMemory(m.id);
  }

  return (
    <div className="assistant-advanced__doc">
      <strong>{t('assistant.advanced.memoriesTitle')}</strong>
      {memories.map((m) => {
        const names = users[m.id] ?? [];
        const inUse = names.length > 0;
        return (
          <details key={m.id} className="as-memory c-card">
            <summary>
              {m.name}{' '}
              <span className="c-muted">
                {inUse
                  ? t('assistant.advanced.memoryUsers', { names: names.join(', ') })
                  : t('assistant.advanced.memoryUnused')}
              </span>
            </summary>
            <div className="as-memory__body">
              <textarea
                className="c-input assistant-textarea assistant-textarea--doc"
                rows={8}
                value={texts[m.id] ?? ''}
                onChange={(e) => setTexts((prev) => ({ ...prev, [m.id]: e.target.value }))}
              />
              <div className="awizard-actions">
                <Button onClick={() => void save(m.id)}>{t('common.save')}</Button>
                <Button onClick={() => void rename(m)}>{t('assistant.advanced.rename')}</Button>
                <Button
                  variant="danger"
                  disabled={inUse}
                  title={inUse ? t('assistant.advanced.memoryDeleteBlocked') : undefined}
                  onClick={() => void remove(m)}
                >
                  {t('common.delete')}
                </Button>
                {savedId === m.id && <span className="c-muted">{t('assistant.manage.saved')}</span>}
              </div>
              {inUse && <p className="c-muted">{t('assistant.advanced.memoryDeleteBlocked')}</p>}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/* ── Advanced: team competences (read-only) ──────────────────────────── */

function TeamCompetencesView() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setText(await api.readDoc('team-competences', 'global', 'competences').catch(() => ''));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function regenerate() {
    setBusy(true);
    try {
      await regenerateTeamCompetencesDoc();
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="assistant-advanced__doc">
      <strong>{t('assistant.advanced.teamCompetencesTitle')}</strong>
      <p className="c-muted">{t('assistant.advanced.teamCompetencesHint')}</p>
      <textarea
        className="c-input assistant-textarea assistant-textarea--doc"
        rows={8}
        value={text}
        readOnly
      />
      <div className="awizard-actions">
        <Button disabled={busy} onClick={() => void regenerate()}>
          {t('assistant.advanced.regenerate')}
        </Button>
      </div>
    </div>
  );
}

/* ── Panel root ──────────────────────────────────────────────────────── */

type View =
  | { kind: 'main' }
  | { kind: 'newProfile' }
  | { kind: 'editProfile'; id: string }
  | { kind: 'newTeam' }
  | { kind: 'editTeam'; id: string };

interface ImportPending {
  data: ProfileExport;
  includeMemory: boolean;
}

export function AssistantSettings() {
  const { t, i18n } = useTranslation();
  const [ready, setReady] = useState(false);
  const [hw, setHw] = useState<api.AssistantHwInfo | null>(null);
  const [installed, setInstalled] = useState<api.InstalledModel[]>([]);
  const [pstate, setPState] = useState<ProfilesState>(() => getProfilesState());
  const [ask, setAsk] = useState(true);
  const [deleg, setDeleg] = useState(true);
  const [suggestions, setSuggestions] = useState<CompetenceSuggestion[]>([]);
  const [view, setView] = useState<View>({ kind: 'main' });
  const [sectionOpen, setSectionOpen] = useState(false);
  const [editingPersona, setEditingPersona] = useState(false);
  const [importPending, setImportPending] = useState<ImportPending | null>(null);
  const [status, setStatus] = useState('');

  const toolOptions = useMemo<ToolOption[]>(
    () =>
      Object.entries(toolFactories)
        .filter(([id]) => id !== 'assistant')
        .map(([id, factory]) => ({ id, nameKey: factory().manifest.nameKey })),
    [],
  );
  const toolNames = useMemo(
    () => new Map(toolOptions.map((o) => [o.id, t(o.nameKey)])),
    [toolOptions, t],
  );

  const syncProfiles = useCallback(() => {
    setPState(getProfilesState());
  }, []);

  const refreshSuggestions = useCallback(() => {
    try {
      setSuggestions(competenceSuggestions());
    } catch {
      setSuggestions([]);
    }
  }, []);

  const refreshModels = useCallback(async () => {
    setInstalled(await api.listModels().catch(() => []));
  }, []);

  useEffect(() => {
    let alive = true;
    const off = onProfilesChange((s) => {
      if (!alive) return;
      setPState(s);
      refreshSuggestions();
    });
    void (async () => {
      await initProfiles();
      if (!alive) return;
      syncProfiles();
      const [hwInfo, models, askValue, delegValue] = await Promise.all([
        api.fetchHwInfo(),
        api.listModels().catch(() => []),
        getAskBeforeExecute(),
        getDelegationAsk(),
      ]);
      if (!alive) return;
      setHw(hwInfo);
      setInstalled(models);
      setAsk(askValue);
      setDeleg(delegValue);
      refreshSuggestions();
      setReady(true);
    })();
    return () => {
      alive = false;
      off();
    };
  }, [syncProfiles, refreshSuggestions]);

  const rated = useMemo(() => (hw ? rateModels(hw) : []), [hw]);
  const installedIds = useMemo(() => installed.map((m) => m.id), [installed]);

  const active: ActiveSelection = pstate.active;
  const activeProfile =
    active.type === 'profile'
      ? (pstate.profiles.find((p) => p.id === active.id) ?? pstate.profiles[0] ?? null)
      : null;
  const activeTeam =
    active.type === 'team' ? (pstate.teams.find((tm) => tm.id === active.id) ?? null) : null;

  const editingProfile =
    view.kind === 'editProfile' ? (pstate.profiles.find((p) => p.id === view.id) ?? null) : null;
  const editingTeam =
    view.kind === 'editTeam' ? (pstate.teams.find((tm) => tm.id === view.id) ?? null) : null;

  const closeView = useCallback(() => setView({ kind: 'main' }), []);

  /* ── actions ── */

  async function activate(sel: ActiveSelection) {
    await setActive(sel);
    syncProfiles();
  }

  async function duplicate(p: AssistantProfile) {
    const suggested = t('assistant.profiles.duplicateName', { name: p.name });
    const name = window.prompt(t('assistant.profiles.duplicatePrompt'), suggested);
    if (name?.trim()) await duplicateProfile(p.id, name.trim());
  }

  async function removeProfile(p: AssistantProfile) {
    if (!window.confirm(t('assistant.profiles.deleteConfirm', { name: p.name }))) return;
    await deleteProfile(p.id);
  }

  async function removeTeam(team: AssistantTeam) {
    if (!window.confirm(t('assistant.teams.deleteConfirm', { name: team.name }))) return;
    await deleteTeam(team.id);
  }

  async function exportOne(p: AssistantProfile) {
    try {
      const data = await exportProfile(p.id);
      const safe =
        p.name
          .toLowerCase()
          .replace(/[^a-z0-9äöüß]+/gi, '-')
          .replace(/^-+|-+$/g, '') || 'assistent';
      // Same file mechanism as the diagnose report export (no extra plugins).
      const path = await invoke<string>('export_report', {
        filename: `cardo-assistant-${safe}.json`,
        content: JSON.stringify(data, null, 2),
      });
      setStatus(t('assistant.profiles.exportedTo', { path }));
    } catch {
      setStatus(t('assistant.manage.error'));
    }
  }

  function onPickImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as ProfileExport;
        if (typeof parsed?.profile?.name !== 'string') throw new Error('invalid profile export');
        setImportPending({ data: parsed, includeMemory: true });
      } catch {
        setStatus(t('assistant.profiles.importError'));
      }
    };
    reader.onerror = () => setStatus(t('assistant.profiles.importError'));
    reader.readAsText(file);
  }

  async function confirmImport() {
    if (!importPending) return;
    try {
      await importProfile(importPending.data, { includeMemory: importPending.includeMemory });
      setImportPending(null);
    } catch {
      setStatus(t('assistant.profiles.importError'));
    }
  }

  async function applyModel(id: string) {
    if (!activeProfile) return;
    await updateProfile(activeProfile.id, { modelId: id });
  }

  async function savePersonaDocs(p: AssistantPersona) {
    if (!activeProfile) return;
    const lang = resolveDocLanguage(p, i18n.language);
    await api.writeDoc('profile', activeProfile.id, 'personality', generatePersonality(p, lang));
    const name = p.assistantName.trim();
    if (name && name !== activeProfile.name) await updateProfile(activeProfile.id, { name });
    setEditingPersona(false);
  }

  /* ── render ── */

  if (!ready) {
    return (
      <div className="settings__section assistant-settings">
        <p className="c-muted">{t('common.loading')}</p>
      </div>
    );
  }

  // First run: no profiles yet → the creation flow doubles as the wizard
  // (system check inside the model step, download before creation).
  if (pstate.profiles.length === 0) {
    return (
      <div className="settings__section assistant-settings">
        <NewAssistantFlow
          firstRun
          memories={pstate.memories}
          installedIds={installedIds}
          rated={rated}
          hw={hw}
          toolOptions={toolOptions}
          onClose={() => {
            syncProfiles();
            void refreshModels();
          }}
        />
      </div>
    );
  }

  const activeModelEntry = activeProfile ? modelById(activeProfile.modelId) : null;

  return (
    <div className="settings__section assistant-settings">
      {/* 1 ── active assistant / team */}
      {activeTeam ? (
        <div className="as-active c-card">
          <Avatar emoji={activeTeam.emoji} color={activeTeam.color} />
          <div className="as-active__info">
            <span className="c-muted">{t('assistant.profiles.activeTeamTitle')}</span>
            <strong>{activeTeam.name}</strong>
            <span className="c-muted">
              {t('assistant.teams.membersLine', {
                names: activeTeam.memberIds
                  .map((id: string) => pstate.profiles.find((p) => p.id === id)?.name)
                  .filter(Boolean)
                  .join(', '),
              })}
              {' · '}
              {t('assistant.teams.leaderLine', {
                name: pstate.profiles.find((p) => p.id === activeTeam.leaderId)?.name ?? '–',
              })}
            </span>
            <div className="as-badges">
              <MemoryBadge memoryId={activeTeam.memoryId} memories={pstate.memories} />
            </div>
          </div>
        </div>
      ) : activeProfile ? (
        <div className="as-active c-card">
          <Avatar emoji={activeProfile.emoji} color={activeProfile.color} />
          <div className="as-active__info">
            <span className="c-muted">{t('assistant.profiles.activeTitle')}</span>
            <strong>{activeProfile.name}</strong>
            <span className="c-muted">
              {activeModelEntry?.label ?? `${activeProfile.modelId} (${t('assistant.profiles.modelMissing')})`}
            </span>
            <div className="as-badges">
              <MemoryBadge memoryId={activeProfile.memoryId} memories={pstate.memories} />
            </div>
          </div>
        </div>
      ) : null}

      {/* 2 ── more assistants & teams */}
      <details
        className="as-collapse"
        open={sectionOpen || view.kind !== 'main'}
        onToggle={(e) => setSectionOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>{t('assistant.profiles.sectionTitle')}</summary>
        <div className="as-collapse__body">
          <p className="c-muted">{t('assistant.profiles.sectionIntro')}</p>

          {view.kind === 'main' && (
            <>
              <div className="as-list">
                {pstate.profiles.map((p) => {
                  const isActive = active.type === 'profile' && active.id === p.id;
                  const entry = modelById(p.modelId);
                  return (
                    <div key={p.id} className="as-card c-card">
                      <Avatar emoji={p.emoji} color={p.color} />
                      <div className="as-card__info">
                        <strong>{p.name}</strong>
                        <span className="c-muted">
                          {entry?.label ?? p.modelId}
                          {!installedIds.includes(p.modelId) &&
                            ` – ${t('assistant.profiles.modelMissing')}`}
                        </span>
                        <div className="as-badges">
                          <MemoryBadge memoryId={p.memoryId} memories={pstate.memories} />
                          {isActive && (
                            <span className="assistant-badge assistant-badge--great">
                              {t('assistant.manage.active')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="as-card__actions">
                        {!isActive && (
                          <Button onClick={() => void activate({ type: 'profile', id: p.id })}>
                            {t('assistant.profiles.activate')}
                          </Button>
                        )}
                        <Button onClick={() => setView({ kind: 'editProfile', id: p.id })}>
                          {t('assistant.widget.edit')}
                        </Button>
                        <Button onClick={() => void duplicate(p)}>
                          {t('assistant.profiles.duplicate')}
                        </Button>
                        <Button onClick={() => void exportOne(p)}>
                          {t('assistant.profiles.export')}
                        </Button>
                        <Button variant="danger" onClick={() => void removeProfile(p)}>
                          {t('common.delete')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="awizard-actions">
                <Button variant="primary" onClick={() => setView({ kind: 'newProfile' })}>
                  {t('assistant.profiles.new')}
                </Button>
                <label className="c-btn as-file-button">
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="as-file-input"
                    onChange={onPickImportFile}
                  />
                  {t('assistant.profiles.import')}
                </label>
              </div>

              {importPending && (
                <div className="as-consent c-card">
                  <strong>{t('assistant.profiles.importTitle')}</strong>
                  <p>
                    {t('assistant.profiles.importConfirm', {
                      name: importPending.data.profile.name,
                    })}
                  </p>
                  <label className="awizard-choice">
                    <input
                      type="checkbox"
                      checked={importPending.includeMemory}
                      onChange={(e) =>
                        setImportPending({ ...importPending, includeMemory: e.target.checked })
                      }
                    />
                    {t('assistant.profiles.importMemory')}
                  </label>
                  <div className="awizard-actions">
                    <Button variant="primary" onClick={() => void confirmImport()}>
                      {t('assistant.profiles.import')}
                    </Button>
                    <Button variant="ghost" onClick={() => setImportPending(null)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              )}

              <h4 className="as-subtitle">{t('assistant.teams.title')}</h4>
              <div className="as-list">
                {pstate.teams.map((team) => {
                  const isActive = active.type === 'team' && active.id === team.id;
                  return (
                    <div key={team.id} className="as-card c-card">
                      <Avatar emoji={team.emoji} color={team.color} />
                      <div className="as-card__info">
                        <strong>{team.name}</strong>
                        <span className="c-muted">
                          {t('assistant.teams.membersLine', {
                            names: team.memberIds
                              .map((id: string) => pstate.profiles.find((p) => p.id === id)?.name)
                              .filter(Boolean)
                              .join(', '),
                          })}
                        </span>
                        <div className="as-badges">
                          <MemoryBadge memoryId={team.memoryId} memories={pstate.memories} />
                          {isActive && (
                            <span className="assistant-badge assistant-badge--great">
                              {t('assistant.manage.active')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="as-card__actions">
                        {!isActive && (
                          <Button onClick={() => void activate({ type: 'team', id: team.id })}>
                            {t('assistant.profiles.activate')}
                          </Button>
                        )}
                        <Button onClick={() => setView({ kind: 'editTeam', id: team.id })}>
                          {t('assistant.widget.edit')}
                        </Button>
                        <Button variant="danger" onClick={() => void removeTeam(team)}>
                          {t('common.delete')}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="awizard-actions">
                <Button
                  disabled={pstate.profiles.length < 2}
                  onClick={() => setView({ kind: 'newTeam' })}
                >
                  {t('assistant.teams.new')}
                </Button>
              </div>
              {pstate.profiles.length < 2 && (
                <p className="c-muted">{t('assistant.teams.needTwo')}</p>
              )}
              {status && <p className="c-muted">{status}</p>}
            </>
          )}

          {view.kind === 'newProfile' && (
            <NewAssistantFlow
              memories={pstate.memories}
              installedIds={installedIds}
              rated={rated}
              hw={hw}
              toolOptions={toolOptions}
              onClose={() => {
                closeView();
                void refreshModels();
              }}
            />
          )}

          {editingProfile && (
            <ProfileEditor
              profile={editingProfile}
              toolOptions={toolOptions}
              installedIds={installedIds}
              onClose={closeView}
            />
          )}

          {view.kind === 'newTeam' && (
            <TeamForm
              initial={null}
              profiles={pstate.profiles}
              memories={pstate.memories}
              onClose={closeView}
            />
          )}

          {editingTeam && (
            <TeamForm
              initial={editingTeam}
              profiles={pstate.profiles}
              memories={pstate.memories}
              onClose={closeView}
            />
          )}
        </div>
      </details>

      {/* 3 ── global model management */}
      <div className="settings__row settings__row--block">
        <span>{t('assistant.manage.models')}</span>
        {rated.map((r) => {
          const entry = r.model;
          const usedByNames = pstate.profiles
            .filter((p) => p.modelId === entry.id)
            .map((p) => p.name);
          return (
            <ModelManageRow
              key={entry.id}
              rated={r}
              entry={entry}
              installed={installedIds.includes(entry.id)}
              isActiveModel={activeProfile?.modelId === entry.id}
              usedByNames={usedByNames}
              canUse={activeProfile !== null && activeProfile.modelId !== entry.id}
              onUse={() => void applyModel(entry.id)}
              onChanged={() => void refreshModels()}
            />
          );
        })}
      </div>

      {/* 4 ── competence learning banner */}
      <CompetenceBanner
        suggestions={suggestions}
        profiles={pstate.profiles}
        toolNames={toolNames}
        onHandled={() => void refreshSuggestions()}
      />

      {/* 5 ── global toggles */}
      <div className="settings__row settings__row--block">
        <label className="awizard-choice">
          <input
            type="checkbox"
            checked={ask}
            onChange={(e) => {
              setAsk(e.target.checked);
              void setAskBeforeExecute(e.target.checked);
            }}
          />
          {t('assistant.manage.askBeforeExecute')}
        </label>
        <p className="c-muted">{t('assistant.manage.askBeforeExecuteHint')}</p>
        <label className="awizard-choice">
          <input
            type="checkbox"
            checked={deleg}
            onChange={(e) => {
              setDeleg(e.target.checked);
              void setDelegationAsk(e.target.checked);
            }}
          />
          {t('assistant.manage.delegationAsk')}
        </label>
        <p className="c-muted">{t('assistant.manage.delegationAskHint')}</p>
      </div>

      {/* customize (persona of the active assistant, v0.3 parity) */}
      {activeProfile && (
        <div className="settings__row settings__row--block">
          <span>{t('assistant.manage.persona')}</span>
          {editingPersona ? (
            <PersonaForm
              initial={{ ...defaultPersona(), assistantName: activeProfile.name }}
              submitLabel={t('common.save')}
              onSubmit={(p) => void savePersonaDocs(p)}
              onCancel={() => setEditingPersona(false)}
            />
          ) : (
            <div className="settings__help-actions">
              <Button onClick={() => setEditingPersona(true)}>
                {t('assistant.manage.customize')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 6 ── advanced */}
      <details className="assistant-advanced">
        <summary>{t('assistant.manage.advanced')}</summary>
        <p className="c-muted">{t('assistant.advanced.hint')}</p>
        {pstate.profiles.length > 0 && <ProfileDocs profiles={pstate.profiles} />}
        <MemoryManager memories={pstate.memories} />
        {pstate.teams.length > 0 && <TeamCompetencesView />}
      </details>
    </div>
  );
}
