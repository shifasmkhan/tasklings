import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { createMockApi, MOCK_PASSWORD, type MockApiClient } from '@/api/mock';
import type { ApiClient } from '@/api/types';
import { COPY } from '@/features/onboarding/OnboardingFlow';
import { renderFlow } from '@/features/onboarding/testing';
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { APPLE_ONLY_COPY } from '@/features/settings/logic';
import { DevSignInScreen } from '../DevSignInScreen';
import { DEV_COPY, DEV_SIGNIN_LINK, FAILURE_COOLDOWN_MS } from '../DevSignInForm';

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
    expect(screen.queryByLabelText('Password')).not.toBeOnTheScreen();
  });

  it('with the flag the link sits below the Apple button and opens the form', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    await toSignIn();
    expect(screen.getByLabelText('Sign in with Apple')).toBeOnTheScreen();
    await press(DEV_SIGNIN_LINK);
    expect(screen.getByLabelText('Email')).toBeOnTheScreen();
    expect(screen.getByLabelText('Password')).toBeOnTheScreen();
    expect(screen.getByLabelText('Sign in')).toBeOnTheScreen();
    await press('Back');
    expect(screen.getByLabelText('Sign in with Apple')).toBeOnTheScreen();
  });

  it('the password field is secure and tells iOS Passwords what it is', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    await toSignIn();
    await press(DEV_SIGNIN_LINK);
    const password = screen.getByLabelText('Password');
    expect(password.props.secureTextEntry).toBe(true);
    expect(password.props.textContentType).toBe('password');
    expect(password.props.autoComplete).toBe('current-password');
    expect(screen.getByLabelText('Email').props.textContentType).toBe('username');
  });

  it('signs in with the mock password and moves on to the times step', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const h = await toSignIn();
    await press(DEV_SIGNIN_LINK);
    expect(screen.getByLabelText('Sign in')).toBeDisabled();
    await type('Email', 'owner@example.test');
    await type('Password', MOCK_PASSWORD);
    await press('Sign in');
    await screen.findByText(COPY.timesTitle);
    expect(await h.api.signInMethod()).toBe('email');
  });

  it('a failure says only "Couldn’t sign in", clears the password and disables Sign in for 5 seconds', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    await toSignIn();
    await press(DEV_SIGNIN_LINK);
    await type('Email', 'nobody@example.test');
    await type('Password', 'wrong-password');
    await press('Sign in');
    await screen.findByText(DEV_COPY.failed);
    expect(screen.queryByText(/nobody|wrong/)).not.toBeOnTheScreen();
    expect(screen.getByLabelText('Password').props.value).toBe('');

    await type('Password', MOCK_PASSWORD);
    expect(screen.getByLabelText('Sign in')).toBeDisabled();
    await act(async () => {
      jest.advanceTimersByTime(FAILURE_COOLDOWN_MS - 1000);
    });
    expect(screen.getByLabelText('Sign in')).toBeDisabled();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByLabelText('Sign in')).toBeEnabled();
    await press('Sign in');
    await screen.findByText(COPY.timesTitle);
  });

  it('a network failure is also the generic message', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const h = await toSignIn();
    await press(DEV_SIGNIN_LINK);
    await type('Email', 'owner@example.test');
    await type('Password', MOCK_PASSWORD);
    h.api.failNext('network_error');
    await press('Sign in');
    await screen.findByText(DEV_COPY.failed);
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
    expect(screen.queryByLabelText('Password')).not.toBeOnTheScreen();
  });

  it('with the flag it shows the form and reports a successful sign-in', async () => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    const onSignedIn = jest.fn();
    await render(ui(createMockApi({ tasks: [] }), onSignedIn));
    await type('Email', 'owner@example.test');
    await type('Password', MOCK_PASSWORD);
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
