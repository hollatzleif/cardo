import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import type { CommandSpec } from '@cardo/plugin-api';
import type { ScoredSearchResult } from '@cardo/core';
import { Modal, Button, Input } from '@cardo/ui';
import { getHost } from '../host';
import { useAppStore } from '../state/appStore';

/**
 * Command palette (Cmd/Ctrl+K). Consumes the same Command-API that
 * shortcuts, automations, self-tests and the future AI assistant use.
 */

type ParamField = {
  name: string;
  kind: 'string' | 'number' | 'boolean';
  required: boolean;
};

/** Introspects a ZodObject into a simple form model. */
function paramFields(schema: z.ZodType): ParamField[] {
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.entries(schema.shape as Record<string, z.ZodType>).map(([name, field]) => {
    let inner = field;
    let required = true;
    while (
      inner instanceof z.ZodOptional ||
      inner instanceof z.ZodDefault ||
      inner instanceof z.ZodNullable
    ) {
      required = false;
      inner = inner instanceof z.ZodDefault ? inner.removeDefault() : inner.unwrap();
    }
    const kind =
      inner instanceof z.ZodNumber ? 'number' : inner instanceof z.ZodBoolean ? 'boolean' : 'string';
    return { name, kind, required };
  });
}

export function CommandPalette({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [pendingCommand, setPendingCommand] = useState<CommandSpec<never> | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), [pendingCommand]);

  // The assistant's "Bearbeiten" opens the palette prefilled for one command.
  useEffect(() => {
    const seed = useAppStore.getState().consumePaletteSeed();
    if (!seed) return;
    const spec = getHost()
      .commands.list()
      .find((c) => c.id === seed.commandId);
    if (!spec) return;
    setPendingCommand(spec);
    setValues(
      Object.fromEntries(
        Object.entries(seed.params).map(([k, v]) => [
          k,
          typeof v === 'boolean' ? v : String(v),
        ]),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commands = useMemo(() => getHost().commands.listForPalette(), []);
  const matches = useMemo(() => {
    const q = query.toLowerCase().trim();
    return commands
      .map((c) => ({ command: c, title: t(c.titleKey) }))
      .filter(({ command, title }) =>
        q === '' ? true : title.toLowerCase().includes(q) || command.id.includes(q),
      )
      .slice(0, 8);
  }, [commands, query, t]);

  // Global content search (tools' search providers), debounced.
  const [contentResults, setContentResults] = useState<ScoredSearchResult[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setContentResults([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void getHost()
        .search.query(q)
        .then(setContentResults)
        .catch(() => setContentResults([]));
    }, 150);
    return () => window.clearTimeout(handle);
  }, [query]);

  type Row =
    | { kind: 'command'; command: CommandSpec<never>; title: string }
    | { kind: 'result'; result: ScoredSearchResult };
  const rows: Row[] = useMemo(
    () => [
      ...matches.map((m) => ({ kind: 'command' as const, ...m })),
      ...contentResults.map((result) => ({ kind: 'result' as const, result })),
    ],
    [matches, contentResults],
  );

  async function pick(row: Row) {
    if (row.kind === 'command') return run(row.command);
    await row.result.action();
    onClose();
  }

  async function run(command: CommandSpec<never>) {
    const fields = paramFields(command.params as z.ZodType);
    if (fields.length > 0) {
      setPendingCommand(command);
      setValues({});
      return;
    }
    await getHost().commands.execute(command.id, {});
    onClose();
  }

  async function submitParams() {
    if (!pendingCommand) return;
    const fields = paramFields(pendingCommand.params as z.ZodType);
    const params: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (raw === undefined || raw === '') continue;
      params[f.name] = f.kind === 'number' ? Number(raw) : raw;
    }
    const result = await getHost().commands.execute(pendingCommand.id, params);
    if (result.ok) onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (pendingCommand) setPendingCommand(null);
      else onClose();
    } else if (!pendingCommand) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, rows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === 'Enter' && rows[selected]) {
        e.preventDefault();
        void pick(rows[selected]);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void submitParams();
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="palette" onKeyDown={onKeyDown}>
        {!pendingCommand ? (
          <>
            <Input
              ref={inputRef}
              className="palette__input"
              placeholder={t('palette.placeholder')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              autoFocus
            />
            <div className="palette__list">
              {rows.length === 0 && (
                <div className="c-muted palette__empty">{t('palette.noResults')}</div>
              )}
              {rows.map((row, i) => (
                <button
                  key={row.kind === 'command' ? row.command.id : `r-${i}-${row.result.title}`}
                  className={`palette__item${i === selected ? ' palette__item--selected' : ''}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => void pick(row)}
                >
                  {row.kind === 'command' ? (
                    <>
                      <span>{row.title}</span>
                      <span className="c-muted palette__id">{row.command.id}</span>
                    </>
                  ) : (
                    <>
                      <span>
                        {row.result.icon ? `${row.result.icon} ` : ''}
                        {row.result.title}
                      </span>
                      <span className="c-muted palette__id">
                        {row.result.subtitle ?? t(`tool.${row.result.toolId}.name`)}
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="palette__params">
            <h4>{t(pendingCommand.titleKey)}</h4>
            {paramFields(pendingCommand.params as z.ZodType).map((f) => (
              <label key={f.name} className="palette__param">
                <span>
                  {f.name}
                  {f.required ? ' *' : ''}
                </span>
                {f.kind === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={values[f.name] === true}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))}
                  />
                ) : (
                  <Input
                    type={f.kind === 'number' ? 'number' : 'text'}
                    value={(values[f.name] as string) ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    autoFocus
                  />
                )}
              </label>
            ))}
            <div className="palette__actions">
              <Button variant="ghost" onClick={() => setPendingCommand(null)}>
                {t('palette.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void submitParams()}>
                {t('palette.run')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
