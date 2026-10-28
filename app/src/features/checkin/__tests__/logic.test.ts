import { makeTask } from '@/api/fixtures';
import type { Task } from '@/api/types';
import { addDays } from '@/lib/dates';
import { buildStack, DROP_CHOICES, MAX_CARDS, moreMovedText, summaryLines, SWIPE_THRESHOLD, swipeAction } from '../logic';

const TODAY = '2026-10-27';
const t = (id: string, over: Partial<Task> = {}) => makeTask({ id, title: id, kind: 'quick', ...over }, TODAY);

describe('Check-in stack (US-07, US-12)', () => {
  it('orders still-need-this first, then due today, then the most carried', () => {
    const open = [
      t('plain-1', { carry_count: 1, sort_order: 1 }),
      t('carried-3', { carry_count: 3, sort_order: 2 }),
      t('due', { due_date: TODAY, sort_order: 3 }),
      t('stale-5', { carry_count: 5, sort_order: 4 }),
      t('overdue', { due_date: addDays(TODAY, -2), sort_order: 5 }),
      t('stale-8', { carry_count: 8, sort_order: 6 }),
    ];
    const { cards } = buildStack(open, TODAY);
    expect(cards.map((c) => c.id)).toEqual(['stale-8', 'stale-5', 'due', 'overdue', 'carried-3', 'plain-1']);
  });

  it('puts a stale task ahead of a due one, and treats 4 carries as not stale', () => {
    const { cards } = buildStack([t('due', { due_date: TODAY }), t('four', { carry_count: 4 }), t('five', { carry_count: 5 })], TODAY);
    expect(cards.map((c) => c.id)).toEqual(['five', 'due', 'four']);
  });

  it('caps at 7 cards and counts the rest as rolled over', () => {
    const open = Array.from({ length: 10 }, (_, i) => t(`t${i}`, { sort_order: i }));
    const stack = buildStack(open, TODAY);
    expect(stack.cards).toHaveLength(MAX_CARDS);
    expect(stack.rolledOver).toBe(3);
  });

  it('keeps stale and due tasks when trimming to 7', () => {
    const open = [
      ...Array.from({ length: 8 }, (_, i) => t(`plain${i}`, { sort_order: i })),
      t('stale', { carry_count: 6, sort_order: 20 }),
      t('due', { due_date: TODAY, sort_order: 21 }),
    ];
    const ids = buildStack(open, TODAY).cards.map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual(['stale', 'due']);
  });

  it('is empty for no open tasks and ignores tasks that are not open', () => {
    expect(buildStack([], TODAY)).toEqual({ cards: [], rolledOver: 0 });
    expect(buildStack([t('x', { status: 'done' })], TODAY).cards).toEqual([]);
  });
});

describe('Check-in helpers', () => {
  it('offers the four drop reasons, with Skip meaning no reason', () => {
    expect(DROP_CHOICES.map((c) => [c.label, c.reason])).toEqual([
      ['Not needed', 'not_needed'],
      ['Done elsewhere', 'done_elsewhere'],
      ['Obsolete', 'obsolete'],
      ['Skip', null],
    ]);
  });

  it('words the summary', () => {
    expect(summaryLines({ done: 3, tomorrow: 2, dropped: 1 }, 4, '8:00')).toEqual([
      '3 done, 2 moved to tomorrow, 1 dropped.',
      '4 more rolled over on their own.',
      'Your brief will be ready at 8:00.',
    ]);
    expect(summaryLines({ done: 0, tomorrow: 0, dropped: 0 }, 0, '7:30')).toHaveLength(2);
    expect(moreMovedText(3)).toBe('and 3 more moved to tomorrow');
  });

  it('turns a drag into done, tomorrow or nothing', () => {
    expect(swipeAction(SWIPE_THRESHOLD)).toBe('done');
    expect(swipeAction(-SWIPE_THRESHOLD)).toBe('tomorrow');
    expect(swipeAction(SWIPE_THRESHOLD - 1)).toBeNull();
    expect(swipeAction(-(SWIPE_THRESHOLD - 1))).toBeNull();
  });
});
