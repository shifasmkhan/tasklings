import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Linking, StyleSheet } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { createMockApi } from '@/api/mock';
import { dark, light, MIN_TOUCH } from '@/theme/colors';
import { CaptureProvider } from '../CaptureProvider';
import { CaptureSheet, COPY, MAX_TYPED_CHARS } from '../CaptureSheet';
import { CaptureStore } from '../captureStore';
import { createMockSpeechRecognizer, type MockSpeechOptions } from '../speech';
import { MAX_RECORDING_MS } from '../useCaptureSession';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme,
}));

const TODAY = '2026-10-27';
// Words arrive two per 400 ms tick: after 1200 ms the recognizer has said "Call the dentist to move the".
const SIX_WORDS = 'Call the dentist to move the';

function setup(speech: MockSpeechOptions = {}) {
  const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 1000 });
  const store = new CaptureStore({ api, arrivals: null, newId: () => 'capture-1' });
  const recognizer = createMockSpeechRecognizer(speech);
  const submit = jest.spyOn(store, 'submit');
  const cancel = jest.spyOn(recognizer, 'cancel');
  const processCapture = jest.spyOn(api, 'processCapture');
  const onClose = jest.fn();
  const createRecognizer = () => recognizer;
  return { api, store, recognizer, submit, cancel, processCapture, onClose, createRecognizer };
}

async function renderSheet(h: ReturnType<typeof setup>, startLocked = false) {
  await render(
    <ApiProvider client={h.api}>
      <CaptureProvider store={h.store}>
        <CaptureSheet onClose={h.onClose} createRecognizer={h.createRecognizer} startLocked={startLocked} />
      </CaptureProvider>
    </ApiProvider>,
  );
}

const mic = () => screen.getByTestId('hold-to-talk');
const at = (pageX: number, pageY: number) => ({ nativeEvent: { pageX, pageY } });
const advance = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

async function press(x = 100, y = 500) {
  await act(async () => {
    fireEvent(mic(), 'responderGrant', at(x, y));
  });
}
async function moveTo(x: number, y: number) {
  await act(async () => {
    fireEvent(mic(), 'responderMove', at(x, y));
  });
}
async function lift() {
  await act(async () => {
    fireEvent(mic(), 'responderRelease', at(0, 0));
  });
}

describe('Capture sheet: voice (US-01)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockScheme = 'light';
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  });
  afterEach(() => jest.useRealTimers());

  it('hold the mic, talk, release: saves the transcript, hands it to the store and closes the sheet', async () => {
    const h = setup();
    await renderSheet(h);
    await press();
    await advance(1200);
    // Live transcript only: the words, not tasks.
    expect(screen.getByTestId('live-transcript')).toHaveTextContent(SIX_WORDS);
    expect(screen.getByText('Listening · 0:01')).toBeOnTheScreen();
    expect(h.submit).not.toHaveBeenCalled();
    await lift();
    expect(h.submit).toHaveBeenCalledWith({ source: 'voice', transcript: SIX_WORDS });
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.processCapture).toHaveBeenCalledWith(
      expect.objectContaining({ capture_id: 'capture-1', transcript: SIX_WORDS, timezone: expect.any(String) }),
    );
  });

  it('opened by a tap on Today\u2019s mic, it starts locked recording straight away', async () => {
    const h = setup();
    await renderSheet(h, true);
    await advance(1200);
    expect(screen.getByText(/Recording, locked/)).toBeOnTheScreen();
    expect(screen.getByTestId('live-transcript')).toHaveTextContent(SIX_WORDS);
    // One tap on the button saves.
    await press();
    await lift();
    expect(h.submit).toHaveBeenCalledWith({ source: 'voice', transcript: expect.stringMatching(/^Call the dentist/) });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('opened without the flag (a long press on Today), it waits for the user', async () => {
    const h = setup();
    await renderSheet(h, false);
    await advance(1200);
    expect(screen.queryByTestId('live-transcript')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Record a task' })).toBeOnTheScreen();
  });

  it('auto-start asks for permission and shows the denied message when refused', async () => {
    const h = setup({ denyPermission: true });
    await renderSheet(h, true);
    await advance(10);
    expect(screen.getByText(COPY.denied)).toBeOnTheScreen();
  });

  it('shows the waveform and a running timer while recording', async () => {
    const h = setup();
    await renderSheet(h);
    expect(screen.queryByTestId('waveform', { includeHiddenElements: true })).not.toBeOnTheScreen();
    await press();
    await advance(6000);
    expect(screen.getByText('Listening · 0:06')).toBeOnTheScreen();
    expect(screen.getByTestId('waveform', { includeHiddenElements: true }).props.children).toHaveLength(28);
  });

  it('a quick tap locks recording; tapping again stops and saves', async () => {
    const h = setup();
    await renderSheet(h);
    await press();
    await advance(100);
    await lift();
    expect(screen.getByText('Recording, locked · 0:00')).toBeOnTheScreen();
    expect(h.submit).not.toHaveBeenCalled();
    await advance(2000);
    expect(screen.getByRole('button', { name: 'Stop and save' })).toBeOnTheScreen();
    await press();
    await lift();
    expect(h.submit).toHaveBeenCalledWith({ source: 'voice', transcript: 'Call the dentist to move the cleaning, buy stamps at' });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('sliding up while holding locks recording, and letting go does not save', async () => {
    const h = setup();
    await renderSheet(h);
    await press(100, 500);
    await advance(1000);
    await moveTo(100, 430);
    await lift();
    expect(screen.getByText(/Recording, locked/)).toBeOnTheScreen();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('if the system takes the touch (a permission prompt, a call) the recording locks instead of being lost', async () => {
    const h = setup();
    await renderSheet(h);
    await press();
    await advance(800);
    await act(async () => {
      fireEvent(mic(), 'responderTerminate', at(0, 0));
    });
    expect(screen.getByText(/Recording, locked/)).toBeOnTheScreen();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('a short slide up is not enough to lock', async () => {
    const h = setup();
    await renderSheet(h);
    await press(100, 500);
    await advance(1000);
    await moveTo(100, 470);
    await lift();
    expect(h.submit).toHaveBeenCalledTimes(1); // treated as a plain release of a hold
  });

  it('sliding left cancels: nothing is saved and the sheet stays open', async () => {
    const h = setup();
    await renderSheet(h);
    await press(200, 500);
    await advance(1000);
    await moveTo(100, 500);
    await lift();
    expect(h.cancel).toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('live-transcript')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Record a task' })).toBeOnTheScreen();
  });

  it('Discard recording cancels a locked recording', async () => {
    const h = setup();
    await renderSheet(h);
    await press();
    await advance(50);
    await lift();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Discard recording' }));
    });
    expect(h.cancel).toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Record a task' })).toBeOnTheScreen();
  });

  it('the 2-minute cap saves by itself', async () => {
    const h = setup();
    await renderSheet(h);
    await press();
    await advance(50);
    await lift(); // locked
    await advance(MAX_RECORDING_MS - 1000);
    expect(h.submit).not.toHaveBeenCalled();
    expect(screen.getByText('Recording, locked · 1:59')).toBeOnTheScreen();
    await advance(1500);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]?.[0].transcript).toMatch(/^Call the dentist/);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Two minute limit reached. Saving.');
  });

  it('a recording with no speech saves nothing and says so', async () => {
    const h = setup({ transcript: '' });
    await renderSheet(h);
    await press();
    await advance(1000);
    await lift();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(screen.getByText(COPY.noSpeech)).toBeOnTheScreen();
  });

  describe('permission denied', () => {
    it('shows a short message with a Type instead path', async () => {
      const h = setup({ denyPermission: true });
      await renderSheet(h);
      await press();
      expect(screen.getByText(COPY.denied)).toBeOnTheScreen();
      expect(screen.queryByTestId('hold-to-talk')).not.toBeOnTheScreen();
      await act(async () => {
        fireEvent.press(screen.getAllByRole('button', { name: 'Type instead' }).at(-1)!);
      });
      expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
    });

    it('offers Open Settings', async () => {
      const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
      const h = setup({ denyPermission: true });
      await renderSheet(h);
      await press();
      await act(async () => {
        fireEvent.press(screen.getByRole('button', { name: 'Open Settings' }));
      });
      expect(open).toHaveBeenCalled();
    });
  });

  describe('VoiceOver (no hold gesture needed)', () => {
    const activate = () =>
      act(async () => {
        fireEvent(mic(), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
      });

    it('double-tap starts locked recording and double-tap again stops and saves', async () => {
      const h = setup();
      await renderSheet(h);
      expect(mic().props.accessibilityHint).toMatch(/double-tap to start recording/);
      await activate();
      expect(screen.getByText(/Recording, locked/)).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Stop and save' })).toBeOnTheScreen();
      await advance(1200);
      await activate();
      expect(h.submit).toHaveBeenCalledWith({ source: 'voice', transcript: SIX_WORDS });
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });

    it('offers a Cancel recording action while recording', async () => {
      const h = setup();
      await renderSheet(h);
      expect(mic().props.accessibilityActions.map((a: { name: string }) => a.name)).toEqual(['activate']);
      await activate();
      expect(mic().props.accessibilityActions).toContainEqual({ name: 'cancel', label: 'Cancel recording' });
      await act(async () => {
        fireEvent(mic(), 'accessibilityAction', { nativeEvent: { actionName: 'cancel' } });
      });
      expect(h.cancel).toHaveBeenCalled();
      expect(h.submit).not.toHaveBeenCalled();
    });
  });

  it('header Cancel closes without saving and stops the microphone', async () => {
    const h = setup();
    await renderSheet(h);
    await press();
    await advance(1000);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(h.cancel).toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('leaving the screen any other way turns the microphone off', async () => {
    const h = setup();
    await renderSheet(h);
    await press();
    await advance(100);
    h.cancel.mockClear();
    await screen.unmount();
    expect(h.cancel).toHaveBeenCalled();
  });
});

describe('Capture sheet: typing (US-02)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockScheme = 'light';
  });
  afterEach(() => jest.useRealTimers());

  async function openTyping(h: ReturnType<typeof setup>) {
    await renderSheet(h);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Type instead' }));
    });
    return screen.getByTestId('typed-input');
  }

  it('Type instead opens the keyboard in one tap: the field is focused as it appears', async () => {
    const h = setup();
    const input = await openTyping(h);
    expect(input.props.autoFocus).toBe(true);
  });

  it('Return saves: creates a text capture and closes the sheet', async () => {
    const h = setup();
    const input = await openTyping(h);
    await act(async () => {
      fireEvent.changeText(input, '  Pay the water bill  ');
    });
    await act(async () => {
      fireEvent(input, 'submitEditing', { nativeEvent: { text: '  Pay the water bill  ' } });
    });
    expect(h.submit).toHaveBeenCalledWith({ source: 'text', transcript: 'Pay the water bill' });
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.processCapture).toHaveBeenCalledTimes(1);
  });

  it('Return makes no new line and an empty note saves nothing', async () => {
    const h = setup();
    const input = await openTyping(h);
    expect(input.props.submitBehavior).toBe('submit');
    expect(input.props.returnKeyType).toBe('done');
    await act(async () => {
      fireEvent(input, 'submitEditing', { nativeEvent: { text: '   ' } });
    });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('limits the note length well under the 64 KiB request limit', async () => {
    const h = setup();
    const input = await openTyping(h);
    expect(input.props.maxLength).toBe(MAX_TYPED_CHARS);
  });

  it('Type instead while recording stops the recording without saving', async () => {
    const h = setup();
    await renderSheet(h);
    await press();
    await advance(50);
    await lift();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Type instead' }));
    });
    expect(h.cancel).toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(screen.getByTestId('typed-input')).toBeOnTheScreen();
  });

  it('Use voice instead goes back to the mic', async () => {
    const h = setup();
    await openTyping(h);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Use voice instead' }));
    });
    expect(screen.getByRole('button', { name: 'Record a task' })).toBeOnTheScreen();
  });
});

describe('Capture sheet: accessibility and appearance', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockScheme = 'light';
  });
  afterEach(() => jest.useRealTimers());

  it('every control has a VoiceOver name', async () => {
    const h = setup();
    await renderSheet(h);
    for (const name of ['Cancel', 'Type instead', 'Record a task']) {
      expect(screen.getByRole('button', { name })).toBeOnTheScreen();
    }
    expect(screen.getByRole('heading', { name: 'New task' })).toBeOnTheScreen();
  });

  it('controls are at least 44 points', async () => {
    const h = setup();
    await renderSheet(h);
    const min = (name: string) => StyleSheet.flatten(screen.getByRole('button', { name }).props.style) as { minHeight?: number; height?: number };
    expect(min('Cancel').minHeight).toBeGreaterThanOrEqual(MIN_TOUCH);
    expect(min('Type instead').height).toBeGreaterThanOrEqual(MIN_TOUCH);
    expect((StyleSheet.flatten(mic().props.style) as { width: number }).width).toBeGreaterThanOrEqual(MIN_TOUCH);
  });

  it('text scales with Dynamic Type: nothing turns font scaling off', async () => {
    const h = setup();
    await renderSheet(h);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Type instead' }));
    });
    const input = screen.getByTestId('typed-input');
    expect(input.props.allowFontScaling).not.toBe(false);
    expect(screen.queryAllByText(/./).every((t) => t.props.allowFontScaling !== false)).toBe(true);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('uses the %s palette', async (scheme, palette) => {
    mockScheme = scheme;
    const h = setup();
    await renderSheet(h);
    const title = screen.getByRole('heading', { name: 'New task' });
    expect(StyleSheet.flatten(title.props.style)).toMatchObject({ color: palette.text });
  });
});
