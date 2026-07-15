import { describe, expect, it } from 'vitest';
import {
  addMilestoneParamsSchema,
  addProjectParamsSchema,
  buildProjectContext,
  isCompleted,
  isOverdue,
  isValidDateKey,
  makeMilestone,
  makeProject,
  matchMilestone,
  matchProject,
  nextMilestone,
  pickColorToken,
  progressOf,
  sortProjects,
  todayIso,
  type Milestone,
  type ProjectDoc,
} from './logic';

function ms(partial: Partial<Milestone>): Milestone {
  return { id: `ms:${partial.title ?? 'test'}`, title: 'Milestone', done: false, ...partial };
}

function project(partial: Partial<ProjectDoc>): ProjectDoc {
  return {
    id: `project:${partial.name ?? 'test'}`,
    type: 'project',
    name: 'Test project',
    colorToken: 'chart-1',
    milestones: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('progressOf', () => {
  it('is done/total', () => {
    const p = project({
      milestones: [ms({ id: 'ms:a', done: true }), ms({ id: 'ms:b' }), ms({ id: 'ms:c' }), ms({ id: 'ms:d', done: true })],
    });
    expect(progressOf(p)).toBe(0.5);
  });

  it('is 0 for an empty project', () => {
    expect(progressOf(project({}))).toBe(0);
  });

  it('is 1 when every milestone is done', () => {
    expect(progressOf(project({ milestones: [ms({ done: true })] }))).toBe(1);
  });
});

describe('nextMilestone', () => {
  it('picks the earliest undone milestone by due date', () => {
    const p = project({
      milestones: [
        ms({ id: 'ms:late', title: 'Late', due: '2026-09-01' }),
        ms({ id: 'ms:early', title: 'Early', due: '2026-08-01' }),
        ms({ id: 'ms:done', title: 'Done', due: '2026-07-01', done: true }),
      ],
    });
    expect(nextMilestone(p)?.id).toBe('ms:early');
  });

  it('puts undated milestones after dated ones', () => {
    const p = project({
      milestones: [
        ms({ id: 'ms:undated', title: 'Undated' }),
        ms({ id: 'ms:dated', title: 'Dated', due: '2099-01-01' }),
      ],
    });
    expect(nextMilestone(p)?.id).toBe('ms:dated');
  });

  it('falls back to the first undated milestone when nothing has a due date', () => {
    const p = project({
      milestones: [ms({ id: 'ms:a', title: 'A' }), ms({ id: 'ms:b', title: 'B' })],
    });
    expect(nextMilestone(p)?.id).toBe('ms:a');
  });

  it('is null for empty and all-done projects', () => {
    expect(nextMilestone(project({}))).toBeNull();
    expect(nextMilestone(project({ milestones: [ms({ done: true })] }))).toBeNull();
  });
});

describe('isOverdue', () => {
  it('flags undone milestones due strictly before today', () => {
    expect(isOverdue(ms({ due: '2026-07-14' }), '2026-07-15')).toBe(true);
    expect(isOverdue(ms({ due: '2026-07-15' }), '2026-07-15')).toBe(false);
    expect(isOverdue(ms({ due: '2026-07-16' }), '2026-07-15')).toBe(false);
  });

  it('never flags done or undated milestones', () => {
    expect(isOverdue(ms({ due: '2020-01-01', done: true }), '2026-07-15')).toBe(false);
    expect(isOverdue(ms({}), '2026-07-15')).toBe(false);
  });
});

describe('isCompleted', () => {
  it('requires at least one milestone, all done', () => {
    expect(isCompleted(project({}))).toBe(false);
    expect(isCompleted(project({ milestones: [ms({ done: true }), ms({})] }))).toBe(false);
    expect(isCompleted(project({ milestones: [ms({ done: true })] }))).toBe(true);
  });
});

describe('sortProjects', () => {
  it('orders active by next due, then undated/empty, completed last', () => {
    const completed = project({ id: 'project:done', name: 'Done', milestones: [ms({ done: true })] });
    const empty = project({ id: 'project:empty', name: 'Empty' });
    const soon = project({
      id: 'project:soon',
      name: 'Soon',
      milestones: [ms({ due: '2026-08-01' })],
    });
    const later = project({
      id: 'project:later',
      name: 'Later',
      milestones: [ms({ due: '2026-09-01' })],
    });
    const undated = project({ id: 'project:undated', name: 'Undated', milestones: [ms({})] });
    const sorted = sortProjects([completed, empty, later, undated, soon]);
    expect(sorted.map((p) => p.id)).toEqual([
      'project:soon',
      'project:later',
      'project:empty',
      'project:undated',
      'project:done',
    ]);
  });

  it('breaks ties by name and does not mutate the input', () => {
    const b = project({ id: 'project:b', name: 'Beta' });
    const a = project({ id: 'project:a', name: 'Alpha' });
    const input = [b, a];
    expect(sortProjects(input).map((p) => p.name)).toEqual(['Alpha', 'Beta']);
    expect(input[0]?.name).toBe('Beta');
  });
});

describe('matchProject / matchMilestone', () => {
  const projects = [
    project({ id: 'project:web', name: 'Website Relaunch' }),
    project({ id: 'project:app', name: 'App' }),
  ];

  it('matches by id, exact name (case-insensitive) and unique substring', () => {
    expect(matchProject(projects, 'project:app')?.id).toBe('project:app');
    expect(matchProject(projects, 'app')?.id).toBe('project:app');
    expect(matchProject(projects, 'WEBSITE RELAUNCH')?.id).toBe('project:web');
    expect(matchProject(projects, 'relaunch')?.id).toBe('project:web');
  });

  it('returns null for unknown, empty and ambiguous references', () => {
    expect(matchProject(projects, 'nope')).toBeNull();
    expect(matchProject(projects, '  ')).toBeNull();
    const ambiguous = [project({ id: 'project:a', name: 'Plan A' }), project({ id: 'project:b', name: 'Plan B' })];
    expect(matchProject(ambiguous, 'plan')).toBeNull();
  });

  it('finds milestones the same way', () => {
    const p = project({
      milestones: [ms({ id: 'ms:design', title: 'Design done' }), ms({ id: 'ms:launch', title: 'Launch' })],
    });
    expect(matchMilestone(p, 'launch')?.id).toBe('ms:launch');
    expect(matchMilestone(p, 'DESIGN DONE')?.id).toBe('ms:design');
    expect(matchMilestone(p, 'n')).toBeNull(); // ambiguous – both titles contain "n"
    expect(matchMilestone(p, 'nope')).toBeNull();
  });
});

describe('makeProject / makeMilestone / pickColorToken', () => {
  it('rotates through the eight chart tokens', () => {
    expect(pickColorToken(0)).toBe('chart-1');
    expect(pickColorToken(7)).toBe('chart-8');
    expect(pickColorToken(8)).toBe('chart-1');
    expect(pickColorToken(-1)).toBe('chart-8');
  });

  it('creates trimmed projects with a rotating color', () => {
    const p = makeProject('  New thing  ', 2);
    expect(p.name).toBe('New thing');
    expect(p.colorToken).toBe('chart-3');
    expect(p.type).toBe('project');
    expect(p.milestones).toEqual([]);
    expect(p.id.startsWith('project:')).toBe(true);
  });

  it('creates milestones with optional due date', () => {
    const dated = makeMilestone({ title: ' Launch ', due: '2026-09-01' });
    expect(dated.title).toBe('Launch');
    expect(dated.due).toBe('2026-09-01');
    expect(dated.done).toBe(false);
    const undated = makeMilestone({ title: 'Draft' });
    expect(undated.due).toBeUndefined();
  });
});

describe('param schemas / dates', () => {
  it('validates command params', () => {
    expect(addProjectParamsSchema.safeParse({ name: 'X' }).success).toBe(true);
    expect(addProjectParamsSchema.safeParse({ name: '' }).success).toBe(false);
    expect(addMilestoneParamsSchema.safeParse({ project: 'X', title: 'Y' }).success).toBe(true);
    expect(
      addMilestoneParamsSchema.safeParse({ project: 'X', title: 'Y', due: '2026-09-01' }).success,
    ).toBe(true);
    expect(
      addMilestoneParamsSchema.safeParse({ project: 'X', title: 'Y', due: '01.09.2026' }).success,
    ).toBe(false);
  });

  it('isValidDateKey rejects impossible dates', () => {
    expect(isValidDateKey('2026-09-01')).toBe(true);
    expect(isValidDateKey('2026-02-29')).toBe(false);
    expect(isValidDateKey('2026-13-01')).toBe(false);
  });

  it('todayIso uses the local calendar date', () => {
    expect(todayIso(new Date(2026, 6, 15, 0, 30, 0))).toBe('2026-07-15');
  });
});

describe('buildProjectContext', () => {
  it('reports the empty state in both languages', () => {
    expect(buildProjectContext([], 'en', '2026-07-15')).toBe('No projects yet.');
    expect(buildProjectContext([], 'de', '2026-07-15')).toBe('Keine Projekte angelegt.');
  });

  it('lists progress percent and next milestone per project', () => {
    const p = project({
      name: 'Relaunch',
      milestones: [
        ms({ id: 'ms:a', title: 'Design', done: true }),
        ms({ id: 'ms:b', title: 'Launch', due: '2026-09-01' }),
      ],
    });
    const text = buildProjectContext([p], 'en', '2026-07-15');
    expect(text).toContain('«Relaunch»: 50% (1/2)');
    expect(text).toContain('next up «Launch» (2026-09-01)');
  });

  it('marks overdue, completed and empty projects', () => {
    const overdue = project({
      id: 'project:o',
      name: 'Old',
      milestones: [ms({ title: 'Ship', due: '2026-01-01' })],
    });
    const done = project({ id: 'project:d', name: 'Done', milestones: [ms({ done: true })] });
    const empty = project({ id: 'project:e', name: 'Empty' });
    const text = buildProjectContext([overdue, done, empty], 'de', '2026-07-15');
    expect(text).toContain('überfällig seit 2026-01-01');
    expect(text).toContain('«Done»: 100% (1/1), abgeschlossen');
    expect(text).toContain('«Empty»: 0% (0/0), noch keine Meilensteine');
  });
});
