import { makeTask } from '@/api/fixtures';
import { allowedEnrichments, dueChipLabel, dueOptions, effortOptions, showsScript } from '../logic';

const TODAY = '2026-10-27';

describe('Task detail logic (US-05)', () => {
  it('adds an unusual current effort to the menu in order', () => {
    expect(effortOptions(25)).toEqual([5, 10, 15, 20, 25, 30, 45, 60, 90, 120, 180, 240]);
    expect(effortOptions(30)).toContain(30);
    expect(effortOptions(30).filter((m) => m === 30)).toHaveLength(1);
  });

  it('labels the due chip', () => {
    expect(dueChipLabel(null, TODAY)).toBe('No due date');
    expect(dueChipLabel(TODAY, TODAY)).toBe('Due today');
    expect(dueChipLabel('2026-10-28', TODAY)).toBe('Due tomorrow');
    expect(dueChipLabel('2026-11-06', TODAY)).toBe('Due Nov 6');
    expect(dueChipLabel('2026-10-20', TODAY)).toBe('Overdue · Oct 20');
  });

  it('offers relative due dates and a way to clear it', () => {
    const options = dueOptions(TODAY);
    expect(options.map((o) => o.value)).toEqual([TODAY, '2026-10-28', '2026-10-30', '2026-11-03', null]);
  });

  it('only lets Apple Maps phone, address and hours through as "Found for you"', () => {
    const items = [
      { id: '1', type: 'phone', value: '(555) 010-0100' },
      { id: '2', type: 'url', value: 'https://example.com' },
      { id: '3', type: 'note', value: 'a note' },
      { id: '4', type: 'address', value: '' },
      { id: '5', type: 'hours', value: 'Open until 6 PM' },
    ];
    expect(allowedEnrichments(items).map((e) => e.type)).toEqual(['phone', 'hours']);
  });

  it('shows a script for any task that has one', () => {
    expect(showsScript(makeTask({ id: 'a', title: 'x', kind: 'quick', script: 'Hello' }, TODAY))).toBe(true);
    expect(showsScript(makeTask({ id: 'a', title: 'x', kind: 'quick', script: null }, TODAY))).toBe(false);
    expect(showsScript(makeTask({ id: 'a', title: 'x', kind: 'quick', script: '  ' }, TODAY))).toBe(false);
    expect(showsScript(makeTask({ id: 'a', title: 'x', kind: 'errand', script: 'Hello' }, TODAY))).toBe(true);
  });
});
