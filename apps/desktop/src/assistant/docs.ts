import type { AssistantPersona } from './store';

/**
 * Generated assistant documents (instructions.md / personality.md).
 *
 * These are NOT UI strings: they are content written to the user's disk in
 * the language the *assistant* speaks (which may differ from the app
 * language), so they live here as templates instead of i18n keys.
 */

export type DocLanguage = 'de' | 'en';

export function resolveDocLanguage(
  persona: Pick<AssistantPersona, 'language'> | null,
  appLanguage: string,
): DocLanguage {
  const lang = persona?.language ?? 'app';
  if (lang === 'de' || lang === 'en') return lang;
  return appLanguage.startsWith('de') ? 'de' : 'en';
}

export function generateInstructions(lang: DocLanguage): string {
  if (lang === 'de') {
    return [
      '# Arbeitsweise des Cardo-Assistenten',
      '',
      'Du bist der Assistent in Cardo. Der Nutzer schüttet Gedanken als Braindump aus,',
      'und du machst daraus konkrete, ausführbare Vorschläge.',
      '',
      '1. Du erhältst den Braindump des Nutzers zusammen mit einem Katalog der verfügbaren Befehle.',
      '2. Du antwortest AUSSCHLIESSLICH mit dem JSON-Objekt aus dem Abschnitt „Ausgabeformat" – niemals mit freiem Text davor oder danach.',
      '3. Relative Datumsangaben („morgen", „nächsten Montag") löst du anhand des aktuellen Datums aus dem Kontext in konkrete ISO-Daten auf.',
      '4. personality.md legt Ton, Namen und Sprache fest – halte dich strikt daran.',
      '5. memory.md enthält dauerhafte Fakten über den Nutzer. SCHAU DORT NACH, bevor du etwas fragst, und nutze die Einträge, um Details in Vorschlägen auszufüllen.',
      '6. Schlage über das Feld "memory" NEUE Einträge für dauerhaft nützliche Fakten vor: Vorlieben, wiederkehrende Probleme samt Lösungen, Hintergrundwissen.',
      '7. Wenn ein Gedächtnis-Eintrag veraltet ist, schlage eine Korrektur als neuen Eintrag vor.',
      '8. Erfinde niemals Befehle, die nicht im Katalog stehen.',
      '9. Wenn du unsicher bist: Mach den Vorschlag trotzdem und lass den Nutzer ihn über „Bearbeiten" anpassen.',
      '',
    ].join('\n');
  }
  return [
    '# How the Cardo assistant works',
    '',
    'You are the assistant inside Cardo. The user dumps raw thoughts, and you',
    'turn them into concrete, executable proposals.',
    '',
    '1. You receive the user\'s braindump together with a catalog of available commands.',
    '2. You reply ONLY with the JSON object described in the "Ausgabeformat" section – never with free text before or after it.',
    '3. Resolve relative dates ("tomorrow", "next Monday") to concrete ISO dates using the current date from the context.',
    '4. personality.md defines tone, names and language – follow it strictly.',
    '5. memory.md contains durable facts about the user. CHECK IT BEFORE ASKING anything, and use its entries to fill in details of your proposals.',
    '6. Propose NEW entries for durable facts via the "memory" array: preferences, recurring problems with their solutions, background knowledge.',
    '7. When a memory entry is outdated, propose a correction as a new entry.',
    '8. Never invent commands that are not in the catalog.',
    '9. When unsure: make the proposal anyway and let the user adjust it via "Edit".',
    '',
  ].join('\n');
}

function styleText(style: AssistantPersona['style'], lang: DocLanguage): string {
  const de: Record<AssistantPersona['style'], string> = {
    concise: 'kurz & direkt – keine Floskeln, auf den Punkt',
    friendly: 'freundlich und warm, dabei kompakt',
    detailed: 'ausführlich – erkläre Hintergründe und nenne Alternativen',
  };
  const en: Record<AssistantPersona['style'], string> = {
    concise: 'short & direct – no filler, straight to the point',
    friendly: 'friendly and warm, yet compact',
    detailed: 'detailed – explain background and mention alternatives',
  };
  return (lang === 'de' ? de : en)[style];
}

function languageText(language: AssistantPersona['language'], lang: DocLanguage): string {
  if (lang === 'de') {
    if (language === 'de') return 'Antworte immer auf Deutsch.';
    if (language === 'en') return 'Antworte immer auf Englisch.';
    return 'Antworte in der Sprache, in der der Nutzer schreibt.';
  }
  if (language === 'de') return 'Always reply in German.';
  if (language === 'en') return 'Always reply in English.';
  return 'Reply in the language the user writes in.';
}

export function generatePersonality(persona: AssistantPersona, lang: DocLanguage): string {
  const lines: string[] = lang === 'de' ? ['# Persönlichkeit', ''] : ['# Personality', ''];
  if (lang === 'de') {
    lines.push(`- Dein Name ist ${persona.assistantName || 'Cardo'}.`);
    lines.push(
      persona.userName
        ? `- Du nennst den Nutzer „${persona.userName}".`
        : '- Du sprichst den Nutzer direkt mit „du" an.',
    );
    lines.push(`- Antwortstil: ${styleText(persona.style, lang)}.`);
    lines.push(`- ${languageText(persona.language, lang)}`);
    if (persona.extra.trim()) lines.push(`- Außerdem wichtig: ${persona.extra.trim()}`);
  } else {
    lines.push(`- Your name is ${persona.assistantName || 'Cardo'}.`);
    lines.push(
      persona.userName
        ? `- You address the user as "${persona.userName}".`
        : '- You address the user directly and informally.',
    );
    lines.push(`- Reply style: ${styleText(persona.style, lang)}.`);
    lines.push(`- ${languageText(persona.language, lang)}`);
    if (persona.extra.trim()) lines.push(`- Also important: ${persona.extra.trim()}`);
  }
  lines.push('');
  return lines.join('\n');
}
