import { act, render, screen, userEvent } from '@testing-library/react-native';
import { AccessibilityInfo, AppState } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { ApiError } from '@/api/errors';
import { makeTask } from '@/api/fixtures';
import { createMockApi, type MockApiClient } from '@/api/mock';
import { TodayScreen, type TodayNavigation } from '@/features/today/TodayScreen';
import { localIsoDate } from '@/lib/dates';
import { CaptureProvider } from '../CaptureProvider';
import { CaptureStore } from '../captureStore';

// Same swipe double as TodayCapture.test.tsx: gestures can't load headlessly.
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

async function renderToday() {
  const api: MockApiClient = createMockApi({
    tasks: [makeTask({ id: 'existing', title: 'Text the neighbour', kind: 'quick', effort_min: 5 }, TODAY)],
    today: () => TODAY,
    captureResultDelayMs: 100,
  });
  const store = new CaptureStore({ api, arrivals: null, newId: () => '50000000-0000-4000-a000-000000000001' });
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

describe('Undo after "Added N tasks" calls undo_capture (US-09)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }));
  });
  afterEach(() => jest.useRealTimers());

  async function addedTwo() {
    const ctx = await renderToday();
    await act(async () => {
      ctx.store.submit({ source: 'voice', transcript: 'Call the dentist, buy stamps' });
    });
    await advance(300);
    expect(screen.getByText('Added 2 tasks')).toBeOnTheScreen();
    return ctx;
  }

  it('makes one undo_capture call with the capture id, and no drop_task calls', async () => {
    const { api } = await addedTwo();
    const undoCapture = jest.spyOn(api, 'undoCapture');
    const dropTask = jest.spyOn(api, 'dropTask');
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(screen.getByRole('button', { name: 'Undo' }));
    await advance(10);
    expect(undoCapture).toHaveBeenCalledTimes(1);
    expect(undoCapture).toHaveBeenCalledWith('50000000-0000-4000-a000-000000000001');
    expect(dropTask).not.toHaveBeenCalled();
    expect(screen.queryByText('Call the dentist')).not.toBeOnTheScreen();
    expect(screen.queryByText("Couldn't undo. Try again.")).not.toBeOnTheScreen();
    expect(api.snapshot().map((t) => t.title)).toEqual(['Text the neighbour']);
  });

  it('on undo_expired shows nothing and the tasks stay', async () => {
    const { api } = await addedTwo();
    jest.spyOn(api, 'undoCapture').mockRejectedValueOnce(new ApiError('undo_expired', 'late', 409));
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(screen.getByRole('button', { name: 'Undo' }));
    await advance(50);
    expect(screen.queryByText("Couldn't undo. Try again.")).not.toBeOnTheScreen();
    expect(screen.queryByRole('alert')).not.toBeOnTheScreen();
    expect(screen.getByText('Call the dentist')).toBeOnTheScreen();
    expect(screen.getByText('Buy stamps')).toBeOnTheScreen();
    expect(api.snapshot()).toHaveLength(3);
  });

  it('on any other failure says so, and the tasks are back', async () => {
    const { api } = await addedTwo();
    jest.spyOn(api, 'undoCapture').mockRejectedValueOnce(new ApiError('network_error', 'offline'));
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(screen.getByRole('button', { name: 'Undo' }));
    await advance(50);
    expect(screen.getByText("Couldn't undo. Try again.")).toBeOnTheScreen();
    expect(screen.getByText('Call the dentist')).toBeOnTheScreen();
  });

  it('with the real mock rules: a task completed before Undo makes it expire quietly', async () => {
    const { api } = await addedTwo();
    const added = api.snapshot().find((t) => t.title === 'Call the dentist')!;
    await api.completeTask(added.id);
    await api.undoTask(added.id);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(screen.getByRole('button', { name: 'Undo' }));
    await advance(50);
    expect(screen.queryByText("Couldn't undo. Try again.")).not.toBeOnTheScreen();
    expect(api.snapshot()).toHaveLength(3);
  });
});
