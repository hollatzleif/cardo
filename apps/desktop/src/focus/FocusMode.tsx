import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { liveTools } from '../host/tools';
import { getHost } from '../host';
import './focus.css';

/** Settings namespace/doc where the current focus task survives restarts. */
const TASK_NAMESPACE = 'core.settings';
const TASK_DOC_ID = 'core.focusTask';
const SAVE_DEBOUNCE_MS = 400;

function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function saveTask(value: string): Promise<void> {
  try {
    await getHost().backend.set(TASK_NAMESPACE, TASK_DOC_ID, { value });
  } catch {
    // Persistence is best-effort – focus mode keeps working either way.
  }
}

/**
 * Fullscreen focus overlay: only the Pomodoro timer and the current task.
 * Everything else disappears until the user leaves via Esc or the exit button.
 */
export function FocusMode({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const [task, setTask] = useState('');
  const [now, setNow] = useState(() => new Date());

  const saveTimer = useRef<number | null>(null);
  const pendingValue = useRef<string | null>(null);

  const pomodoro = liveTools.get('pomodoro');

  // Load the persisted task once.
  useEffect(() => {
    let cancelled = false;
    void getHost()
      .backend.get(TASK_NAMESPACE, TASK_DOC_ID)
      .then((doc) => {
        if (cancelled || doc === null || typeof doc !== 'object') return;
        const value = (doc as { value?: unknown }).value;
        if (typeof value === 'string') setTask(value);
      })
      .catch(() => {
        // No stored task yet (or backend unavailable) – start empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced persistence; flush any pending value on unmount.
  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (pendingValue.current !== null) void saveTask(pendingValue.current);
    },
    [],
  );

  function updateTask(value: string): void {
    setTask(value);
    pendingValue.current = value;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      pendingValue.current = null;
      void saveTask(value);
    }, SAVE_DEBOUNCE_MS);
  }

  // Esc leaves focus mode.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Tiny clock, ticking once per minute (aligned to the minute boundary).
  useEffect(() => {
    let interval: number | undefined;
    const timeout = window.setTimeout(
      () => {
        setNow(new Date());
        interval = window.setInterval(() => setNow(new Date()), 60_000);
      },
      (60 - new Date().getSeconds()) * 1000,
    );
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  return (
    <div className="focus-overlay" role="dialog" aria-modal="true" aria-label={t('focus.title')}>
      <div className="focus-clock c-muted">{formatClock(now)}</div>

      <div className="focus-center">
        <input
          className="focus-task"
          type="text"
          value={task}
          placeholder={t('focus.taskPlaceholder')}
          aria-label={t('focus.taskLabel')}
          spellCheck={false}
          onChange={(e) => updateTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />

        <div className="focus-card c-card">
          {pomodoro ? (
            <pomodoro.Widget
              instanceId="focus"
              widgetId="main"
              size={{ w: 6, h: 6 }}
              editing={false}
            />
          ) : (
            <p className="focus-missing c-muted">{t('focus.pomodoroMissing')}</p>
          )}
        </div>
      </div>

      <button className="focus-exit c-btn c-btn--ghost" onClick={onClose}>
        {t('focus.exit')}
      </button>
    </div>
  );
}
