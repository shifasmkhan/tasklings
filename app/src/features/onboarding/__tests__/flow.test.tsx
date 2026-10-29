import { act, fireEvent, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/errors';
import { createMockApi } from '@/api/mock';
import { createMockNotificationPermission } from '../notifications';
import { COPY } from '../OnboardingFlow';
import { renderFlow } from '../testing';

const press = (label: string) => fireEvent.press(screen.getByLabelText(label));

async function toTimes(opts: Parameters<typeof renderFlow>[0] = {}) {
  const h = await renderFlow(opts);
  await press('Get started');
  await press('Sign in with Apple');
  await screen.findByText(COPY.timesTitle);
  return h;
}

describe('Onboarding flow (US-19)', () => {
  it('walks welcome, sign in, times, notifications, first note without setting the flag early', async () => {
    const saveTimes = jest.fn().mockResolvedValue(undefined);
    const notifications = createMockNotificationPermission();
    const request = jest.spyOn(notifications, 'request');
    const h = await renderFlow({ saveTimes, notifications });

    expect(screen.getByText('Welcome to Tasklings')).toBeTruthy();
    await press('Get started');
    expect(screen.getByText(COPY.signInTitle)).toBeTruthy();
    await press('Sign in with Apple');
    await screen.findByText(COPY.timesTitle);

    // Defaults are pre-filled, so Continue is one tap.
    expect(screen.getByText('8:00 AM')).toBeTruthy();
    expect(screen.getByText('8:30 PM')).toBeTruthy();
    await press('Continue');
    await screen.findByText(COPY.notificationsTitle);
    expect(saveTimes).toHaveBeenCalledWith({ briefTime: '08:00', checkinTime: '20:30' });

    await press('Allow');
    await screen.findByText(COPY.noteTitle);
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByText(COPY.noteHint)).toBeTruthy();
    expect(h.store.setComplete).not.toHaveBeenCalled();
    expect(h.nav.goToday).not.toHaveBeenCalled();
  });

  it('sends the chosen times', async () => {
    const saveTimes = jest.fn().mockResolvedValue(undefined);
    await toTimes({ saveTimes });
    await press('Morning brief, 15 minutes later');
    await press('Morning brief, 15 minutes later');
    await press('Evening check-in, 15 minutes earlier');
    expect(screen.getByText('8:30 AM')).toBeTruthy();
    expect(screen.getByText('8:15 PM')).toBeTruthy();
    await press('Continue');
    await screen.findByText(COPY.notificationsTitle);
    expect(saveTimes).toHaveBeenCalledWith({ briefTime: '08:30', checkinTime: '20:15' });
  });

  it('has no Skip on the sign-in step', async () => {
    await renderFlow();
    await press('Get started');
    expect(screen.queryByLabelText('Skip')).toBeNull();
    expect(screen.queryByLabelText('Not now')).toBeNull();
  });

  it('says Sign in with Apple is not set up when the backend answers unauthenticated', async () => {
    const api = createMockApi({ tasks: [] });
    jest.spyOn(api, 'signInWithApple').mockRejectedValue(new ApiError('unauthenticated', 'x', 401));
    await renderFlow({ api });
    await press('Get started');
    await press('Sign in with Apple');
    expect(await screen.findByText(COPY.signInUnauthenticated)).toBeTruthy();
    expect(screen.queryByText(COPY.timesTitle)).toBeNull();
  });

  it('shows a network message and allows another try', async () => {
    const api = createMockApi({ tasks: [] });
    const spy = jest.spyOn(api, 'signInWithApple').mockRejectedValueOnce(new ApiError('network_error', 'x'));
    await renderFlow({ api });
    await press('Get started');
    await press('Sign in with Apple');
    expect(await screen.findByText(COPY.signInNetwork)).toBeTruthy();
    spy.mockRestore();
    await press('Sign in with Apple');
    await screen.findByText(COPY.timesTitle);
  });

  it('shows an inline error when saving times fails, and retry works', async () => {
    const saveTimes = jest.fn().mockRejectedValueOnce(new ApiError('network_error', 'x')).mockResolvedValue(undefined);
    await toTimes({ saveTimes });
    await press('Continue');
    expect(await screen.findByText(COPY.timesSaveFailed)).toBeTruthy();
    expect(screen.getByText(COPY.timesTitle)).toBeTruthy();
    await press('Continue');
    await screen.findByText(COPY.notificationsTitle);
    expect(saveTimes).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(COPY.timesSaveFailed)).toBeNull();
  });

  it('lets the user skip the times step', async () => {
    const saveTimes = jest.fn();
    await toTimes({ saveTimes });
    await press('Skip');
    await screen.findByText(COPY.notificationsTitle);
    expect(saveTimes).not.toHaveBeenCalled();
  });

  it('continues when notifications are denied', async () => {
    const notifications = createMockNotificationPermission({ answer: 'denied' });
    await renderFlow({ notifications, saveTimes: jest.fn().mockResolvedValue(undefined) });
    await press('Get started');
    await press('Sign in with Apple');
    await screen.findByText(COPY.timesTitle);
    await press('Continue');
    await press('Allow');
    expect(await screen.findByText(COPY.noteTitle)).toBeTruthy();
  });

  it('continues when the notification request throws', async () => {
    const notifications = createMockNotificationPermission();
    jest.spyOn(notifications, 'request').mockRejectedValue(new Error('boom'));
    const h = await renderFlow({ notifications, saveTimes: jest.fn().mockResolvedValue(undefined) });
    await press('Get started');
    await press('Sign in with Apple');
    await screen.findByText(COPY.timesTitle);
    await press('Continue');
    await press('Allow');
    await screen.findByText(COPY.noteTitle);
    expect(h.store.setComplete).not.toHaveBeenCalled();

  });

  it('Not now skips the permission prompt', async () => {
    const notifications = createMockNotificationPermission();
    const request = jest.spyOn(notifications, 'request');
    await renderFlow({ notifications });
    await press('Get started');
    await press('Sign in with Apple');
    await screen.findByText(COPY.timesTitle);
    await press('Skip');
    await press('Not now');
    await screen.findByText(COPY.noteTitle);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('First note (US-19)', () => {
  async function toNote() {
    const h = await renderFlow({ saveTimes: jest.fn().mockResolvedValue(undefined) });
    await press('Get started');
    await press('Sign in with Apple');
    await screen.findByText(COPY.timesTitle);
    await press('Skip');
    await press('Not now');
    await screen.findByText(COPY.noteTitle);
    return h;
  }

  it('opens the Capture sheet from the button', async () => {
    const h = await toNote();
    await press('Record my first note');
    expect(h.nav.openCapture).toHaveBeenCalledTimes(1);
  });

  it('sets the flag and goes to Today once a note was saved and the sheet closed', async () => {
    const h = await toNote();
    await press('Record my first note');
    await act(async () => {
      h.captures.submit({ source: 'voice', transcript: 'Call the dentist and buy milk' });
    });
    expect(h.store.setComplete).not.toHaveBeenCalled();
    await act(async () => h.rerender(1));
    expect(h.store.setComplete).toHaveBeenCalledTimes(1);
    expect(h.nav.goToday).toHaveBeenCalledTimes(1);
  });

  it('stays on the step when the sheet closes without a note', async () => {
    const h = await toNote();
    await press('Record my first note');
    await act(async () => h.rerender(1));
    expect(h.store.setComplete).not.toHaveBeenCalled();
    expect(h.nav.goToday).not.toHaveBeenCalled();
    expect(screen.getByText(COPY.noteTitle)).toBeTruthy();
  });

  it('Skip for now still finishes onboarding', async () => {
    const h = await toNote();
    await press('Skip for now');
    expect(h.store.setComplete).toHaveBeenCalledTimes(1);
    expect(h.nav.goToday).toHaveBeenCalledTimes(1);
  });

  it('finishes when the note yields 0 tasks', async () => {
    const h = await toNote();
    const results: number[] = [];
    h.captures.onResult((r) => results.push(r.tasks.length));
    await press('Record my first note');
    jest.useFakeTimers();
    await act(async () => {
      h.captures.submit({ source: 'text', transcript: 'never mind, thinking out loud' });
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });
    jest.useRealTimers();
    expect(results).toEqual([0]);
    await act(async () => h.rerender(1));
    expect(h.store.setComplete).toHaveBeenCalledTimes(1);
    expect(h.nav.goToday).toHaveBeenCalledTimes(1);
  });

  it('still goes to Today if the flag cannot be written', async () => {
    const h = await toNote();
    h.store.setComplete.mockRejectedValueOnce(new Error('keychain'));
    await press('Skip for now');
    expect(h.nav.goToday).toHaveBeenCalledTimes(1);
  });
});
