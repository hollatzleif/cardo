import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@cardo/ui';
import * as api from './api';
import { generateInstructions, generatePersonality, resolveDocLanguage } from './docs';
import {
  MODEL_CATALOG,
  rateModels,
  type ModelDef,
  type ModelRating,
  type RatedModel,
} from './models';
import {
  defaultPersona,
  getAskBeforeExecute,
  getPersona,
  getSelectedModelId,
  setAskBeforeExecute,
  setPersona,
  setSelectedModelId,
  type AssistantPersona,
  type PersonaLanguage,
  type PersonaStyle,
} from './store';
import './assistant.css';

/**
 * Assistant settings tab: first-run wizard (system check → download →
 * persona → done) and the management view (models, askBeforeExecute,
 * persona editing, advanced doc access).
 */

function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function ramGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
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

/* ── Persona form (wizard step 3 + "Assistent anpassen") ─────────────── */

function PersonaForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: AssistantPersona | null;
  submitLabel: string;
  onSubmit(persona: AssistantPersona): void;
  onCancel?: () => void;
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
      <div className="awizard-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
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

/* ── Wizard ──────────────────────────────────────────────────────────── */

type WizardStep = 'check' | 'download' | 'persona' | 'done';

function DownloadStep({
  model,
  alreadyInstalled,
  onReady,
  onBack,
}: {
  model: ModelDef;
  alreadyInstalled: boolean;
  onReady(): void;
  onBack(): void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'downloading' | 'loading' | 'error'>('downloading');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    let active = true;
    const off = api.onDownloadProgress((p) => {
      if (active && p.id === model.id) setProgress({ done: p.downloadedBytes, total: p.totalBytes });
    });
    void (async () => {
      try {
        if (!alreadyInstalled) await api.downloadModel(model.id, model.url);
        if (!active) return;
        setPhase('loading'); // smoke test: the model must actually load
        await api.loadModel(model.id);
        if (active) onReady();
      } catch {
        if (active) setPhase('error');
      }
    })();
    return () => {
      active = false;
      off();
    };
  }, [model, alreadyInstalled, onReady]);

  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="awizard-step">
      <h4>{t('assistant.wizard.downloadTitle', { model: model.label })}</h4>
      {phase === 'downloading' && (
        <>
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
                void api.cancelDownload(model.id).catch(() => {});
                onBack();
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </>
      )}
      {phase === 'loading' && <p className="c-muted">{t('assistant.wizard.loadSmoke')}</p>}
      {phase === 'error' && (
        <>
          <p className="assistant-error">{t('assistant.wizard.downloadError')}</p>
          <div className="awizard-actions">
            <Button onClick={onBack}>{t('assistant.wizard.back')}</Button>
          </div>
        </>
      )}
    </div>
  );
}

function Wizard({
  hw,
  installedIds,
  onFinished,
}: {
  hw: api.AssistantHwInfo;
  installedIds: string[];
  onFinished(): void;
}) {
  const { t, i18n } = useTranslation();
  const rated = useMemo(() => rateModels(hw), [hw]);
  const recommendedId = rated.find((r) => r.recommended)?.model.id ?? null;
  const [step, setStep] = useState<WizardStep>('check');
  const [choice, setChoice] = useState<string | null>(recommendedId);

  const chosen = rated.find((r) => r.model.id === choice) ?? null;

  const finishPersona = useCallback(
    async (persona: AssistantPersona) => {
      if (!chosen) return;
      await setPersona(persona);
      await setSelectedModelId(chosen.model.id);
      const lang = resolveDocLanguage(persona, i18n.language);
      await api.writeDoc('personality', generatePersonality(persona, lang));
      await api.writeDoc('instructions', generateInstructions(lang));
      setStep('done');
    },
    [chosen, i18n.language],
  );

  const toPersona = useCallback(() => setStep('persona'), []);
  const backToCheck = useCallback(() => setStep('check'), []);

  if (step === 'check') {
    return (
      <div className="awizard-step">
        <h4>{t('assistant.wizard.checkTitle')}</h4>
        <p className="c-muted">
          {t('assistant.wizard.checkIntro', {
            ram: ramGb(hw.totalRamMb),
            cores: hw.cpuCores,
            chip: hw.appleSilicon ? 'Apple Silicon' : hw.arch,
          })}
        </p>
        <div className="awizard-models">
          {rated.map((r) => {
            const disabled = r.rating === 'tooBig';
            return (
              <button
                key={r.model.id}
                className={`awizard-model${choice === r.model.id ? ' awizard-model--selected' : ''}${
                  disabled ? ' awizard-model--disabled' : ''
                }`}
                disabled={disabled}
                onClick={() => setChoice(r.model.id)}
              >
                <strong>
                  {r.recommended && '⭐ '}
                  {r.model.label}
                </strong>
                {r.recommended && (
                  <span className="c-muted"> · {t('assistant.wizard.recommended')}</span>
                )}
                <span className="c-muted awizard-model__meta">
                  {gb(r.model.sizeBytes)} · {t('assistant.model.ramNeed', { ram: ramGb(r.model.ramNeedMb) })}
                </span>
                <RatingBadge rated={r} />
              </button>
            );
          })}
        </div>
        <div className="awizard-actions">
          <Button variant="primary" disabled={!chosen} onClick={() => setStep('download')}>
            {t('assistant.wizard.continue')}
          </Button>
        </div>
      </div>
    );
  }

  if (step === 'download' && chosen) {
    return (
      <DownloadStep
        model={chosen.model}
        alreadyInstalled={installedIds.includes(chosen.model.id)}
        onReady={toPersona}
        onBack={backToCheck}
      />
    );
  }

  if (step === 'persona') {
    return (
      <div className="awizard-step">
        <h4>{t('assistant.wizard.personaTitle')}</h4>
        <PersonaForm
          initial={null}
          submitLabel={t('assistant.wizard.finish')}
          onSubmit={(p) => void finishPersona(p)}
        />
      </div>
    );
  }

  return (
    <div className="awizard-step">
      <h4>{t('assistant.wizard.doneTitle')}</h4>
      <p>{t('assistant.wizard.doneBody')}</p>
      <div className="awizard-actions">
        <Button variant="primary" onClick={onFinished}>
          {t('common.ok')}
        </Button>
      </div>
    </div>
  );
}

/* ── Management view ─────────────────────────────────────────────────── */

function ModelRow({
  rated,
  installed,
  active,
  onInstalled,
  onUse,
  onDelete,
}: {
  rated: RatedModel;
  installed: boolean;
  active: boolean;
  onInstalled(): void;
  onUse(): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);
  const [pct, setPct] = useState(0);
  const [failed, setFailed] = useState(false);
  const model = rated.model;

  useEffect(
    () =>
      api.onDownloadProgress((p) => {
        if (p.id === model.id && p.totalBytes > 0) {
          setPct(Math.round((p.downloadedBytes / p.totalBytes) * 100));
        }
      }),
    [model.id],
  );

  async function install() {
    setDownloading(true);
    setFailed(false);
    setPct(0);
    try {
      await api.downloadModel(model.id, model.url);
      onInstalled();
    } catch {
      setFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="assistant-modelrow c-card">
      <div className="assistant-modelrow__info">
        <strong>{model.label}</strong>
        {active && <span className="assistant-badge assistant-badge--great">{t('assistant.manage.active')}</span>}
        <span className="c-muted">
          {gb(model.sizeBytes)} · {t('assistant.model.ramNeed', { ram: ramGb(model.ramNeedMb) })}
        </span>
        <RatingBadge rated={rated} />
        {failed && <span className="assistant-error">{t('assistant.manage.error')}</span>}
      </div>
      <div className="assistant-modelrow__actions">
        {downloading ? (
          <>
            <div className="awizard-progress assistant-modelrow__progress">
              <div className="awizard-progress__fill" style={{ width: `${pct}%` }} />
            </div>
            <Button
              variant="ghost"
              onClick={() => void api.cancelDownload(model.id).catch(() => {})}
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : installed ? (
          <>
            {!active && <Button onClick={onUse}>{t('assistant.manage.use')}</Button>}
            <Button variant="danger" disabled={active} onClick={onDelete}>
              {t('common.delete')}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            disabled={rated.rating === 'tooBig'}
            onClick={() => void install()}
          >
            {t('assistant.manage.install')}
          </Button>
        )}
      </div>
    </div>
  );
}

function AdvancedDocs() {
  const { t } = useTranslation();
  const kinds: api.AssistantDocKind[] = ['instructions', 'personality', 'memory'];
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [savedKind, setSavedKind] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const loaded: Record<string, string> = {};
      for (const kind of kinds) loaded[kind] = await api.readDoc(kind).catch(() => '');
      if (active) setTexts(loaded);
    })();
    return () => {
      active = false;
    };
    // kinds is a constant list – no need to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(kind: api.AssistantDocKind) {
    await api.writeDoc(kind, texts[kind] ?? '');
    setSavedKind(kind);
    window.setTimeout(() => setSavedKind((k) => (k === kind ? null : k)), 2000);
  }

  return (
    <details className="assistant-advanced">
      <summary>{t('assistant.manage.advanced')}</summary>
      <p className="c-muted">{t('assistant.manage.advancedHint')}</p>
      {kinds.map((kind) => (
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
    </details>
  );
}

/* ── Panel root ──────────────────────────────────────────────────────── */

export function AssistantSettings() {
  const { t, i18n } = useTranslation();
  const [ready, setReady] = useState(false);
  const [hw, setHw] = useState<api.AssistantHwInfo | null>(null);
  const [installed, setInstalled] = useState<api.InstalledModel[]>([]);
  const [persona, setPersonaState] = useState<AssistantPersona | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ask, setAsk] = useState(true);
  const [wizardActive, setWizardActive] = useState(false);
  const [editingPersona, setEditingPersona] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [hwInfo, models, p, sel, askValue] = await Promise.all([
      api.fetchHwInfo(),
      api.listModels(),
      getPersona(),
      getSelectedModelId(),
      getAskBeforeExecute(),
    ]);
    setHw(hwInfo);
    setInstalled(models);
    setPersonaState(p);
    setSelected(sel);
    setAsk(askValue);
    setWizardActive((active) => active || (models.length === 0 && p === null));
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rated = useMemo(() => (hw ? rateModels(hw) : []), [hw]);
  const installedIds = useMemo(() => installed.map((m) => m.id), [installed]);
  const activeModel = MODEL_CATALOG.find((m) => m.id === selected) ?? null;

  const finishWizard = useCallback(() => {
    setWizardActive(false);
    void refresh();
  }, [refresh]);

  if (!ready || !hw) {
    return (
      <div className="settings__section assistant-settings">
        <p className="c-muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (wizardActive) {
    return (
      <div className="settings__section assistant-settings">
        <Wizard hw={hw} installedIds={installedIds} onFinished={finishWizard} />
      </div>
    );
  }

  async function savePersona(p: AssistantPersona) {
    await setPersona(p);
    // Persona edits regenerate personality.md only – instructions.md is untouched.
    const lang = resolveDocLanguage(p, i18n.language);
    await api.writeDoc('personality', generatePersonality(p, lang));
    setEditingPersona(false);
    await refresh();
  }

  async function applySwitch(mode: 'keep' | 'fresh') {
    const id = switchTarget;
    if (!id) return;
    if (mode === 'fresh') {
      const p = persona ?? defaultPersona();
      const lang = resolveDocLanguage(p, i18n.language);
      await api.writeDoc('personality', generatePersonality(p, lang));
      await api.writeDoc('instructions', generateInstructions(lang));
      await api.writeDoc('memory', '');
    }
    await setSelectedModelId(id);
    try {
      await api.loadModel(id);
    } catch {
      // load errors surface on first use; switching stays persisted
    }
    setSwitchTarget(null);
    await refresh();
  }

  async function removeModel(id: string) {
    if (!window.confirm(t('assistant.manage.deleteConfirm'))) return;
    await api.deleteModel(id).catch(() => {});
    await refresh();
  }

  const switchModel = switchTarget ? MODEL_CATALOG.find((m) => m.id === switchTarget) : null;

  return (
    <div className="settings__section assistant-settings">
      <div className="settings__row settings__row--block">
        <span>{t('assistant.manage.currentModel')}</span>
        <p>{activeModel ? activeModel.label : <span className="c-muted">{t('assistant.manage.noModel')}</span>}</p>
      </div>

      <div className="settings__row settings__row--block">
        <span>{t('assistant.manage.models')}</span>
        {rated.map((r) => (
          <ModelRow
            key={r.model.id}
            rated={r}
            installed={installedIds.includes(r.model.id)}
            active={selected === r.model.id}
            onInstalled={() => void refresh()}
            onUse={() => setSwitchTarget(r.model.id)}
            onDelete={() => void removeModel(r.model.id)}
          />
        ))}
      </div>

      {switchModel && (
        <div className="assistant-switch c-card">
          <strong>{t('assistant.manage.switchTitle', { model: switchModel.label })}</strong>
          <button className="assistant-switch__option" onClick={() => void applySwitch('keep')}>
            <strong>{t('assistant.manage.switchKeep')}</strong>
            <span className="c-muted">{t('assistant.manage.switchKeepHint')}</span>
          </button>
          <button className="assistant-switch__option" onClick={() => void applySwitch('fresh')}>
            <strong>{t('assistant.manage.switchFresh')}</strong>
            <span className="c-muted">{t('assistant.manage.switchFreshHint')}</span>
          </button>
          <div className="awizard-actions">
            <Button variant="ghost" onClick={() => setSwitchTarget(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

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
      </div>

      <div className="settings__row settings__row--block">
        <span>{t('assistant.manage.persona')}</span>
        {editingPersona ? (
          <PersonaForm
            initial={persona}
            submitLabel={t('common.save')}
            onSubmit={(p) => void savePersona(p)}
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

      <AdvancedDocs />
    </div>
  );
}
