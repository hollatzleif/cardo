import { getHost } from '../host';

/**
 * Assistant settings in core.settings (same pattern as the inbox):
 * - assistant.persona          {value: AssistantPersona}
 * - assistant.model            {value: string}   selected model id
 * - assistant.askBeforeExecute {value: boolean}  default TRUE
 */

export type PersonaStyle = 'concise' | 'friendly' | 'detailed';
export type PersonaLanguage = 'de' | 'en' | 'app';

export interface AssistantPersona {
  assistantName: string;
  userName: string;
  style: PersonaStyle;
  language: PersonaLanguage;
  extra: string;
}

export function defaultPersona(): AssistantPersona {
  return { assistantName: 'Cardo', userName: '', style: 'friendly', language: 'app', extra: '' };
}

const NS = 'core.settings';

async function getSetting<T>(key: string): Promise<T | null> {
  const doc = (await getHost().backend.get(NS, key)) as { value?: T } | null;
  return doc?.value ?? null;
}

export async function getPersona(): Promise<AssistantPersona | null> {
  return getSetting<AssistantPersona>('assistant.persona');
}

export async function setPersona(persona: AssistantPersona): Promise<void> {
  await getHost().backend.set(NS, 'assistant.persona', { value: persona });
}

export async function getSelectedModelId(): Promise<string | null> {
  return getSetting<string>('assistant.model');
}

export async function setSelectedModelId(id: string): Promise<void> {
  await getHost().backend.set(NS, 'assistant.model', { value: id });
}

export async function getAskBeforeExecute(): Promise<boolean> {
  const value = await getSetting<boolean>('assistant.askBeforeExecute');
  return value !== false; // default true
}

export async function setAskBeforeExecute(value: boolean): Promise<void> {
  await getHost().backend.set(NS, 'assistant.askBeforeExecute', { value });
}

/** Re-runs cb whenever an assistant.* setting changes (returns unsubscribe). */
export function onAssistantSettingsChange(cb: () => void): () => void {
  return getHost().backend.onChange((ev) => {
    if (ev.namespace === NS && ev.docId.startsWith('assistant.')) cb();
  });
}
