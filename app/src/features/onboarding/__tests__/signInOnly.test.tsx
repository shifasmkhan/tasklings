import { fireEvent, screen } from '@testing-library/react-native';

import { armSignInLaunch, consumeSignInLaunch } from '../signInLaunch';
import { COPY } from '../OnboardingFlow';
import { renderFlow } from '../testing';

describe('Re-sign-in from Today (US-19 interim)', () => {
  it('signInOnly opens on the Sign in step and, once signed in, goes straight to Today without touching the flag', async () => {
    const h = await renderFlow({ signInOnly: true });
    expect(screen.getByText(COPY.signInTitle)).toBeTruthy();
    expect(screen.queryByText('Welcome to Tasklings')).toBeNull();
    fireEvent.press(screen.getByLabelText('Sign in with Apple'));
    await screen.findByLabelText('Sign in with Apple');
    expect(h.nav.goToday).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(COPY.timesTitle)).toBeNull();
    expect(h.store.setComplete).not.toHaveBeenCalled();
  });

  it('the launch flag is one-shot and expires', () => {
    expect(consumeSignInLaunch()).toBe(false);
    armSignInLaunch();
    expect(consumeSignInLaunch()).toBe(true);
    expect(consumeSignInLaunch()).toBe(false);
    jest.useFakeTimers();
    armSignInLaunch();
    jest.advanceTimersByTime(6000);
    expect(consumeSignInLaunch()).toBe(false);
    jest.useRealTimers();
  });
});
