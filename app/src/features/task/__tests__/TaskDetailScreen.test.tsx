import { act, fireEvent, render, screen, userEvent } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { AccessibilityInfo } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { makeTask } from '@/api/fixtures';
import { createMockApi, type MockApiClient } from '@/api/mock';
import type { Task } from '@/api/types';
import { addDays, localIsoDate } from '@/lib/dates';
import { dark, light } from '@/theme/colors';
import { TaskDetailScreen } from '../TaskDetailScreen';
import { AUTOSAVE_DELAY_MS } from '../logic';
import { SAVE_ERROR } from '../useTaskDetail';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme,
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));

const TODAY = localIsoDate();
const ID = 'task-1';

function fixtures(over: Partial<Task> = {}): Task[] {
  return [makeTask({ id: ID, title: 'Text the neighbour', kind: 'quick', effort_min: 10, ...over }, TODAY)];
}

async function renderDetail(
  tasks: Task[] = fixtures(),
  enrichmentsFor?: (id: string) => { type: string; value: string }[],
): Promise<{ api: MockApiClient; onBack: jest.Mock }> {
  const api = createMockApi({ tasks, today: () => TODAY });
  const onBack = jest.fn();
  await render(
    <ApiProvider client={api}>
      <TaskDetailScreen taskId={ID} onBack={onBack} today={TODAY} enrichmentsFor={enrichmentsFor ?? (() => [])} />
    </ApiProvider>,
  );
  await screen.findByLabelText('Task title');
  return { api, onBack };
}

const stored = (api: MockApiClient) => api.snapshot().find((t) => t.id === ID);

describe('Task detail (US-05)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockScheme = 'light';
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('inline editing', () => {
    it('saves a title edit by itself after a short pause, with no Save button', async () => {
      const { api } = await renderDetail();
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeOnTheScreen();
      await fireEvent.changeText(screen.getByLabelText('Task title'), 'Text the neighbour today');
      expect(stored(api)?.title).toBe('Text the neighbour');
      await act(async () => {
        jest.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      });
      expect(stored(api)?.title).toBe('Text the neighbour today');
      expect(screen.getByLabelText('Task title').props.value).toBe('Text the neighbour today');
    });

    it('saves on blur without waiting for the pause', async () => {
      const { api } = await renderDetail();
      const input = screen.getByLabelText('Task title');
      await fireEvent.changeText(input, 'Call the neighbour');
      await fireEvent(input, 'blur');
      expect(stored(api)?.title).toBe('Call the neighbour');
    });

    it('puts the old title back with a quiet inline error when the save fails', async () => {
      const { api } = await renderDetail();
      const input = screen.getByLabelText('Task title');
      await fireEvent.changeText(input, 'Call the neighbour');
      api.failNext('network_error');
      await fireEvent(input, 'blur');
      expect(screen.getByLabelText('Task title').props.value).toBe('Text the neighbour');
      expect(screen.getByRole('alert')).toHaveTextContent(SAVE_ERROR);
      expect(stored(api)?.title).toBe('Text the neighbour');
    });

    it('goes back to the saved title when it is cleared, without a call', async () => {
      const { api } = await renderDetail();
      const spy = jest.spyOn(api, 'updateTask');
      const input = screen.getByLabelText('Task title');
      await fireEvent.changeText(input, '   ');
      await fireEvent(input, 'blur');
      expect(spy).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Task title').props.value).toBe('Text the neighbour');
    });

    it('changes effort from the chip menu and never sends the AI estimate', async () => {
      const { api } = await renderDetail();
      const spy = jest.spyOn(api, 'updateTask');
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Effort: 10 min' }));
      await user.press(screen.getByRole('menuitem', { name: '30 min' }));
      expect(spy).toHaveBeenCalledWith(ID, { effort_min: 30 });
      expect(Object.keys(spy.mock.calls[0]?.[1] ?? {})).not.toContain('effort_min_initial');
      expect(stored(api)?.effort_min).toBe(30);
      expect(stored(api)?.effort_min_initial).toBe(10);
      expect(screen.getByRole('button', { name: 'Effort: 30 min' })).toBeOnTheScreen();
      expect(screen.queryByLabelText('Effort')).not.toBeOnTheScreen();
    });

    it('changes the due date and can clear it', async () => {
      const { api } = await renderDetail(fixtures({ due_date: TODAY }));
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Due date: Due today' }));
      await user.press(screen.getByRole('menuitem', { name: 'Tomorrow' }));
      expect(screen.getByRole('button', { name: 'Due date: Due tomorrow' })).toBeOnTheScreen();
      await user.press(screen.getByRole('button', { name: 'Due date: Due tomorrow' }));
      await user.press(screen.getByRole('menuitem', { name: 'No due date' }));
      expect(stored(api)?.due_date).toBeNull();
    });

    it('changes the kind from the chip menu', async () => {
      const { api } = await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Type: Quick win' }));
      await user.press(screen.getByRole('menuitem', { name: 'Errand' }));
      expect(stored(api)?.kind).toBe('errand');
    });

    it('reverts a chip change and shows the error when the save fails', async () => {
      const { api } = await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Effort: 10 min' }));
      api.failNext('network_error');
      await user.press(screen.getByRole('menuitem', { name: '1 hr' }));
      expect(screen.getByRole('button', { name: 'Effort: 10 min' })).toBeOnTheScreen();
      expect(screen.getByRole('alert')).toHaveTextContent(SAVE_ERROR);
    });

    it('opens one menu at a time', async () => {
      await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Effort: 10 min' }));
      await user.press(screen.getByRole('button', { name: 'Due date: No due date' }));
      expect(screen.queryByLabelText('Effort')).not.toBeOnTheScreen();
      expect(screen.getByLabelText('Due date')).toBeOnTheScreen();
    });
  });

  describe('Needs a look', () => {
    it('shows for a needs_review task and clears after any edit', async () => {
      const { api } = await renderDetail(fixtures({ needs_review: true }));
      expect(screen.getByText('Needs a look')).toBeOnTheScreen();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Effort: 10 min' }));
      await user.press(screen.getByRole('menuitem', { name: '15 min' }));
      expect(screen.queryByText('Needs a look')).not.toBeOnTheScreen();
      expect(stored(api)?.needs_review).toBe(false);
    });

    it('is absent on a normal task', async () => {
      await renderDetail();
      expect(screen.queryByText('Needs a look')).not.toBeOnTheScreen();
    });
  });

  describe('script card', () => {
    it('shows the script with Copy for a quick task, and Copy writes it to the clipboard', async () => {
      await renderDetail(fixtures({ script: 'Hello, this is a synthetic script.' }));
      expect(screen.getByText('Hello, this is a synthetic script.')).toBeOnTheScreen();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Copy script' }));
      expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Hello, this is a synthetic script.');
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeOnTheScreen();
    });

    it('has no Call button', async () => {
      await renderDetail(fixtures({ script: 'Hello' }));
      expect(screen.queryByRole('button', { name: /call/i })).not.toBeOnTheScreen();
    });

    it('renders nothing when there is no script', async () => {
      await renderDetail();
      expect(screen.queryByText('WHAT TO SAY')).not.toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: /copy/i })).not.toBeOnTheScreen();
    });
  });

  describe('Found for you', () => {
    it('shows Maps phone, address and hours only, as plain text with no links', async () => {
      await renderDetail(fixtures(), () => [
        { type: 'phone', value: '(555) 010-0100' },
        { type: 'address', value: '1 Example Road' },
        { type: 'hours', value: 'Open until 5 PM' },
        { type: 'url', value: 'https://example.com/page' },
        { type: 'note', value: 'a stray note' },
      ]);
      expect(screen.getByText('FOUND FOR YOU')).toBeOnTheScreen();
      expect(screen.getByText('(555) 010-0100')).toBeOnTheScreen();
      expect(screen.getByText('1 Example Road')).toBeOnTheScreen();
      expect(screen.getByText('Open until 5 PM')).toBeOnTheScreen();
      expect(screen.queryByText(/example\.com/)).not.toBeOnTheScreen();
      expect(screen.queryByText('a stray note')).not.toBeOnTheScreen();
      expect(screen.queryByRole('link')).not.toBeOnTheScreen();
    });

    it('is absent when there is nothing found', async () => {
      await renderDetail();
      expect(screen.queryByText('FOUND FOR YOU')).not.toBeOnTheScreen();
    });
  });

  it('has no "From your voice note" section: no API exposes the transcript', async () => {
    await renderDetail(fixtures({ capture_id: '00000000-0000-4000-8000-0000000000aa' }));
    expect(screen.queryByText(/voice note/i)).not.toBeOnTheScreen();
  });

  describe('actions', () => {
    it('Done completes the task and offers Undo, which reopens it', async () => {
      const { api } = await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Mark done' }));
      expect(stored(api)?.status).toBe('done');
      expect(screen.getByText('Done: Text the neighbour')).toBeOnTheScreen();
      await user.press(screen.getByRole('button', { name: 'Undo' }));
      expect(stored(api)?.status).toBe('open');
      expect(screen.getByRole('button', { name: 'Mark done' })).toBeOnTheScreen();
    });

    it('Tomorrow defers the task and Undo brings it back', async () => {
      const { api } = await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Move to tomorrow' }));
      expect(stored(api)?.planned_for).toBe(addDays(TODAY, 1));
      expect(screen.getAllByText('Moved to tomorrow').length).toBeGreaterThan(0);
      await user.press(screen.getByRole('button', { name: 'Undo' }));
      expect(stored(api)?.planned_for).toBe(TODAY);
    });

    it('Drop drops the task with no reason', async () => {
      const { api } = await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Drop' }));
      expect(stored(api)?.status).toBe('dropped');
      expect(stored(api)?.dropped_reason).toBeNull();
    });

    it('the Undo toast lasts 5 seconds', async () => {
      await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Mark done' }));
      await act(async () => {
        jest.advanceTimersByTime(4900);
      });
      expect(screen.getByRole('button', { name: 'Undo' })).toBeOnTheScreen();
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeOnTheScreen();
    });

    it('the Undo toast lasts 10 seconds with VoiceOver on', async () => {
      jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
      await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Mark done' }));
      await act(async () => {
        jest.advanceTimersByTime(9900);
      });
      expect(screen.getByRole('button', { name: 'Undo' })).toBeOnTheScreen();
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeOnTheScreen();
    });

    it('keeps the task open and says so when an action fails', async () => {
      const { api } = await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      api.failNext('network_error');
      await user.press(screen.getByRole('button', { name: 'Mark done' }));
      expect(screen.getByText("Couldn't save that. Try again.")).toBeOnTheScreen();
      expect(stored(api)?.status).toBe('open');
      expect(screen.getByRole('button', { name: 'Mark done' })).toBeOnTheScreen();
    });

    it('locks editing once the task is done', async () => {
      await renderDetail();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(screen.getByRole('button', { name: 'Mark done' }));
      expect(screen.getByLabelText('Task title').props.editable).toBe(false);
      expect(screen.getByRole('button', { name: 'Back to Today' })).toBeOnTheScreen();
    });
  });

  describe('missing task and accessibility', () => {
    it('says so when the task is not on Today', async () => {
      const api = createMockApi({ tasks: [], today: () => TODAY });
      const onBack = jest.fn();
      await render(
        <ApiProvider client={api}>
          <TaskDetailScreen taskId="nope" onBack={onBack} today={TODAY} enrichmentsFor={() => []} />
        </ApiProvider>,
      );
      expect(await screen.findByText("This task isn't on Today any more.")).toBeOnTheScreen();
      await userEvent.setup({ advanceTimers: jest.advanceTimersByTime }).press(screen.getByRole('button', { name: 'Back to Today' }));
      expect(onBack).toHaveBeenCalled();
    });

    it('offers a retry when loading fails', async () => {
      const api = createMockApi({ tasks: fixtures(), today: () => TODAY });
      api.failNext('network_error');
      await render(
        <ApiProvider client={api}>
          <TaskDetailScreen taskId={ID} onBack={jest.fn()} today={TODAY} enrichmentsFor={() => []} />
        </ApiProvider>,
      );
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.press(await screen.findByRole('button', { name: 'Try again' }));
      expect(await screen.findByLabelText('Task title')).toBeOnTheScreen();
    });

    it('labels every control and keeps 44pt targets', async () => {
      await renderDetail(fixtures({ script: 'Hello' }));
      for (const name of ['Type: Quick win', 'Effort: 10 min', 'Due date: No due date', 'Copy script', 'Mark done', 'Move to tomorrow', 'Drop']) {
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
      await renderDetail();
      expect(screen.getByLabelText('Task title')).toHaveStyle({ color: palette.text });
    });
  });
});
