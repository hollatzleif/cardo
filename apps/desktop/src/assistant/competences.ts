/**
 * Competence documents. Pure module.
 *
 * - Since v0.5 competences are MODEL-derived: callers resolve each
 *   member's strengths/weaknesses/idealFor via modelCompetencesDetailed()
 *   (profiles.ts) and pass the resulting text here.
 * - Teams get one generated overview doc (scope 'team-competences', id
 *   'global'): a section per member ('### <emoji> <name> (<modelLabel>)',
 *   weaknesses included so router/delegation know the tradeoffs) plus a
 *   user-editable '## Notizen' section that regeneration must preserve.
 * - Suggestion logic (learned from accepted proposals) lives in profiles.ts
 *   (recordProposalOutcome / competenceSuggestions); the threshold and the
 *   "already mentioned" check are defined here so they can be unit-tested
 *   without a store.
 */

/** A tool is suggested as a competence after this many accepted proposals. */
export const COMPETENCE_SUGGESTION_THRESHOLD = 8;

export const NOTES_HEADING = '## Notizen';

/** Whether a competences free-text already mentions the tool. */
export function competencesMentionTool(competences: string, toolId: string): boolean {
  return competences.toLowerCase().includes(toolId.toLowerCase());
}

export interface TeamCompetenceMember {
  name: string;
  emoji: string;
  /** Display label of the member's model (e.g. "Qwen3 4B"). */
  modelLabel: string;
  /** Model-derived competence lines – pass modelCompetencesDetailed(...). */
  competences: string;
}

/** Extracts the user-maintained '## Notizen' section (heading included). */
export function extractNotesSection(existing: string): string {
  const idx = existing.indexOf(NOTES_HEADING);
  if (idx < 0) return `${NOTES_HEADING}\n`;
  return existing.slice(idx).trimEnd() + '\n';
}

/**
 * (Re)generates the team competences doc: one model-derived section per
 * member, then the preserved '## Notizen' section from the previous version.
 */
export function generateTeamCompetences(
  members: TeamCompetenceMember[],
  existing = '',
): string {
  const sections: string[] = ['# Team-Kompetenzen', ''];
  for (const member of members) {
    sections.push(`### ${member.emoji} ${member.name} (${member.modelLabel})`);
    sections.push(member.competences.trim() || '(keine Angaben)');
    sections.push('');
  }
  sections.push(extractNotesSection(existing).trimEnd());
  return sections.join('\n') + '\n';
}
