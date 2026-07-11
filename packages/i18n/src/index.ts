import en from '../locales/en/common.json';
import de from '../locales/de/common.json';

export const resources = {
  en: { common: en },
  de: { common: de },
} as const;

export const supportedLanguages = ['en', 'de'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];
export const defaultLanguage: SupportedLanguage = 'en';
