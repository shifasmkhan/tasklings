import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { createMockApi } from '@/api/mock';
import { memoryStore } from '@/features/onboarding/testing';
import { OnboardingProvider } from '@/features/onboarding/OnboardingProvider';
import type { NativeIntentsModule } from '../../../../modules/tasklings-intents/src';
import { CaptureProvider } from '../CaptureProvider';
import { ARM_TTL_MS, armCaptureLaunch, clearCaptureLaunch, peekCaptureLaunch } from '../captureLaunch';
import { CaptureStore } from '../captureStore';
import { IntentLaunchHandler } from '../IntentLaunchHandler';
import { resetIntentLaunchForTests } from '../intentLaunch';

// Entry points (US-01): the App Intent is the only thing that may start the mic; URLs never can.

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;
const mockDismissAll = jest.fn();
let mockParams: Record<string, string> = {};
let mockNavKey: string | undefined = 'root';
jest.mock('expo-router', () => {
  const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Redirect: ({ href }: { href: string }) => <T>{`redirect:${href}`}</T>,
    useRouter: () => ({ push: mockPush, back: mockBack, dismissAll: mockDismissAll, canDismiss: () => true, canGoBack: () => mockCanGoBack, replace: mockReplace }),
    useLocalSearchParams: () => mockParams,
    useRootNavigationState: () => ({ key: mockNavKey }),
    useFocusEffect: () => undefined,
  };
});
jest.mock('@/features/today/TodayScreen', () => {
  const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
  return { TodayScreen: () => <T>today-list</T> };
});

// eslint-disable-next-line import/first
import CaptureRoute from '@/app/capture';
// eslint-disable-next-line import/first
import TodayRoute from '@/app/index';

function fakeNative(initial: boolean) {
  let pending = initial;
  const listeners: (() => void)[] = [];
  const native: NativeIntentsModule = {
    consumePendingLaunch: jest.fn(() => {
      const was = pending;
      pending = false;
      return was;
    }),
    addListener: (_event, l) => {
      listeners.push(l);
      return { remove: () => listeners.splice(listeners.indexOf(l), 1) };
    },
  };
  return {
    native,
    /** The intent ran while the app was alive. */
    fire: () => {
      pending = true;
      listeners.forEach((l) => l());
    },
  };
}

function Harness({ native, onboarded = true, children }: { native: NativeIntentsModule | null; onboarded?: boolean; children?: React.ReactNode }) {
  const api = createMockApi({ tasks: [] });
  const store = new CaptureStore({ api, arrivals: null, newId: () => 'capture-1' });
  return (
    <ApiProvider client={api}>
      <OnboardingProvider store={memoryStore(onboarded)}>
        <CaptureProvider store={store}>
          <IntentLaunchHandler native={native} />
          {children}
        </CaptureProvider>
      </OnboardingProvider>
    </ApiProvider>
  );
}

describe('Entry points (US-01)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    mockNavKey = 'root';
    mockCanGoBack = true;
    clearCaptureLaunch();
    resetIntentLaunchForTests();
  });

  describe('deep link', () => {
    it('opens the sheet idle and ignores every parameter, including start=lock', async () => {
      mockParams = { start: 'lock', hint: 'first', autostart: '1', record: 'true' };
      await render(<Harness native={null}><CaptureRoute /></Harness>);
      expect(await screen.findByTestId('hold-to-talk')).toBeTruthy();
      expect(screen.queryByText(/Recording, locked/)).toBeNull();
      expect(screen.queryByText(/Try: /)).toBeNull();
    });
  });

  describe('closing a cold deep link', () => {
    it('lands on Today when there is nothing to go back to', async () => {
      mockCanGoBack = false;
      await render(<Harness native={null}><CaptureRoute /></Harness>);
      await act(async () => {
        fireEvent.press(await screen.findByLabelText('Cancel'));
      });
      expect(mockReplace).toHaveBeenCalledWith('/');
      expect(mockBack).not.toHaveBeenCalled();
    });

    it('goes back normally when a screen is underneath', async () => {
      await render(<Harness native={null}><CaptureRoute /></Harness>);
      await act(async () => {
        fireEvent.press(await screen.findByLabelText('Cancel'));
      });
      expect(mockBack).toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('Today then applies the onboarding gate (first run goes to onboarding)', async () => {
      await render(<Harness native={null} onboarded={false}><TodayRoute /></Harness>);
      expect(await screen.findByText('redirect:/onboarding')).toBeTruthy();
    });
  });

  describe('pending launch from our own intent', () => {
    it('opens the sheet once and starts locked recording', async () => {
      const { native } = fakeNative(true);
      await render(<Harness native={native}><CaptureRoute /></Harness>);
      expect(mockDismissAll).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith('/capture');
      // The route (mounted here as the navigator would) picks up the armed launch.
      expect(await screen.findByText(/Recording, locked/)).toBeTruthy();
    });

    it('is consumed once: a later foreground does not open or record again', async () => {
      const { native } = fakeNative(true);
      let onAppState: (s: string) => void = () => undefined;
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, l) => {
        onAppState = l as (s: string) => void;
        return { remove: jest.fn() };
      });
      await render(<Harness native={native} />);
      expect(mockPush).toHaveBeenCalledTimes(1);
      await act(async () => onAppState('active'));
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(native.consumePendingLaunch).toHaveBeenCalled();
    });

    it('a launch while the app is alive opens the sheet', async () => {
      const h = fakeNative(false);
      await render(<Harness native={h.native} />);
      expect(mockPush).not.toHaveBeenCalled();
      await act(async () => h.fire());
      expect(mockPush).toHaveBeenCalledWith('/capture');
    });

    it('waits for navigation to be ready', async () => {
      mockNavKey = undefined;
      const { native } = fakeNative(true);
      const view = await render(<Harness native={native} />);
      expect(mockPush).not.toHaveBeenCalled();
      mockNavKey = 'root';
      await view.rerender(<Harness native={native} />);
      expect(mockPush).toHaveBeenCalledTimes(1);
    });

    it('does not record before onboarding: drops the launch', async () => {
      const { native } = fakeNative(true);
      await render(<Harness native={native} onboarded={false}><TodayRoute /></Harness>);
      await screen.findByText('redirect:/onboarding');
      expect(mockPush).not.toHaveBeenCalled();
      expect(peekCaptureLaunch().autoStart).toBe(false);
    });
  });

  describe('Today behind the sheet', () => {
    it('is hidden after an intent launch and comes back when the sheet closes', async () => {
      const { native } = fakeNative(true);
      const view = await render(
        <Harness native={native}>
          <TodayRoute />
          <CaptureRoute />
        </Harness>,
      );
      expect(await screen.findByText(/Recording, locked/)).toBeTruthy();
      expect(screen.queryByText('today-list')).toBeNull();
      // Close the sheet (unmount the route).
      await view.rerender(
        <Harness native={native}>
          <TodayRoute />
        </Harness>,
      );
      expect(await screen.findByText('today-list')).toBeTruthy();
    });

    it('normal launch is unchanged: Today shows, nothing opens, nothing records', async () => {
      const { native } = fakeNative(false);
      await render(<Harness native={native}><TodayRoute /></Harness>);
      expect(await screen.findByText('today-list')).toBeTruthy();
      expect(mockPush).not.toHaveBeenCalled();
      expect(screen.queryByText(/Recording/)).toBeNull();
    });

    it('works where the native module is missing (Expo Go, Jest)', async () => {
      await render(<Harness native={null}><TodayRoute /></Harness>);
      expect(await screen.findByText('today-list')).toBeTruthy();
    });
  });

  describe('in-app arming', () => {
    it('is read once and expires', () => {
      armCaptureLaunch({ autoStart: true });
      expect(peekCaptureLaunch().autoStart).toBe(true);
      clearCaptureLaunch();
      expect(peekCaptureLaunch().autoStart).toBe(false);

      jest.useFakeTimers();
      armCaptureLaunch({ autoStart: true });
      jest.advanceTimersByTime(ARM_TTL_MS + 1);
      expect(peekCaptureLaunch().autoStart).toBe(false);
      jest.useRealTimers();
    });
  });
});

