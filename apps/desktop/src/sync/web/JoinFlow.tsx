import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IdbStore } from '@cardo/sync';
import { DriveTransport } from './driveTransport';
import { beginGoogleAuth, currentToken, GoogleAuthError, isGoogleConfigured } from './googleAuth';
import { driveAuth } from './webClient';
import {
  joinGroup,
  JoinDeniedError,
  normalizeKey,
  SlotsFullError,
  type JoinProgress,
} from './webSync';
import { requestPersistence } from '../../web/pwa';

/**
 * First start of the iPhone web app: connect to the desktop's sync group or
 * use the phone on its own. Runs BEFORE any tool starts, so nothing on the
 * phone can write a synced document before the full download is done.
 */
type Step = 'choose' | 'trust' | 'key' | 'google' | 'joining' | 'error';

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'Browser';
}

export function JoinFlow({ store, onDone }: { store: IdbStore; onDone(): void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('choose');
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [progress, setProgress] = useState<
    JoinProgress & { filesRead?: number; filesTotal?: number }
  >({ phase: 'download' });
  const [error, setError] = useState<string | null>(null);

  const checkKey = () => {
    try {
      setKey(normalizeKey(key));
      setKeyError(null);
      if (currentToken()) void join();
      else setStep('google');
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : String(e));
    }
  };

  async function join() {
    setStep('joining');
    try {
      const transport = new DriveTransport(driveAuth(), (p) =>
        setProgress({ phase: 'download', filesRead: p.filesRead, filesTotal: p.filesTotal }),
      );
      const outcome = await joinGroup(
        store,
        transport,
        key,
        deviceName.trim() || defaultDeviceName(),
        (p) => setProgress((prev) => ({ ...prev, ...p })),
      );
      if (outcome.wrongKeySuspected) {
        setError(t('web.join.wrongKey'));
        setStep('error');
        return;
      }
      await requestPersistence();
      onDone();
    } catch (e) {
      setError(
        e instanceof JoinDeniedError
          ? t('web.join.denied')
          : e instanceof SlotsFullError
            ? t('web.join.slotsFull')
            : e instanceof Error
              ? e.message
              : String(e),
      );
      setStep('error');
    }
  }

  // Must stay synchronous up to window.open – iOS blocks later popups.
  const connectGoogle = () => {
    setError(null);
    beginGoogleAuth()
      .then(() => join())
      .catch((e: unknown) => {
        setError(
          e instanceof GoogleAuthError ? t('web.join.googleFailed', { code: e.code }) : String(e),
        );
        setStep('google');
      });
  };

  return (
    <div className="join-flow">
      <div className="c-card join-flow__card">
        <h1 className="join-flow__title">{t('web.join.title')}</h1>

        {step === 'choose' && (
          <>
            <p>{t('web.join.intro')}</p>
            <button
              className="c-btn c-btn--primary join-flow__wide"
              disabled={!isGoogleConfigured()}
              onClick={() => setStep('trust')}
            >
              {t('web.join.connect')}
            </button>
            {!isGoogleConfigured() && <p className="c-muted">{t('web.join.notConfigured')}</p>}
            <button className="c-btn join-flow__wide" onClick={onDone}>
              {t('web.join.standalone')}
            </button>
            <p className="c-muted">{t('web.join.standaloneHint')}</p>
          </>
        )}

        {step === 'trust' && (
          <>
            <h2 className="join-flow__subtitle">{t('settings.sync.trustTitle')}</h2>
            <p>{t('settings.sync.trustBody')}</p>
            <p className="c-muted">{t('settings.sync.trustRecovery')}</p>
            <button className="c-btn c-btn--primary join-flow__wide" onClick={() => setStep('key')}>
              {t('settings.sync.trustConfirm')}
            </button>
            <button className="c-btn c-btn--ghost" onClick={() => setStep('choose')}>
              {t('web.join.back')}
            </button>
          </>
        )}

        {step === 'key' && (
          <>
            <p>{t('web.join.keyHint')}</p>
            <textarea
              className="c-input join-flow__key"
              value={key}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="CRD1-…"
              onChange={(e) => setKey(e.target.value)}
            />
            {keyError && (
              <p className="join-flow__error">{t('web.join.keyInvalid', { reason: keyError })}</p>
            )}
            <label className="join-flow__label">
              {t('web.join.deviceName')}
              <input
                className="c-input"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
              />
            </label>
            <button
              className="c-btn c-btn--primary join-flow__wide"
              disabled={!key.trim()}
              onClick={checkKey}
            >
              {t('web.join.next')}
            </button>
            <button className="c-btn c-btn--ghost" onClick={() => setStep('choose')}>
              {t('web.join.back')}
            </button>
          </>
        )}

        {step === 'google' && (
          <>
            <p>{t('web.join.googleHint')}</p>
            {error && <p className="join-flow__error">{error}</p>}
            <button className="c-btn c-btn--primary join-flow__wide" onClick={connectGoogle}>
              {t('web.join.google')}
            </button>
            <button className="c-btn c-btn--ghost" onClick={() => setStep('key')}>
              {t('web.join.back')}
            </button>
          </>
        )}

        {step === 'joining' && (
          <>
            <p>{t(`web.join.phase.${progress.phase}`)}</p>
            {progress.filesTotal ? (
              <>
                <progress
                  className="join-flow__progress"
                  max={progress.filesTotal}
                  value={progress.filesRead ?? 0}
                />
                <p className="c-muted">
                  {t('web.join.files', {
                    read: progress.filesRead ?? 0,
                    total: progress.filesTotal,
                  })}
                </p>
              </>
            ) : (
              <progress className="join-flow__progress" />
            )}
            <p className="c-muted">{t('web.join.keepOpen')}</p>
          </>
        )}

        {step === 'error' && (
          <>
            <p className="join-flow__error">{error}</p>
            <button className="c-btn c-btn--primary join-flow__wide" onClick={() => setStep('key')}>
              {t('web.join.retry')}
            </button>
            <button className="c-btn c-btn--ghost" onClick={() => setStep('choose')}>
              {t('web.join.back')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
