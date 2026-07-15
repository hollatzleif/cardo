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
  /**
   * Claude-style agent: works directly on files in the user's notes folder
   * (its sandboxed workspace) instead of only proposing workspace.* cards.
   * Adds the Cardo-understanding + hard limits + big-task behaviour section.
   */
  agentWorkspace?: boolean;
  /**
   * Live capabilities pulled from the app's own registries (themes, design
   * engine, …) at assembly time — NOT hardcoded, so they never go stale:
   * a future update that adds a theme or design option surfaces here
   * automatically. Rendered as a "Cardo aktuell" section.
   */
  capabilities?: {
    /** Human-readable theme labels incl. light/dark, e.g. "Nord (dunkel)". */
    themes?: string[];
    /** Human-readable lines describing what the design engine can change. */
    design?: string[];
  };
  /**
   * Live snapshots of the user's current data (open/done tasks, …) gathered
   * from tools' `*.context` commands, so the assistant can spot duplicates
   * and already-completed items instead of blindly re-creating them.
   */
  currentState?: string[];
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
          .map((p) => {
            const values = p.values && p.values.length > 0 ? `, einer von: ${p.values.join('|')}` : '';
            return `${p.name}: ${p.kind}${p.required ? ' (required' : ' (optional'}${values})`;
          })
          .join(', ');
  const description = entry.description ? ` — ${entry.description}` : '';
  return `- ${entry.id} — "${entry.title}"${description} — Parameter: ${params}`;
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

  if (input.agentWorkspace) {
    sections.push(
      [
        '## Cardo & dein Arbeitsbereich',
        'Cardo ist eine lokale Dashboard-App: Der Nutzer ordnet sich frei Widgets und Werkzeuge an und passt Aussehen und Funktion selbst an – alles bleibt auf seinem Gerät. Du bist ein Assistent INNERHALB von Cardo und hilfst ihm, Gedanken zu ordnen und Dinge zu erledigen; du darfst ihm Cardo und seine Funktionsweise erklären. Welche Werkzeuge es aktuell gibt, siehst du unter "Verfügbare Befehle"; welche Designs es gibt, unter "Cardo aktuell" – verlass dich auf diese Listen statt auf Annahmen, denn sie ändern sich mit Updates.',
        'Zusammenarbeit: Cardo-Werkzeuge steuerst du über Vorschlagskarten (die "proposals" unten – der Nutzer bestätigt jede mit Ja/Bearbeiten/Nein). Datei-Arbeit im Notiz-Ordner erledigst du hingegen DIREKT selbst: Du hast dort Lese- und Schreibzugriff (erlaubt sind u. a. .md, .txt, .csv, .json). Fasse im "reply" zusammen, was du angelegt oder geändert hast – dafür brauchst du KEINE workspace.*-Karte.',
        'Deine Grenzen (wichtig): Du kannst und darfst Cardos eigene App-Dateien, die Einstellungen, die Datenbank, Update-Schlüssel oder andere Assistenten NICHT einsehen oder verändern – dafür hast du keine Rechte, und der Zugriff ist technisch auf den Notiz-Ordner beschränkt. Bittet dich der Nutzer darum, erkläre ihm freundlich, dass du dazu keine Berechtigung hast.',
        'Große Aufträge: Ist eine Aufgabe umfangreich, arbeite sie gründlich und vollständig ab, statt sie zu verkürzen; nimm dir die nötige Zeit und beschreibe im "reply" am Ende, was du erledigt hast.',
      ].join('\n'),
    );
  }

  // Live capabilities from the app's registries — never hardcoded, so a
  // future theme/design addition shows up here without touching this file.
  const capThemes = input.capabilities?.themes ?? [];
  const capDesign = input.capabilities?.design ?? [];
  if (capThemes.length > 0 || capDesign.length > 0) {
    const lines = ['## Cardo aktuell'];
    if (capThemes.length > 0) {
      lines.push(`Verfügbare Designs (Themes): ${capThemes.join(', ')}.`);
    }
    for (const line of capDesign) {
      lines.push(line);
    }
    sections.push(lines.join('\n'));
  }

  const currentState = (input.currentState ?? []).filter((line) => line.trim().length > 0);
  if (currentState.length > 0) {
    sections.push(['## Aktueller Stand', ...currentState].join('\n'));
  }

  const fileRule = input.agentWorkspace
    ? '- Datei-Wünsche (Liste/Notiz/Tabelle anlegen, Text schreiben, Datei lesen): erledige das DIREKT im Notiz-Ordner und beschreibe es im "reply" – keine workspace.*-Karte dafür. Für Cardo-Werkzeuge (Wecker, Termin …) nutzt du weiterhin die proposals.'
    : '- Datei-Wünsche (Liste anlegen, Text in Datei schreiben, Datei lesen): nutze die workspace.*-Befehle als Vorschläge. Dateien liegen im Notiz-Ordner des Nutzers; erlaubt sind .md, .txt, .csv und .json.';

  const outputFormat = [
    '## Ausgabeformat',
    'Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt – kein Markdown, kein Text davor oder danach:',
    '{"reply": "<kurze Antwort>", "proposals": [{"command": "<Befehls-ID aus der Liste>", "params": {}, "summary": "<ein Satz, was genau passieren wird, mit den konkreten Werten>"}], "memory": ["<dauerhafter Fakt>"]}',
    'Regeln:',
    '- "reply": kurz, in der Antwortsprache, im Ton der Persönlichkeit.',
    '- "proposals": nur Befehls-IDs aus "Verfügbare Befehle"; niemals eigene erfinden. Leeres Array, wenn nichts zu tun ist.',
    '- Schlage ALLE sinnvollen Aktionen vor, auch mehrere ergänzende für dasselbe Ereignis: Eine Klausur morgen um 9 Uhr ergibt z. B. SOWOHL einen Kalender-Termin ALS AUCH einen Wecker. Lieber ein Vorschlag zu viel als einer zu wenig – der Nutzer bestätigt jeden einzeln.',
    '- Gleiche jede geplante Aktion mit "Aktueller Stand" ab: Steht eine Aufgabe/ein Termin dort schon OFFEN, lege sie NICHT ungefragt neu an – weise im "reply" darauf hin und frag nach ("steht schon offen drin – trotzdem nochmal?"). Wurde sie KÜRZLICH ERLEDIGT, frag, ob es etwas Neues ist ("hast du erst erledigt – neue?"). Schlage sie nur vor, wenn der Nutzer es bestätigt oder es klar etwas anderes ist.',
    fileRule,
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
