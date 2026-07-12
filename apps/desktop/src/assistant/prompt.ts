import type { CatalogEntry } from './catalog';

/**
 * System prompt assembly. Pure module.
 * Section headings are fixed (German) – they are part of the contract the
 * instructions.md template refers to; the *content* (instructions,
 * personality, memory, reply language) is per-user.
 */

export interface PromptInput {
  instructions: string;
  personality: string;
  memory: string;
  catalog: CatalogEntry[];
  /** Resolved reply language, e.g. 'de' | 'en'. */
  language: string;
  /** Injected for tests; defaults to now. Relative dates resolve against this. */
  now?: Date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local (not UTC) date – "tomorrow" must resolve in the user's timezone. */
export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localIsoDateTime(d: Date): string {
  return `${localIsoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function catalogLine(entry: CatalogEntry): string {
  const params =
    entry.params.length === 0
      ? 'keine Parameter'
      : entry.params
          .map((p) => `${p.name}: ${p.kind}${p.required ? ' (required)' : ' (optional)'}`)
          .join(', ');
  return `- ${entry.id} — "${entry.title}" — Parameter: ${params}`;
}

export function buildSystemPrompt(input: PromptInput): string {
  const now = input.now ?? new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const languageName =
    input.language === 'de' ? 'Deutsch' : input.language === 'en' ? 'English' : input.language;

  const sections = [
    `## Anweisung\n${input.instructions.trim() || '(keine)'}`,
    `## Persönlichkeit\n${input.personality.trim() || '(keine)'}`,
    `## Gedächtnis\n${input.memory.trim() || '(leer)'}`,
    [
      '## Kontext',
      `Aktuelles Datum und Uhrzeit: ${localIsoDateTime(now)} (${weekday})`,
      `Antwortsprache: ${languageName}`,
    ].join('\n'),
    `## Verfügbare Befehle\n${
      input.catalog.length === 0 ? '(keine)' : input.catalog.map(catalogLine).join('\n')
    }`,
    [
      '## Ausgabeformat',
      'Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt – kein Markdown, kein Text davor oder danach:',
      '{"reply": "<kurze Antwort>", "proposals": [{"command": "<Befehls-ID aus der Liste>", "params": {}, "summary": "<ein Satz, was genau passieren wird, mit den konkreten Werten>"}], "memory": ["<dauerhafter Fakt>"]}',
      'Regeln:',
      '- "reply": kurz, in der Antwortsprache, im Ton der Persönlichkeit.',
      '- "proposals": nur Befehls-IDs aus "Verfügbare Befehle"; niemals eigene erfinden. Leeres Array, wenn nichts zu tun ist.',
      '- Relative Datumsangaben ("morgen", "nächsten Montag") IMMER anhand des aktuellen Datums in konkrete ISO-Daten (YYYY-MM-DD) auflösen.',
      '- "summary": beschreibt exakt, was passieren wird, inklusive der konkreten Werte – in der Antwortsprache.',
      '- "memory": nur dauerhaft nützliche Fakten (Vorlieben, wiederkehrende Probleme + Lösungen, Hintergrund); sonst [].',
    ].join('\n'),
  ];

  return sections.join('\n\n');
}
