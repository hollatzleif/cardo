import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getHost } from '../../host';
import type { IdbStore } from '@cardo/sync';
import {
  getWebSyncState,
  reconnectGoogle,
  subscribeWebSync,
  syncNow,
  type WebSyncState,
} from './webClient';
import { forgetToken } from './googleAuth';
import { leaveSync, loadConfig, type WebSyncConfig } from './webSync';

/** Settings → Sync on the iPhone web app. */
export function WebSyncSection() {
  const { t } = useTranslation();
  const store = getHost().backend as unknown as IdbStore;
  const [config, setConfig] = useState<WebSyncConfig | null>(null);
  const [state, setState] = useState<WebSyncState>(getWebSyncState());

  useEffect(() => subscribeWebSync(setState), []);
  useEffect(() => {
    void loadConfig(store).then(setConfig);
  }, [store, state]);

  if (!config?.joined) {
    return (
      <div className="c-card settings-page__card">
        <p>{t('web.sync.notJoined')}</p>
        <button
          className="c-btn c-btn--primary"
          onClick={() => {
            localStorage.setItem('cardo-web-show-join', '1');
            window.location.reload();
          }}
        >
          {t('web.join.connect')}
        </button>
      </div>
    );
  }

  const last = config.lastSyncMs ? new Date(config.lastSyncMs).toLocaleString() : '—';
  return (
    <div className="c-card settings-page__card">
      <p>{t('web.sync.joinedAs', { name: config.deviceName })}</p>
      <p className="c-muted">{t('web.sync.lastSync', { when: last })}</p>
      <p className="c-muted">{t(`web.sync.state.${state.kind}`)}</p>
      <p className="c-muted">{t('web.sync.onlyWhileOpen')}</p>
      <div className="design-row--inline">
        {state.kind === 'needs-google' ? (
          <button
            className="c-btn c-btn--primary"
            onClick={() => void reconnectGoogle().catch(() => {})}
          >
            {t('web.sync.continueGoogle')}
          </button>
        ) : (
          <button
            className="c-btn c-btn--primary"
            disabled={state.kind === 'syncing'}
            onClick={() => void syncNow()}
          >
            {t('web.sync.now')}
          </button>
        )}
        <button
          className="c-btn c-btn--danger"
          onClick={() => {
            if (!window.confirm(t('web.sync.leaveConfirm'))) return;
            forgetToken();
            void leaveSync(store).then(() => window.location.reload());
          }}
        >
          {t('web.sync.leave')}
        </button>
      </div>
    </div>
  );
}
