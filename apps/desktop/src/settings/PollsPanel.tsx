import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cardo/ui';
import { POLLS_WORKER_URL } from '../polls/config';
import { getVoted, votePoll, type FeedItem } from '../inbox/feed';

/**
 * Polls in settings (yellow feature): NOTHING is fetched until the user
 * presses the load button. The inbox (top-left) shows the same feed with
 * an opt-in for automatic checks; this panel is the manual, zero-
 * subscription view.
 */
export function PollsPanel() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('de') ? 'de' : 'en';
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [polls, setPolls] = useState<FeedItem[]>([]);
  const [voted, setVoted] = useState<Record<string, string>>({});

  useEffect(() => {
    void getVoted().then(setVoted);
  }, []);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const res = (await (await fetch(`${POLLS_WORKER_URL}/feed`)).json()) as {
        items: FeedItem[];
      };
      setPolls((res.items ?? []).filter((i) => i.kind === 'poll'));
      setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function vote(poll: FeedItem, optionId: string) {
    const ok = await votePoll(poll.id, optionId);
    if (!ok) {
      setError(true);
      return;
    }
    setVoted((v) => ({ ...v, [poll.id]: optionId }));
    await load();
  }

  if (!loaded) {
    return (
      <div className="settings__section">
        <p>{t('polls.intro')}</p>
        <p className="c-muted">{t('polls.privacyNote')}</p>
        <div className="settings__help-actions">
          <Button variant="primary" onClick={() => void load()} disabled={loading}>
            {loading ? t('common.loading') : t('polls.load')}
          </Button>
        </div>
        {error && <p className="c-muted">{t('polls.error')}</p>}
      </div>
    );
  }

  return (
    <div className="settings__section">
      {polls.length === 0 && <p className="c-muted">{t('polls.none')}</p>}
      {polls.map((poll) => {
        const myVote = voted[poll.id];
        const total = poll.results?.total ?? 0;
        const showResults = Boolean(myVote) || !poll.open;
        return (
          <div key={poll.id} className="c-card polls__item">
            <strong>{poll.payload.question?.[lang] ?? poll.payload.question?.en}</strong>
            {!poll.open && <span className="c-muted"> · {t('polls.closed')}</span>}
            <div className="polls__options">
              {(poll.payload.options ?? []).map((option) => {
                const count = poll.results?.counts[option.id] ?? 0;
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                return showResults ? (
                  <div key={option.id} className="polls__result">
                    <div className="polls__result-label">
                      <span>
                        {option.label[lang] ?? option.label.en}
                        {myVote === option.id ? ' ✓' : ''}
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
                  <Button key={option.id} onClick={() => void vote(poll, option.id)}>
                    {option.label[lang] ?? option.label.en}
                  </Button>
                );
              })}
            </div>
            {myVote && <p className="c-muted polls__thanks">{t('polls.thanks')}</p>}
          </div>
        );
      })}
      {error && <p className="c-muted">{t('polls.error')}</p>}
    </div>
  );
}
