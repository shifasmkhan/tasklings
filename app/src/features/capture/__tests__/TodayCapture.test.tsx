import { act, fireEvent, render, screen, userEvent } from '@testing-library/react-native';
import { AccessibilityInfo, AppState } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { makeTask } from '@/api/fixtures';
import { createMockApi, type MockApiClient } from '@/api/mock';
import { NEEDS_REVIEW_CARD_TEXT } from '@/features/today/logic';
import { QUEUED_DETAIL, SORTING_LABEL } from '@/features/today/parts';
import { TodayScreen, type TodayNavigation } from '@/features/today/TodayScreen';
import { localIsoDate } from '@/lib/dates';
import { CaptureProvider } from '../CaptureProvider';
import { CaptureStore, RESULT_TIMEOUT_MS } from '../captureStore';

// Swipe gestures run on the native UI thread and can't load headlessly. These tests don't swipe,
// so the double renders just the row.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children: import('react').ReactNode }) => <View>{children}</View>,
    SwipeDirection: { LEFT: 'left', RIGHT: 'right' },
  };
});

const TODAY = localIsoDate();
const nav: TodayNavigation = { openCapture: jest.fn(), openTask: jest.fn(), openCheckIn: jest.fn() };

let appStateHandlers: ((state: string) => void)[] = [];

async function renderToday(delayMs = 1500) {
  const api: MockApiClient = createMockApi({
    tasks: [makeTask({ id: 'existing', title: 'Text the neighbour', kind: 'quick', effort_min: 5 }, TODAY)],
    today: () => TODAY,
    captureResultDelayMs: delayMs,
  });
  let n = 0;
  const store = new CaptureStore({ api, arrivals: null, newId: () => `capture-${++n}` });
  await render(
    <ApiProvider client={api}>
      <CaptureProvider store={store}>
        <TodayScreen nav={nav} />
      </CaptureProvider>
    </ApiProvider>,
  );
  await screen.findByLabelText('Today summary');
  return { api, store };
}

const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

describe('After saving (US-03)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    appStateHandlers = [];
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      appStateHandlers.push(handler as (state: string) => void);
      return { remove: jest.fn() };
    });
  });
  afterEach(() => jest.useRealTimers());

  async function save(store: CaptureStore, source: 'voice' | 'text', transcript: string) {
    await act(async () => {
      store.submit({ source, transcript });
    });
  }

  it('shows "Sorting your note…" until the tasks arrive, then "Added N tasks"', async () => {
    const { store } = await renderToday();
    await save(store, 'voice', 'Call the dentist, buy stamps at the post office, and plan the garage clean out');
    await advance(100);
    expect(screen.getByText(SORTING_LABEL)).toBeOnTheScreen();
    expect(screen.queryByText('Added 3 tasks')).not.toBeOnTheScreen();
    await advance(1500);
    expect(screen.queryByText(SORTING_LABEL)).not.toBeOnTheScreen();
    expect(screen.getByText('Added 3 tasks')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeOnTheScreen();
    expect(screen.getByText('Call the dentist')).toBeOnTheScreen();
    expect(screen.getByText('4 tasks left')).toBeOnTheScreen();
  });

  it('says "Added 1 task" for a single task', async () => {
    const { store } = await renderToday();
    await save(store, 'text', 'Pay the water bill');
    await advance(1700);
    expect(screen.getByText('Added 1 task')).toBeOnTheScreen();
  });

  it('Undo removes the added tasks (undo_capture) and leaves the others', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { api, store } = await renderToday();
    await save(store, 'voice', 'Call the dentist, buy stamps');
    await advance(1700);
    await user.press(screen.getByRole('button', { name: 'Undo' }));
    await advance(10);
    expect(screen.queryByText('Call the dentist')).not.toBeOnTheScreen();
    expect(screen.queryByText('Buy stamps')).not.toBeOnTheScreen();
    expect(screen.getByText('Text the neighbour')).toBeOnTheScreen();
    const byStatus = api.snapshot().map((t) => [t.title, t.status]);
    expect(byStatus).toContainEqual(['Text the neighbour', 'open']);
    // Deleted, not dropped: undo_capture removes the capture's tasks.
    expect(byStatus.map(([title]) => title)).not.toContain('Call the dentist');
    expect(byStatus.map(([title]) => title)).not.toContain('Buy stamps');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeOnTheScreen();
  });

  describe('undo window', () => {
    it('is 5 seconds', async () => {
      const { store } = await renderToday();
      await save(store, 'text', 'Pay the water bill');
      await advance(1500);
      await advance(4900);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeOnTheScreen();
      await advance(100);
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeOnTheScreen();
    });

    it('is 10 seconds with VoiceOver on', async () => {
      jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
      const { store } = await renderToday();
      await save(store, 'text', 'Pay the water bill');
      await advance(1500);
      await advance(9900);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeOnTheScreen();
      await advance(100);
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeOnTheScreen();
    });

    it('announces the result to VoiceOver', async () => {
      const { store } = await renderToday();
      await save(store, 'text', 'Pay the water bill');
      await advance(1500);
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Added 1 task. Undo available.');
    });
  });

  it('an empty result shows "Nothing to add" with no Undo', async () => {
    const { api, store } = await renderToday();
    await save(store, 'voice', 'Um, never mind, nothing to add.');
    await advance(1500);
    expect(screen.getByText('Nothing to add')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeOnTheScreen();
    expect(screen.queryByText(SORTING_LABEL)).not.toBeOnTheScreen();
    expect(api.snapshot()).toHaveLength(1);
    await advance(5000);
    expect(screen.queryByText('Nothing to add')).not.toBeOnTheScreen();
  });

  it('a fallback result shows the existing "Needs a look" card', async () => {
    const { store } = await renderToday();
    expect(screen.queryByText(NEEDS_REVIEW_CARD_TEXT)).not.toBeOnTheScreen();
    await save(store, 'voice', 'Garbled. Buy stamps, book the vet');
    await advance(1500);
    expect(screen.getByText(NEEDS_REVIEW_CARD_TEXT)).toBeOnTheScreen();
    expect(screen.getByText('Added 1 task')).toBeOnTheScreen();
  });

  it('the result still shows up if Today was not on screen when it arrived', async () => {
    const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 50 });
    const store = new CaptureStore({ api, arrivals: null, newId: () => 'c1' });
    store.submit({ source: 'text', transcript: 'Pay the water bill' });
    await advance(100);
    await render(
      <ApiProvider client={api}>
        <CaptureProvider store={store}>
          <TodayScreen nav={nav} />
        </CaptureProvider>
      </ApiProvider>,
    );
    await screen.findByLabelText('Today summary');
    expect(screen.getByText('Added 1 task')).toBeOnTheScreen();
  });

  it('after 60 s with no result the Sorting row becomes "Couldn’t sort your note · Try again"', async () => {
    const { store } = await renderToday(RESULT_TIMEOUT_MS + 60_000);
    await save(store, 'text', 'Pay the water bill');
    await advance(10);
    // The mock's result is set to arrive after the timeout: nothing arrives in time.
    await advance(RESULT_TIMEOUT_MS - 20);
    expect(screen.getByText(SORTING_LABEL)).toBeOnTheScreen();
    await advance(20);
    expect(screen.queryByText(SORTING_LABEL)).not.toBeOnTheScreen();
    expect(screen.getByText('Couldn’t sort your note')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.getByText('Pay the water bill')).toBeOnTheScreen();
  });

  describe('offline (US-01)', () => {
    it('a typed task shows on Today right away, even before the request answers', async () => {
      const { store } = await renderToday();
      await save(store, 'text', 'Pay the water bill');
      expect(screen.getByText('Pay the water bill')).toBeOnTheScreen();
      expect(screen.getByText(SORTING_LABEL)).toBeOnTheScreen();
    });

    it('queues a capture that fails with a network error and keeps the typed text visible', async () => {
      const { api, store } = await renderToday();
      api.failNext('network_error');
      await save(store, 'text', 'Pay the water bill');
      await advance(10);
      expect(screen.getByText('Saved on this device')).toBeOnTheScreen();
      expect(screen.getByText(QUEUED_DETAIL)).toBeOnTheScreen();
      expect(screen.getByText('Pay the water bill')).toBeOnTheScreen();
      expect(screen.queryByText(SORTING_LABEL)).not.toBeOnTheScreen();
    });

    it('retries when the app returns to the foreground, then the tasks arrive as usual', async () => {
      const { api, store } = await renderToday();
      const spy = jest.spyOn(api, 'processCapture');
      api.failNext('network_error');
      await save(store, 'voice', 'Call the dentist, buy stamps');
      await advance(10);
      expect(screen.getByText('Saved on this device')).toBeOnTheScreen();
      // Moving to the background does nothing.
      await act(async () => appStateHandlers.forEach((h) => h('background')));
      expect(spy).toHaveBeenCalledTimes(1);
      await act(async () => appStateHandlers.forEach((h) => h('active')));
      await advance(1600);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('Saved on this device')).not.toBeOnTheScreen();
      expect(screen.getByText('Added 2 tasks')).toBeOnTheScreen();
    });

    it('a refused capture shows Try again instead of vanishing', async () => {
      const { api, store } = await renderToday();
      api.failNext('internal_error');
      await save(store, 'text', 'Pay the water bill');
      await advance(10);
      expect(screen.getByText('Couldn’t sort your note')).toBeOnTheScreen();
      await act(async () => {
        fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
      });
      await advance(1600);
      expect(screen.getByText('Added 1 task')).toBeOnTheScreen();
    });
  });
});
