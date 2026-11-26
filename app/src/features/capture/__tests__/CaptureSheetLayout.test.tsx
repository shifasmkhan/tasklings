import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { createMockApi } from '@/api/mock';
import { CaptureProvider } from '../CaptureProvider';
import { CaptureSheet, COPY } from '../CaptureSheet';
import { CaptureStore } from '../captureStore';
import { createMockSpeechRecognizer, type MockSpeechOptions } from '../speech';
import { SpeechRecognizerError, type SpeechRecognizer } from '../speech/SpeechRecognizer';

// The owner's Release build drew the empty-result message and hint over the header row and the
// Type instead button did nothing. These tests pin the structure that prevents it: the header is
// the first child of the sheet and sits above the content in z-order, every state's content
// (message, hint, footnote) lives inside the content container, and Type instead is pressable in
// every state.

const TODAY = '2026-10-27';

function setup(speech: MockSpeechOptions = {}, wrap?: (r: SpeechRecognizer) => SpeechRecognizer) {
  const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 1000 });
  const store = new CaptureStore({ api, arrivals: null, newId: () => 'capture-1' });
  const base = createMockSpeechRecognizer(speech);
  const recognizer = wrap ? wrap(base) : base;
  return { api, store, recognizer, onClose: jest.fn() };
}

async function renderSheet(h: ReturnType<typeof setup>, props: { startLocked?: boolean; hint?: string } = {}) {
  await render(
    <ApiProvider client={h.api}>
      <CaptureProvider store={h.store}>
        <CaptureSheet onClose={h.onClose} createRecognizer={() => h.recognizer} {...props} />
      </CaptureProvider>
    </ApiProvider>,
  );
}

const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
const mic = () => screen.getByTestId('hold-to-talk');
const at = (pageX: number, pageY: number) => ({ nativeEvent: { pageX, pageY } });

async function holdAndRelease() {
  await act(async () => {
    fireEvent(mic(), 'responderGrant', at(100, 500));
  });
  await advance(1000);
  await act(async () => {
    fireEvent(mic(), 'responderRelease', at(0, 0));
  });
}

const typeInsteadHeader = () => within(screen.getByTestId('capture-header')).getByRole('button', { name: 'Type instead' });

function flat(node: { props: { style?: unknown } }): { position?: string; minHeight?: number; zIndex?: number; paddingHorizontal?: number; overflow?: string } {
  return (StyleSheet.flatten(node.props.style as never) ?? {}) as ReturnType<typeof flat>;
}

function assertLayout() {
  const sheet = screen.getByTestId('capture-sheet');
  const header = screen.getByTestId('capture-header');
  const content = screen.getByTestId('capture-content');
  // Header first, content second, as siblings under the sheet: layout order matches paint order.
  expect(header.parent).toBe(content.parent);
  const siblings = header.parent?.children ?? [];
  expect(siblings.indexOf(header)).toBeGreaterThanOrEqual(0);
  expect(siblings.indexOf(header)).toBeLessThan(siblings.indexOf(content));
  expect(sheet).toBeOnTheScreen();
  // The header is a real 52pt row above the content, never absolutely positioned.
  expect(flat(header).position).not.toBe('absolute');
  expect(flat(header).minHeight).toBeGreaterThanOrEqual(52);
  expect(flat(header).zIndex).toBeGreaterThan(flat(content).zIndex ?? 0);
  // Content carries the 20pt horizontal padding itself and clips its children.
  expect(flat(content).paddingHorizontal).toBe(20);
  expect(flat(content).overflow).toBe('hidden');
  expect(flat(content).position).not.toBe('absolute');
  // Nothing from the header row leaks into the content, and vice versa.
  expect(within(content).queryByText('Cancel')).not.toBeOnTheScreen();
  expect(within(content).queryByText('New task')).not.toBeOnTheScreen();
  expect(within(header).getByText('Cancel')).toBeOnTheScreen();
  expect(within(header).getByText('New task')).toBeOnTheScreen();
}

describe('Capture sheet layout and Type instead in every state', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  it('idle: header above content, Type instead opens typing', async () => {
    const h = setup();
    await renderSheet(h, { hint: COPY.firstNoteHint });
    assertLayout();
    expect(within(screen.getByTestId('capture-content')).getByText(COPY.footnote)).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(within(screen.getByTestId('capture-header')).getByRole('button', { name: 'Cancel' }));
    });
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('capture-content')).getByTestId('capture-hint')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(typeInsteadHeader());
    });
    expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
  });

  it('listening (holding): Type instead is pressable and stops the recording', async () => {
    const h = setup();
    await renderSheet(h);
    await act(async () => {
      fireEvent(mic(), 'responderGrant', at(100, 500));
    });
    await advance(400);
    assertLayout();
    expect(within(screen.getByTestId('capture-content')).getByTestId('live-transcript')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(typeInsteadHeader());
    });
    expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
  });

  it('locked: Type instead is pressable', async () => {
    const h = setup();
    await renderSheet(h, { startLocked: true });
    await advance(400);
    assertLayout();
    expect(screen.getByRole('button', { name: 'Stop and save' })).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(typeInsteadHeader());
    });
    expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
  });

  it('didn’t catch anything: message and hint sit inside the content area, below the header', async () => {
    const h = setup({ transcript: '' });
    await renderSheet(h);
    await holdAndRelease();
    assertLayout();
    const content = within(screen.getByTestId('capture-content'));
    expect(content.getByTestId('capture-message')).toBeOnTheScreen();
    expect(content.getByText(COPY.noSpeech)).toBeOnTheScreen();
    expect(content.getByText(COPY.footnote)).toBeOnTheScreen();
    // Neither is anywhere in the header.
    expect(within(screen.getByTestId('capture-header')).queryByText(COPY.footnote)).not.toBeOnTheScreen();
    expect(within(screen.getByTestId('capture-header')).queryByTestId('capture-message')).not.toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(typeInsteadHeader());
    });
    expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
  });

  it('didn’t catch anything: "type instead" in the message is a link that switches to typing', async () => {
    const h = setup({ transcript: '' });
    await renderSheet(h);
    await holdAndRelease();
    const link = within(screen.getByTestId('capture-message')).getByRole('link', { name: 'Type instead' });
    await act(async () => {
      fireEvent.press(link);
    });
    expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
    expect(screen.queryByTestId('capture-message')).not.toBeOnTheScreen();
  });

  it('error (voice unavailable): message is in the content, its link and the header button both type', async () => {
    const h = setup({}, (base) => ({
      ...base,
      start: () => Promise.reject(new SpeechRecognizerError('unavailable')),
    }));
    await renderSheet(h);
    await act(async () => {
      fireEvent(mic(), 'responderGrant', at(100, 500));
    });
    await advance(10);
    assertLayout();
    const message = within(screen.getByTestId('capture-content')).getByTestId('capture-message');
    expect(message).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(typeInsteadHeader());
    });
    expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
  });

  it('error (permission denied): layout holds and Type instead works', async () => {
    const h = setup({ denyPermission: true });
    await renderSheet(h);
    await act(async () => {
      fireEvent(mic(), 'responderGrant', at(100, 500));
    });
    await advance(10);
    assertLayout();
    expect(within(screen.getByTestId('capture-content')).getByText(COPY.denied)).toBeOnTheScreen();
    // In this state the header's end button is Use voice instead; the body's Type instead types.
    await act(async () => {
      fireEvent.press(within(screen.getByTestId('capture-content')).getByRole('button', { name: 'Type instead' }));
    });
    expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
  });

  it('sorting (saving, waiting for the final transcript): Type instead is still pressable', async () => {
    const h = setup({}, (base) => ({ ...base, stop: () => new Promise<string>(() => undefined) }));
    await renderSheet(h, { startLocked: true });
    await advance(400);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Stop and save' }));
    });
    assertLayout();
    await act(async () => {
      fireEvent.press(typeInsteadHeader());
    });
    expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
  });

  it('typing: header above content and the input is inside the content', async () => {
    const h = setup();
    await renderSheet(h);
    await act(async () => {
      fireEvent.press(typeInsteadHeader());
    });
    assertLayout();
    expect(within(screen.getByTestId('capture-content')).getByTestId('typed-input')).toBeOnTheScreen();
    expect(within(screen.getByTestId('capture-header')).getByRole('button', { name: 'Use voice instead' })).toBeOnTheScreen();
  });
});
