import { render, screen, userEvent } from '@testing-library/react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { makeTask } from '@/api/fixtures';
import { createMockApi, type MockApiClient } from '@/api/mock';
import type { Task } from '@/api/types';
import { addDays, localIsoDate } from '@/lib/dates';
import { dark, light } from '@/theme/colors';
import { CheckInScreen } from '../CheckInScreen';
import { CHECKIN_SAVE_ERROR } from '../useCheckIn';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme,
}));

const TODAY = localIsoDate();
const mk = (id: string, over: Partial<Task> = {}) => makeTask({ id, title: `Title ${id}`, kind: 'quick', ...over }, TODAY);

async function renderCheckIn(tasks: Task[], briefTime?: string) {
  const api = createMockApi({ tasks, today: () => TODAY });
  if (briefTime) await api.updateProfileTimes({ briefTime });
  const onClose = jest.fn();
  await render(
    <ApiProvider client={api}>
      <CheckInScreen onClose={onClose} today={TODAY} />
    </ApiProvider>,
  );
  await screen.findByLabelText(/^Card \d+ of \d+$|^Loading/);
  return { api, onClose };
}

const status = (api: MockApiClient, id: string) => api.snapshot().find((t) => t.id === id);
const user = () => userEvent.setup();

describe('Evening check-in (US-07, US-12)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScheme = 'light';
  });

  it('shows one card at a time with progress dots', async () => {
    await renderCheckIn([mk('a', { sort_order: 0 }), mk('b', { sort_order: 1 }), mk('c', { sort_order: 2 })]);
    expect(screen.getByLabelText('Card 1 of 3')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Move to tomorrow' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Drop' })).toBeOnTheScreen();
    await user().press(screen.getByRole('button', { name: 'Mark done' }));
    expect(screen.getByLabelText('Card 2 of 3')).toBeOnTheScreen();
  });

  it('shows the due-today card before a plain one, and still-need-this first', async () => {
    const { api } = await renderCheckIn([
      mk('plain', { sort_order: 0 }),
      mk('due', { sort_order: 1, due_date: TODAY }),
      mk('stale', { sort_order: 2, carry_count: 5 }),
    ]);
    expect(screen.getByText('Title stale')).toBeOnTheScreen();
    await user().press(screen.getByRole('button', { name: 'Keep it, move to tomorrow' }));
    expect(screen.getByText('Title due')).toBeOnTheScreen();
    await user().press(screen.getByRole('button', { name: 'Mark done' }));
    expect(screen.getByText('Title plain')).toBeOnTheScreen();
    expect(status(api, 'stale')?.planned_for).toBe(addDays(TODAY, 1));
  });

  it('Done completes and Tomorrow defers', async () => {
    const { api } = await renderCheckIn([mk('a', { sort_order: 0 }), mk('b', { sort_order: 1 })]);
    await user().press(screen.getByRole('button', { name: 'Mark done' }));
    await user().press(screen.getByRole('button', { name: 'Move to tomorrow' }));
    expect(status(api, 'a')?.status).toBe('done');
    expect(status(api, 'b')?.planned_for).toBe(addDays(TODAY, 1));
  });

  describe('Drop asks why', () => {
    it.each([
      ['Not needed', 'not_needed'],
      ['Done elsewhere', 'done_elsewhere'],
      ['Obsolete', 'obsolete'],
      ['Skip', null],
    ])('%s drops with reason %s', async (label, reason) => {
      const { api } = await renderCheckIn([mk('a')]);
      await user().press(screen.getByRole('button', { name: 'Drop' }));
      expect(screen.getByText('Why drop it?')).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeOnTheScreen();
      const spy = jest.spyOn(api, 'dropTask');
      await user().press(screen.getByRole('menuitem', { name: label }));
      expect(spy).toHaveBeenCalledWith('a', reason ?? undefined);
      expect(status(api, 'a')?.status).toBe('dropped');
      expect(status(api, 'a')?.dropped_reason).toBe(reason);
    });

    it('Back returns to the buttons without dropping', async () => {
      const { api } = await renderCheckIn([mk('a')]);
      await user().press(screen.getByRole('button', { name: 'Drop' }));
      await user().press(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByRole('button', { name: 'Mark done' })).toBeOnTheScreen();
      expect(status(api, 'a')?.status).toBe('open');
    });
  });

  describe('still-need-this card (US-12)', () => {
    it('offers Keep and Drop only, and Keep moves it to tomorrow', async () => {
      const { api } = await renderCheckIn([mk('old', { carry_count: 6 })]);
      expect(screen.getByText('STILL NEED THIS?')).toBeOnTheScreen();
      expect(screen.getByText('Carried over 6 days', { exact: false })).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: 'Move to tomorrow' })).not.toBeOnTheScreen();
      await user().press(screen.getByRole('button', { name: 'Keep it, move to tomorrow' }));
      expect(status(api, 'old')?.planned_for).toBe(addDays(TODAY, 1));
      expect(status(api, 'old')?.status).toBe('open');
    });

    it('Drop on it asks why', async () => {
      const { api } = await renderCheckIn([mk('old', { carry_count: 5 })]);
      await user().press(screen.getByRole('button', { name: 'Drop' }));
      await user().press(screen.getByRole('menuitem', { name: 'Obsolete' }));
      expect(status(api, 'old')?.dropped_reason).toBe('obsolete');
    });
  });

  it('caps the stack at 7 cards and says the rest moved to tomorrow', async () => {
    await renderCheckIn(Array.from({ length: 9 }, (_, i) => mk(`t${i}`, { sort_order: i })));
    expect(screen.getByLabelText('Card 1 of 7')).toBeOnTheScreen();
    expect(screen.getByText('and 2 more moved to tomorrow')).toBeOnTheScreen();
  });

  it('stays on the card with a quiet error when a call fails, and a retry works', async () => {
    const { api } = await renderCheckIn([mk('a'), mk('b', { sort_order: 1 })]);
    api.failNext('network_error');
    await user().press(screen.getByRole('button', { name: 'Mark done' }));
    expect(screen.getByRole('alert')).toHaveTextContent(CHECKIN_SAVE_ERROR);
    expect(screen.getByLabelText('Card 1 of 2')).toBeOnTheScreen();
    await user().press(screen.getByRole('button', { name: 'Mark done' }));
    expect(screen.getByLabelText('Card 2 of 2')).toBeOnTheScreen();
    expect(screen.queryByRole('alert')).not.toBeOnTheScreen();
  });

  describe('summary', () => {
    it('counts the outcomes, mentions the roll-over and the brief time from the profile, then Good night closes', async () => {
      const tasks = [
        mk('d', { sort_order: 0 }),
        mk('t', { sort_order: 1 }),
        mk('x', { sort_order: 2 }),
        ...Array.from({ length: 6 }, (_, i) => mk(`more${i}`, { sort_order: 3 + i })),
      ];
      const { onClose } = await renderCheckIn(tasks);
      await user().press(screen.getByRole('button', { name: 'Mark done' }));
      await user().press(screen.getByRole('button', { name: 'Move to tomorrow' }));
      await user().press(screen.getByRole('button', { name: 'Drop' }));
      await user().press(screen.getByRole('menuitem', { name: 'Skip' }));
      for (let i = 0; i < 4; i += 1) await user().press(screen.getByRole('button', { name: 'Move to tomorrow' }));
      expect(screen.getByText('1 done, 5 moved to tomorrow, 1 dropped.')).toBeOnTheScreen();
      expect(screen.getByText('2 more rolled over on their own.')).toBeOnTheScreen();
      expect(await screen.findByText('Your brief will be ready at 8:00 AM.')).toBeOnTheScreen();
      expect(screen.queryByText(/usual time/)).not.toBeOnTheScreen();
      await user().press(screen.getByRole('button', { name: 'Good night' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('uses the profile brief time, however it was set', async () => {
      await renderCheckIn([mk('a')], '07:30');
      await user().press(screen.getByRole('button', { name: 'Mark done' }));
      expect(screen.getByText('Your brief will be ready at 7:30 AM.')).toBeOnTheScreen();
      expect(screen.queryByText(/usual time/)).not.toBeOnTheScreen();
      expect(screen.queryByText(/rolled over/)).not.toBeOnTheScreen();
    });

    it('leaves the brief line out when the profile can\'t be read', async () => {
      const api = createMockApi({ tasks: [mk('a')], today: () => TODAY });
      jest.spyOn(api, 'getProfile').mockRejectedValue(new Error('offline'));
      await render(
        <ApiProvider client={api}>
          <CheckInScreen onClose={jest.fn()} today={TODAY} />
        </ApiProvider>,
      );
      await screen.findByLabelText(/^Card \d+ of \d+$/);
      await user().press(screen.getByRole('button', { name: 'Mark done' }));
      expect(screen.getByText('1 done, 0 moved to tomorrow, 0 dropped.')).toBeOnTheScreen();
      expect(screen.queryByText(/brief will be ready/)).not.toBeOnTheScreen();
    });

    it('goes straight to a calm summary when nothing is open', async () => {
      await render(
        <ApiProvider client={createMockApi({ tasks: [], today: () => TODAY })}>
          <CheckInScreen onClose={jest.fn()} today={TODAY} />
        </ApiProvider>,
      );
      expect(await screen.findByText('Nothing left open')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Good night' })).toBeOnTheScreen();
    });
  });

  it('offers a retry when loading fails', async () => {
    const api = createMockApi({ tasks: [mk('a')], today: () => TODAY });
    jest.spyOn(api, 'todayTasks').mockRejectedValueOnce(new Error('offline'));
    await render(
      <ApiProvider client={api}>
        <CheckInScreen onClose={jest.fn()} today={TODAY} />
      </ApiProvider>,
    );
    await user().press(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Card 1 of 1')).toBeOnTheScreen();
  });

  it('keeps 44pt targets on every button', async () => {
    await renderCheckIn([mk('a')]);
    for (const name of ['Mark done', 'Move to tomorrow', 'Drop']) {
      const el = screen.getByRole('button', { name });
      const flat = Object.assign({}, ...[el.props.style].flat(2).filter(Boolean)) as { minHeight?: number };
      expect(flat.minHeight ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('uses the %s palette', async (scheme, palette) => {
    mockScheme = scheme;
    await renderCheckIn([mk('a')]);
    expect(screen.getByText('Title a')).toHaveStyle({ color: palette.text });
  });
});
