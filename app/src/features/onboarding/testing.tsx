import { render } from '@testing-library/react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { createMockApi, type MockApiClient } from '@/api/mock';
import type { ApiClient } from '@/api/types';
import { CaptureProvider } from '@/features/capture/CaptureProvider';
import { CaptureStore } from '@/features/capture/captureStore';
import { OnboardingFlow, type OnboardingNav } from './OnboardingFlow';
import { OnboardingProvider } from './OnboardingProvider';
import type { OnboardingStore } from './onboardingStore';

export interface MemoryStore extends OnboardingStore {
  value: boolean;
  isComplete: jest.Mock<Promise<boolean>, []>;
  setComplete: jest.Mock<Promise<void>, []>;
  clear: jest.Mock<Promise<void>, []>;
}

export function memoryStore(initial = false): MemoryStore {
  const s: MemoryStore = {
    value: initial,
    isComplete: jest.fn(async () => s.value),
    setComplete: jest.fn(async () => {
      s.value = true;
    }),
    clear: jest.fn(async () => {
      s.value = false;
    }),
  };
  return s;
}

export type FlowProps = Partial<React.ComponentProps<typeof OnboardingFlow>>;

export async function renderFlow(opts: { api?: ApiClient; store?: MemoryStore } & FlowProps = {}) {
  const api: ApiClient = opts.api ?? createMockApi({ tasks: [], captureResultDelayMs: 100 });
  const store = opts.store ?? memoryStore();
  const captures = new CaptureStore({ api, arrivals: null, newId: () => 'capture-1' });
  const nav: OnboardingNav = { openCapture: jest.fn(), goToday: jest.fn() };
  const { api: _a, store: _s, ...flowProps } = opts;
  const ui = (key: number) => (
    <ApiProvider client={api}>
      <OnboardingProvider store={store}>
        <CaptureProvider store={captures}>
          <OnboardingFlow nav={nav} returnKey={key} {...flowProps} />
        </CaptureProvider>
      </OnboardingProvider>
    </ApiProvider>
  );
  const view = await render(ui(0));
  return { api: api as MockApiClient, store, captures, nav, rerender: (key: number) => view.rerender(ui(key)) };
}
