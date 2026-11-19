import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { createMockApi, MOCK_EMAIL_CODE, type MockApiClient } from '@/api/mock';
import type { ApiClient } from '@/api/types';
import { COPY } from '@/features/onboarding/OnboardingFlow';
import { renderFlow } from '@/features/onboarding/testing';
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { APPLE_ONLY_COPY } from '@/features/settings/logic';
import { DevSignInScreen } from '../DevSignInScreen';
import { DEV_COPY, DEV_SIGNIN_LINK, SEND_COOLDOWN_MS } from '../DevSignInForm';

jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Text: T } = require('react-native');
    return <T>{`redirect:${href}`}</T>;
  },
}));
jest.mock('@react-native-community/datetimepicker', () => ({ __esModule: true, default: () => null }));

const original = process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN;
const press = (label: string) => fireEvent.press(screen.getByLabelText(label));
const type = (label: string, text: string) => fireEvent.changeText(screen.getByLabelText(label), text);

afterEach(() => {
  jest.useRealTimers();
  if (original === undefined) delete process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN;
  else process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = original;
});

async function toSignIn() {
  const h = await renderFlow({ saveTimes: jest.fn().mockResolvedValue(undefined) });
  await press('Get started');
  return h;
}

describe('onboarding sign-in step', () => {
  it('without the flag there is no developer sign-in link and no route to the form', async () => {
    delete process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN;
    await toSignIn();
    expect(screen.getByLabelText('Sign in with Apple')).toBeOnTheScreen();
    expect(screen.queryByLabelText(DEV_SIGNIN_LINK)).not.toBeOnTheScreen();
    expect(screen.queryByLabelText('Send code')).not.toBeOnTheScreen();
  });

  it('with the flag the link sits below the Apple button and opens the email-code form', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    await toSignIn();
    expect(screen.getByLabelText('Sign in with Apple')).toBeOnTheScreen();
    await press(DEV_SIGNIN_LINK);
    expect(screen.getByLabelText('Email')).toBeOnTheScreen();
    expect(screen.getByLabelText('Send code')).toBeOnTheScreen();
    expect(screen.getByLabelText('6-digit code')).toBeOnTheScreen();
    expect(screen.getByLabelText('Sign in')).toBeOnTheScreen();
    await press('Back');
    expect(screen.getByLabelText('Sign in with Apple')).toBeOnTheScreen();
  });

  it('signs in with the mock code and moves on to the times step', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const h = await toSignIn();
    const send = jest.spyOn(h.api, 'requestEmailCode');
    await press(DEV_SIGNIN_LINK);
    await type('Email', 'owner@example.test');
    await type('6-digit code', MOCK_EMAIL_CODE);
    await press('Sign in');
    await screen.findByText(COPY.timesTitle);
    expect(await h.api.signInMethod()).toBe('email');
    expect(send).not.toHaveBeenCalled(); // asking for a code is optional with the mock
  });

  it('Send needs an email, then stays off for 60 seconds', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const h = await toSignIn();
    const send = jest.spyOn(h.api, 'requestEmailCode');
    await press(DEV_SIGNIN_LINK);
    expect(screen.getByLabelText('Send code')).toBeDisabled();
    await type('Email', 'owner@example.test');
    expect(screen.getByLabelText('Send code')).toBeEnabled();

    await press('Send code');
    expect(send).toHaveBeenCalledWith('owner@example.test');
    await screen.findByText(new RegExp(DEV_COPY.sent));
    expect(screen.getByLabelText('Send code')).toBeDisabled();
    expect(screen.getByText(/another code in 60 s/)).toBeOnTheScreen();

    await fireEvent.press(screen.getByLabelText('Send code')); // a press while disabled does nothing
    expect(send).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(screen.getByLabelText('Send code')).toBeDisabled();
    expect(screen.getByText(/another code in 30 s/)).toBeOnTheScreen();

    await act(async () => {
      jest.advanceTimersByTime(SEND_COOLDOWN_MS - 30_000);
    });
    expect(screen.getByLabelText('Send code')).toBeEnabled();
  });

  it('a wrong code says only that it didn’t work, and the person stays on the form', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    await toSignIn();
    await press(DEV_SIGNIN_LINK);
    await type('Email', 'owner@example.test');
    await type('6-digit code', '123456');
    await press('Sign in');
    await screen.findByText(DEV_COPY.verifyFailed);
    expect(screen.getByLabelText('Send code')).toBeOnTheScreen();
  });

  it('the code field takes digits only, at most 6, and Sign in waits for all 6', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    await toSignIn();
    await press(DEV_SIGNIN_LINK);
    await type('Email', 'owner@example.test');
    await type('6-digit code', '12a3-45678');
    expect(screen.getByLabelText('6-digit code').props.value).toBe('123456');
    await type('6-digit code', '123');
    expect(screen.getByLabelText('Sign in')).toBeDisabled();
  });

  it('a failed send says "Couldn’t send a code." for every server-side reason, and starts the cooldown', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const h = await toSignIn();
    await press(DEV_SIGNIN_LINK);
    await type('Email', 'nobody@example.test');
    h.api.failNext('code_request_failed');
    await press('Send code');
    await screen.findByText(DEV_COPY.sendFailed);
    expect(screen.queryByText(/nobody/)).not.toBeOnTheScreen();
    expect(screen.getByLabelText('Send code')).toBeDisabled();
  });

  it('a send that never reached the server says so and may be retried at once', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const h = await toSignIn();
    await press(DEV_SIGNIN_LINK);
    await type('Email', 'owner@example.test');
    h.api.failNext('network_error');
    await press('Send code');
    await screen.findByText(DEV_COPY.network);
    expect(screen.getByLabelText('Send code')).toBeEnabled();
  });
});

describe('standalone dev sign-in screen (opened from Settings)', () => {
  const ui = (api: ApiClient, onSignedIn = jest.fn()) => (
    <ApiProvider client={api}>
      <DevSignInScreen onSignedIn={onSignedIn} />
    </ApiProvider>
  );

  it('without the flag it renders only a redirect to Today, never the form', async () => {
    delete process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN;
    await render(ui(createMockApi({ tasks: [] })));
    expect(screen.getByText('redirect:/')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Email')).not.toBeOnTheScreen();
    expect(screen.queryByLabelText('Send code')).not.toBeOnTheScreen();
  });

  it('with the flag it shows the form and reports a successful sign-in', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const onSignedIn = jest.fn();
    await render(ui(createMockApi({ tasks: [] }), onSignedIn));
    await type('Email', 'owner@example.test');
    await type('6-digit code', MOCK_EMAIL_CODE);
    await press('Sign in');
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });
});

describe('Settings and the email session', () => {
  async function renderSettings(opts: { method: 'apple' | 'email' | null; onOpenDevSignIn?: () => void }) {
    const mock: MockApiClient = createMockApi({ tasks: [] });
    const api: ApiClient = Object.assign(Object.create(mock) as MockApiClient, {
      signInMethod: async () => opts.method,
    });
    const credentialSource = jest.fn(async () => ({ identityToken: 't', rawNonce: 'n', authorizationCode: 'c' as string | null }));
    const shareExport = jest.fn(async () => true);
    await render(
      <ApiProvider client={api}>
        <SettingsScreen
          onAccountDeleted={jest.fn()}
          credentialSource={credentialSource}
          shareExport={shareExport}
          onOpenDevSignIn={opts.onOpenDevSignIn}
        />
      </ApiProvider>,
    );
    await screen.findByLabelText('Export my data');
    return { credentialSource, shareExport, mock };
  }

  it('signed out, with the flag: offers the developer sign-in', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const open = jest.fn();
    await renderSettings({ method: null, onOpenDevSignIn: open });
    await press(DEV_SIGNIN_LINK);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('signed out, without the flag: no link', async () => {
    delete process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN;
    await renderSettings({ method: null, onOpenDevSignIn: jest.fn() });
    expect(screen.queryByLabelText(DEV_SIGNIN_LINK)).not.toBeOnTheScreen();
  });

  it('signed in with Apple: no link, and export and delete stay available', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    await renderSettings({ method: 'apple', onOpenDevSignIn: jest.fn() });
    expect(screen.queryByLabelText(DEV_SIGNIN_LINK)).not.toBeOnTheScreen();
    expect(screen.getByLabelText('Export my data')).toBeEnabled();
  });

  it('email session: says export and delete need Apple, disables both and never starts the Apple flow', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const { credentialSource, shareExport } = await renderSettings({ method: 'email', onOpenDevSignIn: jest.fn() });
    expect(await screen.findByText(APPLE_ONLY_COPY)).toBeOnTheScreen();
    expect(screen.getByLabelText('Export my data')).toBeDisabled();
    expect(screen.getByLabelText('Delete account')).toBeDisabled();
    await fireEvent.press(screen.getByLabelText('Export my data'));
    expect(credentialSource).not.toHaveBeenCalled();
    expect(shareExport).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(DEV_SIGNIN_LINK)).not.toBeOnTheScreen();
  });

  it('a stale screen that still shows the buttons also stops at the Apple-only message', async () => {
    // The method is read again when the action starts, so even before the first read lands the
    // Apple sign-in sheet can't replace an email session.
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const { credentialSource } = await renderSettings({ method: 'email' });
    await fireEvent.press(screen.getByLabelText('Export my data'));
    expect(credentialSource).not.toHaveBeenCalled();
  });
});

// Keep the Text import used by the redirect mock's require in type-checked form.
void Text;
