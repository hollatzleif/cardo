import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WidgetProps } from '@cardo/plugin-api';
import { Button } from '@cardo/ui';
import { getHost } from '../host';
import * as api from './api';
import { buildCommandCatalog, type CatalogSource } from './catalog';
import { resolveDocLanguage } from './docs';
import { requestPaletteEdit } from './hostBridge';
import { buildSystemPrompt } from './prompt';
import {
  appendMemory,
  executeProposal,
  parseProposals,
  type AssistantProposal,
} from './proposals';
import {
  getAskBeforeExecute,
  getPersona,
  getSelectedModelId,
  onAssistantSettingsChange,
  type AssistantPersona,
} from './store';
import './assistant.css';

/**
 * Braindump widget: thoughts in, concrete command proposals out.
 * Everything runs locally – the model answers with a strict JSON contract
 * which is parsed defensively and executed only via the command registry.
 */

type CardStatus = 'pending' | 'done' | 'failed' | 'dismissed' | 'edited';

interface ProposalCard {
  proposal: AssistantProposal;
  status: CardStatus;
  resultMessage?: string;
}

type Setup = 'loading' | 'missing' | 'ready';

export function AssistantWidget(_props: WidgetProps) {
  const { t, i18n } = useTranslation();
  const [setup, setSetup] = useState<Setup>('loading');
  const [persona, setPersona] = useState<AssistantPersona | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [cards, setCards] = useState<ProposalCard[]>([]);
  const [remembered, setRemembered] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [modelId, installed, p] = await Promise.all([
        getSelectedModelId(),
        api.listModels(),
        getPersona(),
      ]);
      setPersona(p);
      const usable = modelId !== null && installed.some((m) => m.id === modelId);
      setSetup(usable ? 'ready' : 'missing');
    } catch {
      setSetup('missing');
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAssistantSettingsChange(() => void refresh());
  }, [refresh]);

  async function send() {
    const text = input.trim();
    if (text === '' || busy) return;
    setBusy(true);
    setError(null);
    setReply(null);
    setCards([]);
    setRemembered([]);
    try {
      const modelId = await getSelectedModelId();
      if (!modelId) throw new Error('no model selected');
      if ((await api.loadedModel()) !== modelId) await api.loadModel(modelId);

      const [instructions, personality, memory] = await Promise.all([
        api.readDoc('instructions'),
        api.readDoc('personality'),
        api.readDoc('memory'),
      ]);
      const host = getHost();
      const catalog = buildCommandCatalog(
        host.commands.list() as unknown as CatalogSource[],
        (key) => String(t(key)),
      );
      const system = buildSystemPrompt({
        instructions,
        personality,
        memory,
        catalog,
        language: resolveDocLanguage(persona, i18n.language),
      });

      const raw = await api.generate({ system, user: text, maxTokens: 1024, jsonOnly: true });
      const parsed = parseProposals(raw, (id) => host.commands.has(id));
      if (parsed.parseError) {
        setError(t('assistant.widget.parseError'));
        return;
      }

      setReply(parsed.reply);
      setInput('');

      if (parsed.memory.length > 0) {
        await appendMemory(parsed.memory);
        setRemembered(parsed.memory);
      }

      if (await getAskBeforeExecute()) {
        setCards(parsed.proposals.map((proposal) => ({ proposal, status: 'pending' as const })));
      } else {
        // Auto-execute mode: run everything and render the outcomes.
        const executed: ProposalCard[] = [];
        for (const proposal of parsed.proposals) {
          const result = await executeProposal(proposal);
          executed.push({
            proposal,
            status: result.ok ? 'done' : 'failed',
            resultMessage: result.messageKey ? String(t(result.messageKey)) : undefined,
          });
        }
        setCards(executed);
      }
    } catch {
      setError(t('assistant.widget.generateError'));
    } finally {
      setBusy(false);
    }
  }

  function updateCard(index: number, patch: Partial<ProposalCard>) {
    setCards((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  async function accept(index: number) {
    const card = cards[index];
    if (!card || card.status !== 'pending') return;
    const result = await executeProposal(card.proposal);
    updateCard(index, {
      status: result.ok ? 'done' : 'failed',
      resultMessage: result.messageKey ? String(t(result.messageKey)) : undefined,
    });
  }

  function edit(index: number) {
    const card = cards[index];
    if (!card || card.status !== 'pending') return;
    requestPaletteEdit(card.proposal.command, card.proposal.params);
    updateCard(index, { status: 'edited' });
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  if (setup === 'loading') {
    return (
      <div className="assistant-root assistant-empty">
        <p className="c-muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (setup === 'missing') {
    return (
      <div className="assistant-root assistant-empty">
        <p className="c-muted">{t('assistant.widget.noModel')}</p>
      </div>
    );
  }

  const assistantName = persona?.assistantName || t('assistant.widget.defaultName');

  return (
    <div className="assistant-root">
      <header className="assistant-header">
        <strong>{assistantName}</strong>
        {busy && (
          <span className="assistant-header__busy">
            <span className="assistant-spinner" aria-hidden />
            <span className="c-muted">{t('assistant.widget.thinking')}</span>
          </span>
        )}
      </header>

      <div className="assistant-scroll">
        {error && <p className="assistant-error">{error}</p>}
        {reply !== null && reply !== '' && <p className="assistant-reply">{reply}</p>}

        {cards.map((card, index) => (
          <div key={`${card.proposal.command}-${index}`} className="assistant-card c-card">
            <p className="assistant-card__summary">{card.proposal.summary}</p>
            {card.status === 'pending' ? (
              <div className="assistant-card__actions">
                <Button variant="primary" onClick={() => void accept(index)}>
                  {t('assistant.widget.yes')}
                </Button>
                <Button onClick={() => edit(index)}>{t('assistant.widget.edit')}</Button>
                <Button variant="ghost" onClick={() => updateCard(index, { status: 'dismissed' })}>
                  {t('assistant.widget.no')}
                </Button>
              </div>
            ) : (
              <p
                className={`assistant-card__status${
                  card.status === 'done'
                    ? ' assistant-card__status--ok'
                    : card.status === 'failed'
                      ? ' assistant-card__status--fail'
                      : ''
                }`}
              >
                {card.status === 'done' && `✓ ${t('assistant.widget.done')}`}
                {card.status === 'failed' && `✗ ${t('assistant.widget.failed')}`}
                {card.status === 'dismissed' && t('assistant.widget.dismissed')}
                {card.status === 'edited' && t('assistant.widget.editSent')}
                {card.resultMessage ? ` · ${card.resultMessage}` : ''}
              </p>
            )}
          </div>
        ))}

        {remembered.length > 0 && (
          <p className="assistant-remembered">
            {t('assistant.widget.remembered', { items: remembered.join(' · ') })}
          </p>
        )}
      </div>

      <div className="assistant-composer">
        <textarea
          className="c-input assistant-input"
          placeholder={t('assistant.widget.placeholder')}
          value={input}
          rows={2}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onComposerKeyDown}
        />
        <Button
          variant="primary"
          disabled={busy || input.trim() === ''}
          onClick={() => void send()}
        >
          {t('assistant.widget.send')}
        </Button>
      </div>
    </div>
  );
}
