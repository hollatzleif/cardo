import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getWebSyncState,
  reconnectGoogle,
  subscribeWebSync,
  syncNow,
  type WebSyncState,
} from './webClient';

/** Thin bar under the top bar when the phone's sync needs attention. */
export function WebSyncBanner() {
  const { t } = useTranslation();
  const [state, setState] = useState<WebSyncState>(getWebSyncState());
  useEffect(() => subscribeWebSync(setState), []);

  if (state.kind === 'needs-google') {
    return (
      <div className="web-sync-banner" role="status">
        <span className="web-sync-banner__text">{t('web.sync.paused')}</span>
        <button
          className="c-btn c-btn--primary"
          onClick={() => void reconnectGoogle().catch(() => {})}
        >
          {t('web.sync.continueGoogle')}
        </button>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="web-sync-banner" role="status">
        <span className="web-sync-banner__text">
          {t('web.sync.failed', { message: state.message })}
        </span>
        <button className="c-btn" onClick={() => void syncNow()}>
          {t('web.sync.retry')}
        </button>
      </div>
    );
  }
  if (state.kind === 'revoked' || state.kind === 'join-denied') {
    return (
      <div className="web-sync-banner" role="status">
        <span className="web-sync-banner__text">
          {state.kind === 'revoked' ? t('web.sync.revoked') : t('web.join.denied')}
        </span>
      </div>
    );
  }
  return null;
}
