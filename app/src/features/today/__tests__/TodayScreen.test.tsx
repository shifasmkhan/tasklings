import { act, render, screen, userEvent, within } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';

import { ApiProvider } from '@/api/ApiProvider';
import { makeTask } from '@/api/fixtures';
import { createMockApi, type MockApiClient } from '@/api/mock';
import type { Task } from '@/api/types';
import { localIsoDate } from '@/lib/dates';
import { dark, light } from '@/theme/colors';
import { TodayScreen, type TodayNavigation } from '../TodayScreen';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme,
}));

// Swipe gestures run on the native UI thread and can't be driven headlessly. This double
// keeps the real Swipeable contract: it renders both action panels and exposes test buttons
// that fire onSwipeableWillOpen with the direction a real swipe would report.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  const SwipeDirection = { LEFT: 'left', RIGHT: 'right' } as const;
  const methods = { close: jest.fn(), openLeft: jest.fn(), openRight: jest.fn(), reset: jest.fn() };
  const Swipeable = React.forwardRef(function Swipeable(
    props: {
      children: ReactNode;
      onSwipeableWillOpen?: (d: string) => void;
      renderLeftActions?: (...a: unknown[]) => ReactNode;
      renderRightActions?: (...a: unknown[]) => ReactNode;
    },
    ref: React.Ref<typeof methods>,
  ) {
    React.useImperativeHandle(ref, () => methods);
    const [revealed, setRevealed] = React.useState(false);
    return (
      <View>
        <Pressable testID="swipe-right" onPress={() => props.onSwipeableWillOpen?.(SwipeDirection.RIGHT)}>
          <Text>swipe right</Text>
        </Pressable>
        <Pressable
          testID="swipe-left"
          onPress={() => {
            setRevealed(true);
            props.onSwipeableWillOpen?.(SwipeDirection.LEFT);
          }}
        >
          <Text>swipe left</Text>
        </Pressable>
        {revealed ? props.renderRightActions?.({}, {}, methods) : null}
        {props.children}
      </View>
    );
  });
  return { __esModule: true, default: Swipeable, SwipeDirection };
});

const TODAY = localIsoDate();

function fixtures(): Task[] {
  return [
    makeTask({ id: 'q-plain', title: 'Text the neighbour', kind: 'quick', effort_min: 5, sort_order: 0 }, TODAY),
    makeTask({ id: 'q-carried', title: 'Reply to the landlord', kind: 'quick', effort_min: 10, carry_count: 2, sort_order: 1 }, TODAY),
    makeTask({ id: 'e-due', title: 'Drop off the parcel', kind: 'errand', effort_min: 20, due_date: TODAY, sort_order: 2 }, TODAY),
    makeTask({ id: 'p-big', title: 'Sort the garage', kind: 'project', effort_min: 60, sort_order: 3 }, TODAY),
  ];
}

const nav: TodayNavigation = { openCapture: jest.fn(), openTask: jest.fn(), openCheckIn: jest.fn() };

async function renderToday(
  tasks: Task[] = fixtures(),
  api: MockApiClient = createMockApi({ tasks, today: () => TODAY }),
): Promise<MockApiClient> {
  await render(
    <ApiProvider client={api}>
      <TodayScreen nav={nav} />
    </ApiProvider>,
  );
  await screen.findByText('Today');
  await screen.findByLabelText('Today summary');
  return api;
}

function startCard() {
  return within(screen.getByLabelText('Start here'));
}

function rowFor(title: string) {
  // The row's tap circle carries the title; its Swipeable wrapper is two levels up.
  const circle = screen.getByRole('button', { name: `Mark done: ${title}` });
  let node = circle.parent;
  while (node && !within(node).queryByTestId('swipe-left')) node = node.parent;
  if (!node) throw new Error('row not found');
  return within(node);
}

describe('Today screen (US-04)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockScheme = 'light';
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the summary card with tasks left, time, progress and per-group counts', async () => {
    await renderToday();
    const summary = within(screen.getByLabelText('Today summary'));
    expect(summary.getByText('4 tasks left')).toBeOnTheScreen();
    expect(summary.getByText('About 1 hr 35 min')).toBeOnTheScreen();
    expect(summary.getByText('2 quick')).toBeOnTheScreen();
    expect(summary.getByText('1 errand')).toBeOnTheScreen();
    expect(summary.getByText('1 bigger')).toBeOnTheScreen();
    expect(screen.getByRole('progressbar')).toHaveAccessibilityValue({ min: 0, max: 100, now: 0 });
  });

  it('groups tasks as Quick wins, Errands, Bigger things', async () => {
    await renderToday();
    const headings = screen.getAllByRole('heading').map((h) => h.props.children);
    expect(headings).toEqual(['Today', 'QUICK WINS', 'BIGGER THINGS']);
    // Errands is empty because its only task is the Start here pick.
    expect(screen.queryByText('ERRANDS')).not.toBeOnTheScreen();
  });

  it('picks Start here by rule and shows it only once', async () => {
    await renderToday();
    expect(startCard().getByText('Drop off the parcel')).toBeOnTheScreen();
    expect(startCard().getByText('START HERE · ERRAND · DUE TODAY')).toBeOnTheScreen();
    expect(screen.getAllByText('Drop off the parcel')).toHaveLength(1);
  });

  it('Skip for now moves Start here to the next task by rule', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderToday();
    await user.press(startCard().getByRole('button', { name: 'Skip for now' }));
    expect(startCard().getByText('Reply to the landlord')).toBeOnTheScreen();
    expect(startCard().getByText('START HERE · QUICK WIN · DAY 3')).toBeOnTheScreen();
    // The skipped task goes back to its group.
    expect(screen.getByText('ERRANDS')).toBeOnTheScreen();
  });

  it('Start here Done completes with a haptic and offers Undo', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const api = await renderToday();
    await user.press(startCard().getByRole('button', { name: 'Done: Drop off the parcel' }));
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Done: Drop off the parcel')).toBeOnTheScreen();
    expect(api.snapshot().find((t) => t.id === 'e-due')?.status).toBe('done');
  });

  it('the tap circle completes (VoiceOver path) and the task collapses into Done today', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderToday();
    await user.press(screen.getByRole('button', { name: 'Mark done: Text the neighbour' }));
    expect(Haptics.notificationAsync).toHaveBeenCalled();
    const toggle = screen.getByRole('button', { name: 'Done today, 1' });
    expect(toggle).toBeCollapsed();
    expect(screen.getByText('DONE TODAY (1)')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Mark not done: Text the neighbour' })).not.toBeOnTheScreen();
    await user.press(toggle);
    expect(screen.getByRole('button', { name: 'Done today, 1' })).toBeExpanded();
    expect(screen.getByRole('button', { name: 'Mark not done: Text the neighbour' })).toBeOnTheScreen();
    expect(screen.getByText('3 tasks left')).toBeOnTheScreen();
    expect(screen.getByRole('progressbar')).toHaveAccessibilityValue({ now: 25 });
  });

  it('swipe right completes with a haptic', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const api = await renderToday();
    await user.press(rowFor('Text the neighbour').getByTestId('swipe-right'));
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
    expect(screen.getByText('DONE TODAY (1)')).toBeOnTheScreen();
    expect(api.snapshot().find((t) => t.id === 'q-plain')?.status).toBe('done');
  });

  it('swipe left reveals Tomorrow and Drop', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const api = await renderToday();
    const row = rowFor('Sort the garage');
    await user.press(row.getByTestId('swipe-left'));
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    await user.press(row.getByRole('button', { name: 'Move to tomorrow: Sort the garage' }));
    expect(screen.getByText('Moved to tomorrow')).toBeOnTheScreen();
    expect(screen.queryByText('Sort the garage')).not.toBeOnTheScreen();
    expect(api.snapshot().find((t) => t.id === 'p-big')?.planned_for).not.toBe(TODAY);

    await user.press(rowFor('Text the neighbour').getByTestId('swipe-left'));
    await user.press(screen.getByRole('button', { name: 'Drop: Text the neighbour' }));
    expect(screen.getByText('Dropped')).toBeOnTheScreen();
    expect(api.snapshot().find((t) => t.id === 'q-plain')?.status).toBe('dropped');
  });

  it('Undo within 5 seconds restores a dropped task', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const api = await renderToday();
    await user.press(rowFor('Text the neighbour').getByTestId('swipe-left'));
    await user.press(screen.getByRole('button', { name: 'Drop: Text the neighbour' }));
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await user.press(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Text the neighbour')).toBeOnTheScreen();
    expect(api.snapshot().find((t) => t.id === 'q-plain')?.status).toBe('open');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeOnTheScreen();
  });

  it('the Undo toast disappears after 5 seconds', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderToday();
    await user.press(screen.getByRole('button', { name: 'Mark done: Text the neighbour' }));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeOnTheScreen();
  });

  it('Undo after complete puts the task back and empties Done today', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const api = await renderToday();
    await user.press(screen.getByRole('button', { name: 'Mark done: Text the neighbour' }));
    await user.press(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Mark done: Text the neighbour' })).toBeOnTheScreen();
    expect(screen.queryByText(/DONE TODAY/)).not.toBeOnTheScreen();
    expect(api.snapshot().find((t) => t.id === 'q-plain')?.status).toBe('open');
  });

  it('shows a quiet Day N label for carried tasks', async () => {
    await renderToday();
    // Reply to the landlord is carried twice and sits in Quick wins.
    const label = rowFor('Reply to the landlord').getByText('Day 3');
    expect(label).toBeOnTheScreen();
    expect(label).toHaveStyle({ color: light.secondaryText });
    expect(label).not.toHaveStyle({ color: light.dropAction });
  });

  it('shows the all-done empty state when nothing is left', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderToday([fixtures()[0] as Task]);
    await user.press(startCard().getByRole('button', { name: 'Done: Text the neighbour' }));
    expect(screen.getAllByText('All done for today').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading', { name: 'All done for today' })).toBeOnTheScreen();
    expect(screen.queryByLabelText('Start here')).not.toBeOnTheScreen();
  });

  it('a failed action puts the task back and says so', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const api = await renderToday();
    api.failNext('server_error');
    await user.press(screen.getByRole('button', { name: 'Mark done: Text the neighbour' }));
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Mark done: Text the neighbour' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeOnTheScreen();
  });

  it('the mic button is labelled and opens Capture', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderToday();
    // The visible caption is hidden from VoiceOver because the button label already says it.
    expect(screen.getByText('Hold to talk · tap to lock', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.queryByText('Hold to talk · tap to lock')).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Hold to talk, or tap to lock recording' }));
    expect(nav.openCapture).toHaveBeenCalledTimes(1);
  });

  it('opens task detail and the evening check-in', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderToday();
    await user.press(screen.getByRole('button', { name: 'Open evening check-in' }));
    expect(nav.openCheckIn).toHaveBeenCalledTimes(1);
    await user.press(screen.getByRole('button', { name: 'Text the neighbour, 5 min' }));
    expect(nav.openTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-plain' }));
  });

  it('exposes Mark done, Tomorrow and Drop as VoiceOver actions on each row', async () => {
    await renderToday();
    const body = screen.getByRole('button', { name: 'Reply to the landlord, 10 min, Day 3' });
    expect(body.props.accessibilityActions.map((a: { name: string }) => a.name)).toEqual([
      'complete',
      'tomorrow',
      'drop',
      'activate',
    ]);
  });

  it('Skip for now wraps to the top after the last task and keeps going', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderToday();
    const order = ['Drop off the parcel', 'Reply to the landlord', 'Text the neighbour', 'Sort the garage'];
    for (const title of [...order, ...order.slice(0, 2)]) {
      expect(startCard().getByText(title)).toBeOnTheScreen();
      await user.press(startCard().getByRole('button', { name: 'Skip for now' }));
    }
    expect(startCard().getByText('Text the neighbour')).toBeOnTheScreen();
  });

  it('Undo waits for the action to reach the server before calling undo_task', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const api = createMockApi({ tasks: fixtures(), today: () => TODAY });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const realComplete = api.completeTask.bind(api);
    api.completeTask = async (id) => {
      await gate;
      return realComplete(id);
    };
    const undoSpy = jest.spyOn(api, 'undoTask');
    await renderToday(fixtures(), api);

    await user.press(screen.getByRole('button', { name: 'Mark done: Text the neighbour' }));
    await user.press(screen.getByRole('button', { name: 'Undo' }));
    // The row is back at once, but undo_task has not been sent yet.
    expect(screen.getByRole('button', { name: 'Mark done: Text the neighbour' })).toBeOnTheScreen();
    expect(undoSpy).not.toHaveBeenCalled();

    await act(async () => release());
    expect(undoSpy).toHaveBeenCalledWith('q-plain');
    expect(api.snapshot().find((t) => t.id === 'q-plain')?.status).toBe('open');
    expect(screen.queryByText("Couldn't undo. Try again.")).not.toBeOnTheScreen();
  });

  it('Undo of an action that then fails stays quiet and sends no undo_task', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const api = createMockApi({ tasks: fixtures(), today: () => TODAY });
    let fail: () => void = () => undefined;
    const gate = new Promise<void>((_, reject) => (fail = () => reject(new Error('offline'))));
    api.dropTask = async () => {
      await gate;
      throw new Error('unreachable');
    };
    const undoSpy = jest.spyOn(api, 'undoTask');
    await renderToday(fixtures(), api);

    await user.press(rowFor('Text the neighbour').getByTestId('swipe-left'));
    await user.press(screen.getByRole('button', { name: 'Drop: Text the neighbour' }));
    await user.press(screen.getByRole('button', { name: 'Undo' }));
    await act(async () => fail());
    expect(undoSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Mark done: Text the neighbour' })).toBeOnTheScreen();
    expect(screen.queryByText("Couldn't save that. Try again.")).not.toBeOnTheScreen();
  });

  it('uses the dark palette in dark mode', async () => {
    mockScheme = 'dark';
    await renderToday();
    expect(screen.getByLabelText('Today summary')).toHaveStyle({ backgroundColor: dark.card });
    expect(screen.getByLabelText('Start here')).toHaveStyle({ backgroundColor: dark.card, borderColor: dark.accent });
    expect(screen.getByText('Today')).toHaveStyle({ color: dark.text });
    expect(rowFor('Reply to the landlord').getByText('Day 3')).toHaveStyle({ color: dark.secondaryText });
  });
});
