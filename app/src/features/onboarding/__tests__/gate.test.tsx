import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { createMockApi } from '@/api/mock';
import { createSecureOnboardingStore, ONBOARDING_FLAG_KEY } from '../onboardingStore';
import { OnboardingProvider, useOnboardingGate } from '../OnboardingProvider';
import { memoryStore, type MemoryStore } from '../testing';

const mockRouter: { dismissAll?: () => void } = {};
const mockSettingsProps: { onDeleted?: (fn: () => void) => void } = {};
const mockTodayProps: { onTitleLongPress?: () => void }[] = [];
jest.mock('expo-router', () => {
  const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Redirect: ({ href }: { href: string }) => <T>{`redirect:${href}`}</T>,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), dismissAll: () => mockRouter.dismissAll?.() }),
    useFocusEffect: () => undefined,
  };
});
jest.mock('@/features/settings/SettingsScreen', () => ({
  SettingsScreen: ({ onAccountDeleted }: { onAccountDeleted: () => void }) => {
    mockSettingsProps.onDeleted?.(onAccountDeleted);
    return null;
  },
}));
jest.mock('@/features/today/TodayScreen', () => {
  const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    TodayScreen: ({ nav }: { nav: { onTitleLongPress?: () => void } }) => {
      mockTodayProps.push(nav);
      return <T>today-screen</T>;
    },
  };
});

// eslint-disable-next-line import/first
import TodayRoute from '@/app/index';

async function renderRoute(store: MemoryStore) {
  await render(
    <ApiProvider client={createMockApi({ tasks: [] })}>
      <OnboardingProvider store={store}>
        <TodayRoute />
      </OnboardingProvider>
    </ApiProvider>,
  );
}

describe('First-run gate (US-19)', () => {
  beforeEach(() => {
    mockTodayProps.length = 0;
  });

  it('routes to onboarding when the flag is absent', async () => {
    await renderRoute(memoryStore(false));
    expect(await screen.findByText('redirect:/onboarding')).toBeTruthy();
    expect(screen.queryByText('today-screen')).toBeNull();
  });

  it('shows Today when the flag is present', async () => {
    await renderRoute(memoryStore(true));
    expect(await screen.findByText('today-screen')).toBeTruthy();
    expect(screen.queryByText(/redirect:/)).toBeNull();
  });

  it('shows neither while the flag is being read', async () => {
    const store = memoryStore(true);
    let release: (v: boolean) => void = () => undefined;
    store.isComplete.mockReturnValue(new Promise<boolean>((r) => (release = r)));
    await renderRoute(store);
    expect(screen.queryByText('today-screen')).toBeNull();
    expect(screen.queryByText(/redirect:/)).toBeNull();
    await act(async () => release(true));
    expect(await screen.findByText('today-screen')).toBeTruthy();
  });

  it('treats an unreadable flag as absent', async () => {
    const store = memoryStore(true);
    store.isComplete.mockRejectedValue(new Error('keychain'));
    await renderRoute(store);
    expect(await screen.findByText('redirect:/onboarding')).toBeTruthy();
  });

  it('dev reset (long press on the title) clears the flag and routes back to onboarding', async () => {
    const store = memoryStore(true);
    await renderRoute(store);
    await screen.findByText('today-screen');
    await act(async () => mockTodayProps[mockTodayProps.length - 1]?.onTitleLongPress?.());
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('redirect:/onboarding')).toBeTruthy();
  });

  it('complete() sets the flag and switches to Today', async () => {
    const store = memoryStore(false);
    function Probe() {
      const g = useOnboardingGate();
      return <Text onPress={() => void g.complete()}>{`status:${g.status}`}</Text>;
    }
    await render(
      <OnboardingProvider store={store}>
        <Probe />
      </OnboardingProvider>,
    );
    await screen.findByText('status:needed');
    expect(store.setComplete).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('status:needed'));
    expect(await screen.findByText('status:complete')).toBeTruthy();
    expect(store.value).toBe(true);
  });
});

describe('Secure onboarding store', () => {
  it('stores the flag under onboarding_complete in SecureStore', async () => {
    const data = new Map<string, string>();
    const secure = {
      getItemAsync: jest.fn(async (k: string) => data.get(k) ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => void data.set(k, v)),
      deleteItemAsync: jest.fn(async (k: string) => void data.delete(k)),
    };
    const store = createSecureOnboardingStore(secure);
    expect(await store.isComplete()).toBe(false);
    await store.setComplete();
    expect(data.get(ONBOARDING_FLAG_KEY)).toBe('1');
    expect(await store.isComplete()).toBe(true);
    await store.clear();
    expect(await store.isComplete()).toBe(false);
  });
});

describe('After Delete account (US-11, US-19)', () => {
  it('clears the flag and sends the person to onboarding', async () => {
    const store = memoryStore(true);
    const dismissAll = jest.fn();
    mockRouter.dismissAll = dismissAll;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SettingsRoute = require('@/app/settings').default;
    let captured: (() => void) | undefined;
    mockSettingsProps.onDeleted = (fn) => (captured = fn);
    await render(
      <ApiProvider client={createMockApi({ tasks: [] })}>
        <OnboardingProvider store={store}>
          <SettingsRoute />
          <TodayRoute />
        </OnboardingProvider>
      </ApiProvider>,
    );
    await screen.findByText('today-screen');
    await act(async () => captured?.());
    expect(dismissAll).toHaveBeenCalledTimes(1);
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store.value).toBe(false);
    expect(await screen.findByText('redirect:/onboarding')).toBeTruthy();
  });
});
