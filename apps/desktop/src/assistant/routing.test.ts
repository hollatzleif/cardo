import { describe, expect, it } from 'vitest';
import { buildRouterPrompt, parseRouterAnswer } from './routing';
import type { AssistantProfile, AssistantTeam } from './profiles';

function profile(id: string, name: string, competences: string): AssistantProfile {
  return {
    id,
    name,
    emoji: '🤖',
    color: 'accent-1',
    modelId: 'qwen3-4b',
    memoryId: 'shared',
    competences,
    toolScope: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const team: AssistantTeam = {
  id: 't-1',
  name: 'Redaktion',
  emoji: '👥',
  color: 'accent-2',
  memberIds: ['p-writer', 'p-coder'],
  leaderId: 'p-writer',
  memoryId: 'shared',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const members = [
  profile('p-writer', 'Texterin', 'Schreibt und redigiert Texte'),
  profile('p-coder', 'Coder', 'Programmiert und debuggt'),
];

describe('buildRouterPrompt', () => {
  it('lists every member with id, name and competences', () => {
    const { system, user } = buildRouterPrompt(team, members, 'Bitte Text korrigieren');
    expect(system).toContain('Redaktion');
    expect(system).toContain('p-writer');
    expect(system).toContain('Texterin');
    expect(system).toContain('Schreibt und redigiert Texte');
    expect(system).toContain('p-coder');
    expect(system).toContain('Coder');
    expect(system).toContain('Programmiert und debuggt');
    expect(user).toBe('Bitte Text korrigieren');
  });

  it('only includes profiles that are team members', () => {
    const outsider = profile('p-outsider', 'Fremd', 'Alles');
    const { system } = buildRouterPrompt(team, [...members, outsider], 'x');
    expect(system).not.toContain('p-outsider');
  });

  it('marks empty competences and demands a bare profile id', () => {
    const { system } = buildRouterPrompt(team, [profile('p-writer', 'T', ''), members[1]!], 'x');
    expect(system).toContain('(keine Angaben)');
    expect(system).toContain('AUSSCHLIESSLICH');
  });
});

describe('parseRouterAnswer', () => {
  const ids = ['p-writer', 'p-coder'];

  it('exact match (with whitespace, quotes, fences, case)', () => {
    expect(parseRouterAnswer('p-coder', ids, 'p-writer')).toBe('p-coder');
    expect(parseRouterAnswer('  p-coder \n', ids, 'p-writer')).toBe('p-coder');
    expect(parseRouterAnswer('"p-coder"', ids, 'p-writer')).toBe('p-coder');
    expect(parseRouterAnswer('```\np-coder\n```', ids, 'p-writer')).toBe('p-coder');
    expect(parseRouterAnswer('P-CODER', ids, 'p-writer')).toBe('p-coder');
  });

  it('substring match on noisy answers', () => {
    expect(parseRouterAnswer('Ich würde p-coder nehmen, weil…', ids, 'p-writer')).toBe('p-coder');
  });

  it('prefers the longest contained id when ids overlap', () => {
    const overlapping = ['p-1', 'p-12'];
    expect(parseRouterAnswer('nimm p-12', overlapping, 'p-1')).toBe('p-12');
  });

  it('falls back to the leader on invalid answers', () => {
    expect(parseRouterAnswer('keine Ahnung', ids, 'p-writer')).toBe('p-writer');
    expect(parseRouterAnswer('', ids, 'p-writer')).toBe('p-writer');
    expect(parseRouterAnswer('p-unknown-profile-x', ids, 'p-writer')).toBe('p-writer');
  });
});
