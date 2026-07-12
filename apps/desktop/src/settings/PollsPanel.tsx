import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cardo/ui';
import { getHost } from '../host';
import { fetchAppInfo } from '../host/backend';
import { POLLS_DEFINITION_URL, POLLS_WORKER_URL } from '../polls/config';

interface PollOption {
  id: string;
  label: Record<string, string>;
}
interface Poll {
  id: string;
  question: Record<string, string>;
  options: PollOption[];
  open: boolean;
}
interface PollResults {
  total: number;
  counts: Record<string, number>;
}

async function deviceHash(): Promise<string> {
  const info = await fetchAppInfo();
  const bytes = new TextEncoder().encode(`cardo-poll:${info.deviceId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Polls (yellow feature): NOTHING is fetched until the user presses the
 * load button; the explainer above it says exactly which hosts are
 * contacted and what is sent. One vote per installation, anonymous.
 */
export function PollsPanel() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('de') ? 'de' : 'en';
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [polls, setPolls] = useState<Poll[]>([]);
  const [results, setResults] = useState<Record<string, PollResults>>({});
  const [voted, setVoted] = useState<Record<string, string>>({});

  useEffect(() => {
    void getHost()
      .backend.get('core.settings', 'polls.voted')
      .then((doc) => setVoted(((doc as { value?: Record<string, string> })?.value ?? {})));
  }, []);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const defs = (await (await fetch(POLLS_DEFINITION_URL)).json()) as { polls: Poll[] };
      setPolls(defs.polls.filter((p) => p.options.length > 0));
      try {
        const res = (await (await fetch(`${POLLS_WORKER_URL}/results`)).json()) as {
          polls: Record<string, PollResults>;
        };
        setResults(res.polls ?? {});
      } catch {
        setResults({});
      }
      setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function vote(poll: Poll, optionId: string) {
    try {
      const device = await deviceHash();
      const res = await fetch(`${POLLS_WORKER_URL}/vote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ poll: poll.id, option: optionId, device }),
      });
      if (res.ok || res.status === 409) {
        const nextVoted = { ...voted, [poll.id]: optionId };
        setVoted(nextVoted);
        await getHost().backend.set('core.settings', 'polls.voted', { value: nextVoted });
        try {
          const r = (await (await fetch(`${POLLS_WORKER_URL}/results?poll=${poll.id}`)).json()) as
            PollResults & { poll: string };
          setResults((prev) => ({ ...prev, [poll.id]: { total: r.total, counts: r.counts } }));
        } catch {
          /* results refresh is best-effort */
        }
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
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
        const res = results[poll.id];
        const total = res?.total ?? 0;
        return (
          <div key={poll.id} className="c-card polls__item">
            <strong>{poll.question[lang] ?? poll.question.en}</strong>
            {!poll.open && <span className="c-muted"> · {t('polls.closed')}</span>}
            <div className="polls__options">
              {poll.options.map((option) => {
                const count = res?.counts[option.id] ?? 0;
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                const showResults = Boolean(myVote) || !poll.open;
                return showResults ? (
                  <div key={option.id} className="polls__result">
                    <div className="polls__result-label">
                      <span>
                        {option.label[lang] ?? option.label.en}
                        {myVote === option.id ? ` ✓` : ''}
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
