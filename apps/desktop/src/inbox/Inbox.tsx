import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cardo/ui';
import {
  getInboxState,
  getVoted,
  markAllSeen,
  onInboxChange,
  refreshFeed,
  setInboxEnabled,
  votePoll,
  type FeedItem,
} from './feed';

function lang(map: Record<string, string> | undefined, language: string): string {
  if (!map) return '';
  return map[language.startsWith('de') ? 'de' : 'en'] ?? map.en ?? '';
}

function PollItem({ item }: { item: FeedItem }) {
  const { t, i18n } = useTranslation();
  const [voted, setVoted] = useState<string | null>(null);
  useEffect(() => {
    void getVoted().then((v) => setVoted(v[item.id] ?? null));
  }, [item.id]);

  const total = item.results?.total ?? 0;
  const showResults = Boolean(voted) || !item.open;

  return (
    <div className="inbox__item">
      <strong>{lang(item.payload.question, i18n.language)}</strong>
      {!item.open && <span className="c-muted"> · {t('polls.closed')}</span>}
      <div className="inbox__options">
        {(item.payload.options ?? []).map((option) => {
          const count = item.results?.counts[option.id] ?? 0;
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          return showResults ? (
            <div key={option.id} className="polls__result">
              <div className="polls__result-label">
                <span>
                  {lang(option.label, i18n.language)}
                  {voted === option.id ? ' ✓' : ''}
                </span>
                <span className="c-muted">
                  {pct}% ({count})
                </span>
              </div>
              <div className="polls__bar">
                <div className="polls__bar-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          ) : (
            <Button
              key={option.id}
              onClick={() =>
                void votePoll(item.id, option.id).then((ok) => ok && setVoted(option.id))
              }
            >
              {lang(option.label, i18n.language)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** Inbox dropdown: announcements + votable polls from the feed. */
export function Inbox({ onClose }: { onClose(): void }) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState(getInboxState());

  useEffect(() => onInboxChange(setState), []);
  useEffect(() => {
    if (state.enabled) {
      void refreshFeed().then(() => void markAllSeen());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.enabled]);

  return (
    <>
      <div className="inbox__backdrop" onClick={onClose} />
      <div className="c-card inbox__panel">
        <header className="inbox__header">
          <strong>{t('inbox.title')}</strong>
          <button className="c-btn c-btn--ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        {!state.enabled ? (
          <div className="inbox__optin">
            <p>{t('inbox.optinIntro')}</p>
            <p className="c-muted">{t('inbox.privacyNote')}</p>
            <Button variant="primary" onClick={() => void setInboxEnabled(true)}>
              {t('inbox.enable')}
            </Button>
          </div>
        ) : (
          <div className="inbox__list">
            {state.error && <p className="c-muted">{t('polls.error')}</p>}
            {!state.error && state.loaded && state.items.length === 0 && (
              <p className="c-muted">{t('inbox.empty')}</p>
            )}
            {!state.loaded && !state.error && <p className="c-muted">{t('common.loading')}</p>}
            {state.items.map((item) =>
              item.kind === 'announcement' ? (
                <div key={item.id} className="inbox__item">
                  <strong>{lang(item.payload.title, i18n.language)}</strong>
                  <p className="inbox__body">{lang(item.payload.body, i18n.language)}</p>
                  <span className="c-muted inbox__date">
                    {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
                      new Date(item.createdAt),
                    )}
                  </span>
                </div>
              ) : (
                <PollItem key={item.id} item={item} />
              ),
            )}
            <p className="c-muted inbox__footer">
              <button className="inbox__disable" onClick={() => void setInboxEnabled(false)}>
                {t('inbox.disable')}
              </button>
            </p>
          </div>
        )}
      </div>
    </>
  );
}
