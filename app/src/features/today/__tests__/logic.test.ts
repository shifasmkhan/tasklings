import { makeTask } from '@/api/fixtures';
import type { Task } from '@/api/types';
import {
  carriedLabel,
  formatMinutes,
  groupTasks,
  pickStartHere,
  summarize,
  taskMeta,
} from '../logic';

const TODAY = '2026-10-26';

function task(id: string, o: Partial<Task> = {}): Task {
  return makeTask({ id, title: `Synthetic task ${id}`, kind: 'quick', ...o }, TODAY);
}

describe('pickStartHere (fixed rule: due today, then most carried, then shortest)', () => {
  it('returns null with no open tasks', () => {
    expect(pickStartHere([], TODAY)).toBeNull();
  });

  it('puts a task due today ahead of one carried more and one shorter', () => {
    const tasks = [
      task('carried', { carry_count: 4, effort_min: 5 }),
      task('short', { effort_min: 1 }),
      task('due', { due_date: TODAY, effort_min: 60 }),
    ];
    expect(pickStartHere(tasks, TODAY)?.id).toBe('due');
  });

  it('counts overdue as due today', () => {
    const tasks = [task('carried', { carry_count: 3 }), task('overdue', { due_date: '2026-10-20' })];
    expect(pickStartHere(tasks, TODAY)?.id).toBe('overdue');
  });

  it('does not treat a future due date as due today', () => {
    const tasks = [task('future', { due_date: '2026-10-30' }), task('carried', { carry_count: 1 })];
    expect(pickStartHere(tasks, TODAY)?.id).toBe('carried');
  });

  it('breaks a due-today tie by most carried', () => {
    const tasks = [
      task('a', { due_date: TODAY, carry_count: 1 }),
      task('b', { due_date: TODAY, carry_count: 3 }),
    ];
    expect(pickStartHere(tasks, TODAY)?.id).toBe('b');
  });

  it('breaks a carry tie by shortest effort', () => {
    const tasks = [
      task('long', { carry_count: 2, effort_min: 30 }),
      task('quick', { carry_count: 2, effort_min: 5 }),
    ];
    expect(pickStartHere(tasks, TODAY)?.id).toBe('quick');
  });

  it('is deterministic on a full tie (sort_order, then id)', () => {
    const tasks = [task('z', { sort_order: 1 }), task('y', { sort_order: 1 }), task('x', { sort_order: 2 })];
    expect(pickStartHere(tasks, TODAY)?.id).toBe('y');
    expect(pickStartHere([...tasks].reverse(), TODAY)?.id).toBe('y');
  });

  it('ignores tasks that are not open', () => {
    const tasks = [task('done', { status: 'done', due_date: TODAY }), task('open')];
    expect(pickStartHere(tasks, TODAY)?.id).toBe('open');
  });

  it('passes over skipped tasks to the next by rule', () => {
    const tasks = [task('due', { due_date: TODAY }), task('carried', { carry_count: 2 }), task('plain')];
    expect(pickStartHere(tasks, TODAY, new Set(['due']))?.id).toBe('carried');
    expect(pickStartHere(tasks, TODAY, new Set(['due', 'carried']))?.id).toBe('plain');
  });

  it('starts again from the top once every task has been skipped', () => {
    const tasks = [task('due', { due_date: TODAY }), task('plain')];
    expect(pickStartHere(tasks, TODAY, new Set(['due', 'plain']))?.id).toBe('due');
  });
});

describe('groupTasks', () => {
  const tasks = [
    task('p1', { kind: 'project', sort_order: 0 }),
    task('e2', { kind: 'errand', sort_order: 5 }),
    task('q2', { kind: 'quick', sort_order: 3 }),
    task('e1', { kind: 'errand', sort_order: 1 }),
    task('q1', { kind: 'quick', sort_order: 2 }),
  ];

  it('orders groups Quick wins, Errands, Bigger things', () => {
    expect(groupTasks(tasks).map((g) => g.title)).toEqual(['Quick wins', 'Errands', 'Bigger things']);
  });

  it('sorts each group by sort_order', () => {
    const g = groupTasks(tasks);
    expect(g[0]?.tasks.map((t) => t.id)).toEqual(['q1', 'q2']);
    expect(g[1]?.tasks.map((t) => t.id)).toEqual(['e1', 'e2']);
  });

  it('leaves the Start here task out of its group so it shows once', () => {
    const g = groupTasks(tasks, 'q1');
    expect(g[0]?.tasks.map((t) => t.id)).toEqual(['q2']);
  });

  it('drops empty groups', () => {
    const g = groupTasks([task('only', { kind: 'errand' })]);
    expect(g.map((x) => x.kind)).toEqual(['errand']);
    expect(groupTasks([task('only', { kind: 'errand' })], 'only')).toEqual([]);
  });

  it('excludes tasks that are not open', () => {
    const g = groupTasks([task('d', { status: 'dropped' }), task('o')]);
    expect(g[0]?.tasks.map((t) => t.id)).toEqual(['o']);
  });
});

describe('summarize', () => {
  it('counts tasks left, minutes, per-group counts and progress', () => {
    const open = [
      task('a', { kind: 'quick', effort_min: 5 }),
      task('b', { kind: 'errand', effort_min: 20 }),
      task('c', { kind: 'project', effort_min: 60 }),
    ];
    expect(summarize(open, 1)).toEqual({
      left: 3,
      done: 1,
      totalMinutes: 85,
      progress: 0.25,
      counts: { quick: 1, errand: 1, project: 1 },
    });
  });

  it('reports zero progress on an empty day', () => {
    expect(summarize([], 0).progress).toBe(0);
  });
});

describe('labels', () => {
  it('formats minutes', () => {
    expect(formatMinutes(5)).toBe('5 min');
    expect(formatMinutes(60)).toBe('1 hr');
    expect(formatMinutes(95)).toBe('1 hr 35 min');
  });

  it('shows a quiet Day N label only for carried tasks', () => {
    expect(carriedLabel(task('a'))).toBeNull();
    expect(carriedLabel(task('b', { carry_count: 1 }))).toBe('Day 2');
    expect(carriedLabel(task('c', { carry_count: 4 }))).toBe('Day 5');
  });

  it('adds due today and overdue to the meta line', () => {
    expect(taskMeta(task('a', { effort_min: 5, due_date: TODAY }), TODAY)).toBe('5 min · Due today');
    expect(taskMeta(task('b', { effort_min: 5, due_date: '2026-10-01' }), TODAY)).toBe('5 min · Overdue');
    expect(taskMeta(task('c', { effort_min: 5, due_date: '2026-11-01' }), TODAY)).toBe('5 min');
  });
});
