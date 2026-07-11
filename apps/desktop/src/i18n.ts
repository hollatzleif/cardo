import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources, defaultLanguage, supportedLanguages, type SupportedLanguage } from '@cardo/i18n';

export async function initI18n(persisted: string | null): Promise<void> {
  const browserLang = navigator.language.slice(0, 2);
  const language =
    persisted && (supportedLanguages as readonly string[]).includes(persisted)
      ? persisted
      : (supportedLanguages as readonly string[]).includes(browserLang)
        ? (browserLang as SupportedLanguage)
        : defaultLanguage;

  await i18next.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: defaultLanguage,
    defaultNS: 'common',
    interpolation: { escapeValue: false },
  });
}
