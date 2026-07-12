import type { AssistantProfile, AssistantTeam } from './profiles';

/**
 * Team routing: a small router model picks WHICH member profile answers a
 * question. Pure module – prompt building and answer parsing are fully
 * unit-tested; generation happens elsewhere (slot 'router').
 */

export interface RouterPrompt {
  system: string;
  user: string;
}

/**
 * Builds the router prompt. Contract: the model answers ONLY with one
 * member id from the list – nothing else.
 */
export function buildRouterPrompt(
  team: AssistantTeam,
  memberProfiles: AssistantProfile[],
  question: string,
): RouterPrompt {
  const members = memberProfiles.filter((p) => team.memberIds.includes(p.id));
  const lines = members.map(
    (p) => `- ${p.id} — "${p.name}" — Kompetenzen: ${p.competences.trim() || '(keine Angaben)'}`,
  );
  const system = [
    `Du bist der Router des Teams "${team.name}".`,
    'Wähle das EINE Team-Mitglied, das die folgende Anfrage laut seinen Kompetenzen am besten beantwortet.',
    '',
    'Team-Mitglieder:',
    ...lines,
    '',
    'Antworte AUSSCHLIESSLICH mit genau einer Profil-ID aus der Liste – kein anderer Text, keine Begründung, keine Anführungszeichen.',
  ].join('\n');
  return { system, user: question };
}

/**
 * Parses the router answer: exact id match first (case-insensitive, quotes
 * and fences stripped), then substring match (longest id wins so ids that
 * contain each other resolve deterministically), else the team leader.
 */
export function parseRouterAnswer(raw: string, memberIds: string[], leaderId: string): string {
  const cleaned = raw
    .replace(/```[a-zA-Z]*/g, '')
    .replace(/[`"'„“]/g, '')
    .trim()
    .toLowerCase();

  const exact = memberIds.find((id) => id.toLowerCase() === cleaned);
  if (exact) return exact;

  const contained = memberIds
    .filter((id) => cleaned.includes(id.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (contained) return contained;

  return leaderId;
}
