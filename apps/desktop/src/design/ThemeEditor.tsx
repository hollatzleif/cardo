import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, resolveTheme } from '@cardo/ui';
import { REQUIRED_PALETTE_TOKENS, type Theme } from '@cardo/themes';
import { useAppStore } from '../state/appStore';
import {
  customThemeLabel,
  deleteCustomTheme,
  deriveFrom,
  exportCustomTheme,
  parseImportedTheme,
  registerCustomThemes,
  saveCustomTheme,
} from './customThemes';

/**
 * Theme editor: derive a custom theme from the active one, tweak all 18
 * palette tokens with color inputs, save/apply/export/import/delete.
 * Custom themes resolve by id like built-ins (ui registry) and live in one
 * synced storage doc.
 */
export function ThemeEditorSection() {
  const { t } = useTranslation();
  const themeId = useAppStore((s) => s.themeId);
  const setTheme = useAppStore((s) => s.setTheme);
  const [customs, setCustoms] = useState<Theme[]>([]);
  const [draft, setDraft] = useState<Theme | null>(null);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');

  const refresh = useCallback(async () => {
    setCustoms(await registerCustomThemes());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startDraft = () => {
    const name = t('design.customThemes.defaultName');
    setDraftName(name);
    setDraft(deriveFrom(resolveTheme(themeId), name));
    setError(null);
  };

  const editExisting = (theme: Theme) => {
    setDraftName(customThemeLabel(theme));
    setDraft({ ...theme, palette: { ...theme.palette } });
    setError(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const named = deriveFrom(draft, draftName.trim() || draft.nameKey);
    // Keep the id when editing an existing custom theme (rename keeps identity
    // only when the name maps to the same slug – acceptable simplicity).
    const toSave: Theme = { ...named, id: draft.id.startsWith('custom-') ? draft.id : named.id, palette: draft.palette };
    toSave.nameKey = draftName.trim() || draft.nameKey;
    const problem = await saveCustomTheme(toSave);
    if (problem) {
      setError(problem);
      return;
    }
    setDraft(null);
    await refresh();
    await setTheme(toSave.id);
  };

  const doImport = async () => {
    const parsed = parseImportedTheme(importText);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    const problem = await saveCustomTheme(parsed);
    if (problem) {
      setError(problem);
      return;
    }
    setImportOpen(false);
    setImportText('');
    setError(null);
    await refresh();
  };

  return (
    <section className="design-section">
      <h4 className="design-section__title">{t('design.customThemes.title')}</h4>

      {customs.length > 0 && (
        <div className="design-custom-themes">
          {customs.map((theme) => (
            <div key={theme.id} className="design-custom-theme">
              <button
                className={`design-theme-swatch${theme.id === themeId ? ' design-theme-swatch--active' : ''}`}
                title={customThemeLabel(theme)}
                onClick={() => void setTheme(theme.id)}
                style={{ background: theme.palette.base, borderColor: theme.palette['accent-1'] }}
              >
                <span style={{ color: theme.palette.text }}>{customThemeLabel(theme)}</span>
                <span className="design-theme-dot" style={{ background: theme.palette['accent-1'] }} />
              </button>
              <div className="design-custom-theme__actions">
                <Button variant="ghost" onClick={() => editExisting(theme)}>
                  ✎
                </Button>
                <Button
                  variant="ghost"
                  title={t('design.customThemes.export')}
                  onClick={() => void navigator.clipboard.writeText(exportCustomTheme(theme))}
                >
                  ⧉
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(t('design.customThemes.deleteConfirm'))) {
                      void deleteCustomTheme(theme.id).then(refresh);
                    }
                  }}
                >
                  ✕
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!draft && (
        <div className="design-row">
          <Button onClick={startDraft}>{t('design.customThemes.new')}</Button>
          <Button variant="ghost" onClick={() => setImportOpen((v) => !v)}>
            {t('design.customThemes.import')}
          </Button>
        </div>
      )}

      {importOpen && !draft && (
        <div className="design-custom-import">
          <textarea
            className="c-input"
            rows={4}
            placeholder='{"nameKey": "Mein Theme", "palette": { … }}'
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <Button variant="primary" disabled={importText.trim() === ''} onClick={() => void doImport()}>
            {t('design.customThemes.importApply')}
          </Button>
        </div>
      )}

      {draft && (
        <div className="design-theme-editor">
          <label className="design-row">
            <span className="design-row__label">{t('design.customThemes.name')}</span>
            <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          </label>
          <label className="design-row">
            <span className="design-row__label">{t('design.customThemes.appearance')}</span>
            <select
              className="c-input"
              value={draft.appearance}
              onChange={(e) =>
                setDraft({ ...draft, appearance: e.target.value === 'light' ? 'light' : 'dark' })
              }
            >
              <option value="dark">{t('design.customThemes.dark')}</option>
              <option value="light">{t('design.customThemes.light')}</option>
            </select>
          </label>
          <div className="design-theme-editor__grid">
            {REQUIRED_PALETTE_TOKENS.map((token) => (
              <label key={token} className="design-theme-editor__field">
                <span>{token}</span>
                <input
                  type="color"
                  value={draft.palette[token]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      palette: { ...draft.palette, [token]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className="design-row">
            <Button variant="primary" onClick={() => void saveDraft()}>
              {t('design.customThemes.save')}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
    </section>
  );
}
