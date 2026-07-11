import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import type { CommandSpec } from '@cardo/plugin-api';
import { Modal, Button, Input } from '@cardo/ui';
import { getHost } from '../host';

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

  const commands = useMemo(() => getHost().commands.listForPalette(), []);
  const matches = useMemo(() => {
    const q = query.toLowerCase().trim();
    return commands
      .map((c) => ({ command: c, title: t(c.titleKey) }))
      .filter(({ command, title }) =>
        q === '' ? true : title.toLowerCase().includes(q) || command.id.includes(q),
      )
      .slice(0, 12);
  }, [commands, query, t]);

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
        setSelected((s) => Math.min(s + 1, matches.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === 'Enter' && matches[selected]) {
        e.preventDefault();
        void run(matches[selected].command);
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
              {matches.length === 0 && (
                <div className="c-muted palette__empty">{t('palette.noResults')}</div>
              )}
              {matches.map(({ command, title }, i) => (
                <button
                  key={command.id}
                  className={`palette__item${i === selected ? ' palette__item--selected' : ''}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => void run(command)}
                >
                  <span>{title}</span>
                  <span className="c-muted palette__id">{command.id}</span>
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
