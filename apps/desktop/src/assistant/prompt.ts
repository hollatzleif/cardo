import type { CatalogEntry } from './catalog';

/**
 * System prompt assembly. Pure module.
 * Section headings are fixed (German) – they are part of the contract the
 * instructions.md template refers to; the *content* (instructions,
 * personality, memory, competences, reply language) is per-profile.
 */

export interface DelegationTarget {
  id: string;
  name: string;
  competences: string;
}

export interface DelegationInput {
  enabled: boolean;
  ownProfileId: string;
  others: DelegationTarget[];
}

export interface PromptInput {
  instructions: string;
  personality: string;
  memory: string;
  /** The profile's competences file (own strengths, as shown to the model). */
  competencesFile?: string;
  /** Already toolScope-filtered command catalog. */
  catalog: CatalogEntry[];
  /** Resolved reply language, e.g. 'de' | 'en'. */
  language: string;
  /** Local ISO date(-time) shown to the model; defaults to `now`. */
  currentDateIso?: string;
  /** Team delegation: when enabled the output contract gains delegate/forget. */
  delegation?: DelegationInput;
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

export function localIsoDateTime(d: Date): string {
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
  const dateLine = input.currentDateIso ?? localIsoDateTime(now);
  const languageName =
    input.language === 'de' ? 'Deutsch' : input.language === 'en' ? 'English' : input.language;
  const delegation = input.delegation?.enabled === true ? input.delegation : null;

  const sections = [
    `## Anweisung\n${input.instructions.trim() || '(keine)'}`,
    `## Persönlichkeit\n${input.personality.trim() || '(keine)'}`,
    `## Gedächtnis\n${input.memory.trim() || '(leer)'}`,
  ];

  if (input.competencesFile?.trim()) {
    sections.push(`## Kompetenzen\n${input.competencesFile.trim()}`);
  }

  sections.push(
    [
      '## Kontext',
      `Aktuelles Datum und Uhrzeit: ${dateLine} (${weekday})`,
      `Antwortsprache: ${languageName}`,
    ].join('\n'),
    `## Verfügbare Befehle\n${
      input.catalog.length === 0 ? '(keine)' : input.catalog.map(catalogLine).join('\n')
    }`,
  );

  if (delegation) {
    sections.push(
      [
        '## Team',
        `Du bist Profil "${delegation.ownProfileId}" und arbeitest in einem Team.`,
        'Weitere Team-Mitglieder (an sie kannst du Aufgaben abgeben):',
        ...(delegation.others.length === 0
          ? ['(keine)']
          : delegation.others.map(
              (o) => `- ${o.id} — "${o.name}" — Kompetenzen: ${o.competences.trim() || '(keine Angaben)'}`,
            )),
      ].join('\n'),
    );
  }

  const outputFormat = [
    '## Ausgabeformat',
    'Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt – kein Markdown, kein Text davor oder danach:',
    '{"reply": "<kurze Antwort>", "proposals": [{"command": "<Befehls-ID aus der Liste>", "params": {}, "summary": "<ein Satz, was genau passieren wird, mit den konkreten Werten>"}], "memory": ["<dauerhafter Fakt>"]}',
    'Regeln:',
    '- "reply": kurz, in der Antwortsprache, im Ton der Persönlichkeit.',
    '- "proposals": nur Befehls-IDs aus "Verfügbare Befehle"; niemals eigene erfinden. Leeres Array, wenn nichts zu tun ist.',
    '- Schlage ALLE sinnvollen Aktionen vor, auch mehrere ergänzende für dasselbe Ereignis: Eine Klausur morgen um 9 Uhr ergibt z. B. SOWOHL einen Kalender-Termin ALS AUCH einen Wecker. Lieber ein Vorschlag zu viel als einer zu wenig – der Nutzer bestätigt jeden einzeln.',
    '- Datei-Wünsche (Liste anlegen, Text in Datei schreiben, Datei lesen): nutze die workspace.*-Befehle als Vorschläge. Dateien liegen im Notiz-Ordner des Nutzers; erlaubt sind .md, .txt, .csv und .json.',
    '- Relative Datumsangaben ("morgen", "nächsten Montag") IMMER anhand des aktuellen Datums in konkrete ISO-Daten (YYYY-MM-DD) auflösen.',
    '- "summary": beschreibt exakt, was passieren wird, inklusive der konkreten Werte – in der Antwortsprache.',
    '- "memory": nur dauerhaft nützliche Fakten (Vorlieben, wiederkehrende Probleme + Lösungen, Hintergrund); sonst [].',
  ];

  if (delegation) {
    outputFormat.push(
      '- Optional "delegate": [{"to": "<Profil-ID aus dem Team>", "reason": "<kurz>"}] – NUR wenn ein Team-Mitglied die Aufgabe laut Kompetenzen deutlich besser erledigt. Sonst weglassen oder [].',
      '- Optional "forget": ["<exakte Gedächtniszeile>"] – wenn ein Gedächtnis-Eintrag falsch oder veraltet ist. Sonst weglassen oder [].',
    );
  }

  sections.push(outputFormat.join('\n'));

  return sections.join('\n\n');
}
