import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApi } from '@/api/ApiProvider';
import { isApiError } from '@/api/errors';
import { useOptionalCaptureStore } from '@/features/capture/CaptureProvider';
import { logEvent } from '@/lib/log';
import { usePalette } from '@/theme/colors';
import { defaultAppleCredentialSource, type AppleCredentialSource } from '@/features/auth/appleCredential';
import { createNotificationPermission, type NotificationPermission } from './notifications';
import { useOnboardingGate } from './OnboardingProvider';
import { AppleSignInButton, ErrorText, PrimaryButton, StepFrame, TextButton, TimeStepper } from './parts';
import { DEFAULT_BRIEF_TIME, DEFAULT_CHECKIN_TIME, formatTime, shiftTime } from './times';
import { useSaveTimes, type SaveTimes } from './useSaveTimes';

export const COPY = {
  welcome: 'Say what’s on your mind. Tasklings turns it into a short list.',
  signInTitle: 'Sign in to keep your tasks safe',
  signInUnauthenticated: 'Sign in with Apple isn’t set up yet.',
  signInNetwork: 'No connection. Check it and try again.',
  signInFailed: 'Couldn’t sign in. Try again.',
  timesTitle: 'When should we check in?',
  timesSaveFailed: 'Couldn’t save your times. Try again, or skip for now.',
  notificationsTitle: 'Get a morning brief and an evening check-in',
  notificationsNote: 'A short heads-up with counts only. You can change this in Settings.',
  noteTitle: 'Say your first note',
  noteHint: 'Try: “Call the dentist and buy milk on the way home”',
  noteMic: 'Your voice is turned into text on this phone. iOS will ask for microphone and speech access.',
} as const;

export const STEPS = ['welcome', 'signin', 'times', 'notifications', 'note'] as const;
export type Step = (typeof STEPS)[number];
/** Welcome, Sign in, Times, Notifications, First note: five screens, then Today. */
const TOTAL = STEPS.length;

export interface OnboardingNav {
  /** Opens the Capture sheet with the onboarding hint, listening at once. */
  openCapture: () => void;
  /** Leaves onboarding for Today. */
  goToday: () => void;
}

interface Props {
  nav: OnboardingNav;
  /** Bumped by the route each time it regains focus after the Capture sheet closed. */
  returnKey?: number;
  credentials?: AppleCredentialSource;
  notifications?: NotificationPermission;
  /** Test seam; default saves through the profile API. */
  saveTimes?: SaveTimes;
}

const defaultNotifications = createNotificationPermission();

export function OnboardingFlow({
  nav,
  returnKey = 0,
  credentials = defaultAppleCredentialSource,
  notifications = defaultNotifications,
  saveTimes,
}: Props) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const api = useApi();
  const gate = useOnboardingGate();
  const captures = useOptionalCaptureStore();
  const defaultSave = useSaveTimes();
  const save = saveTimes ?? defaultSave;

  const [step, setStep] = useState<Step>('welcome');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState(DEFAULT_BRIEF_TIME);
  const [checkin, setCheckin] = useState(DEFAULT_CHECKIN_TIME);

  const go = (next: Step) => {
    logEvent('onboarding.step', { action: next });
    setError(null);
    setBusy(false);
    setStep(next);
  };

  const finish = async () => {
    // The flag is set only here, when the flow ends (first note saved or skipped).
    await gate.complete();
    nav.goToday();
  };

  // Did a note get saved while the Capture sheet was open?
  const submitted = useRef(false);
  useEffect(() => {
    if (!captures) return;
    const check = () => {
      if (captures.getPending().length > 0) submitted.current = true;
    };
    check();
    return captures.subscribe(check);
  }, [captures]);

  const finishedRef = useRef(false);
  useEffect(() => {
    if (returnKey === 0 || step !== 'note' || !submitted.current || finishedRef.current) return;
    finishedRef.current = true;
    void finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnKey]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      // The same credential seam Settings uses; US-10 replaces it in one place.
      const credential = await credentials();
      await api.signInWithApple(credential.identityToken, credential.rawNonce);
      go('times');
    } catch (err) {
      const code = isApiError(err) ? err.code : 'unknown_error';
      logEvent('onboarding.signin_failed', { code });
      setBusy(false);
      setError(
        code === 'unauthenticated'
          ? COPY.signInUnauthenticated
          : code === 'network_error'
            ? COPY.signInNetwork
            : COPY.signInFailed,
      );
    }
  };

  const saveAndContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      await save({ briefTime: brief, checkinTime: checkin });
      go('notifications');
    } catch (err) {
      logEvent('onboarding.times_failed', { code: isApiError(err) ? err.code : 'unknown_error' });
      setBusy(false);
      setError(COPY.timesSaveFailed);
    }
  };

  const askNotifications = async () => {
    setBusy(true);
    try {
      const result = await notifications.request();
      logEvent('onboarding.notifications', { status: result });
    } catch {
      logEvent('onboarding.notifications', { code: 'request_failed' });
    }
    // Allowed, denied or failed: onboarding goes on either way.
    go('note');
  };

  const content = (() => {
    switch (step) {
      case 'welcome':
        return (
          <StepFrame
            step={1}
            total={TOTAL}
            title="Welcome to Tasklings"
            footer={<PrimaryButton label="Get started" onPress={() => go('signin')} />}
          >
            <Text style={[styles.lead, { color: p.secondaryText }]}>{COPY.welcome}</Text>
          </StepFrame>
        );
      case 'signin':
        return (
          <StepFrame
            step={2}
            total={TOTAL}
            title={COPY.signInTitle}
            footer={
              <>
                {error ? <ErrorText>{error}</ErrorText> : null}
                <AppleSignInButton onPress={() => void signIn()} disabled={busy} />
              </>
            }
          />
        );
      case 'times':
        return (
          <StepFrame
            step={3}
            total={TOTAL}
            title={COPY.timesTitle}
            footer={
              <>
                {error ? <ErrorText>{error}</ErrorText> : null}
                <PrimaryButton label="Continue" onPress={() => void saveAndContinue()} disabled={busy} />
                <TextButton label="Skip" onPress={() => go('notifications')} />
              </>
            }
          >
            <TimeStepper
              label="Morning brief"
              value={brief}
              display={formatTime(brief)}
              onEarlier={() => setBrief(shiftTime(brief, -1))}
              onLater={() => setBrief(shiftTime(brief, 1))}
            />
            <TimeStepper
              label="Evening check-in"
              value={checkin}
              display={formatTime(checkin)}
              onEarlier={() => setCheckin(shiftTime(checkin, -1))}
              onLater={() => setCheckin(shiftTime(checkin, 1))}
            />
          </StepFrame>
        );
      case 'notifications':
        return (
          <StepFrame
            step={4}
            total={TOTAL}
            title={COPY.notificationsTitle}
            footer={
              <>
                <PrimaryButton label="Allow" onPress={() => void askNotifications()} disabled={busy} />
                <TextButton label="Not now" onPress={() => go('note')} />
              </>
            }
          >
            <Text style={[styles.lead, { color: p.secondaryText }]}>{COPY.notificationsNote}</Text>
          </StepFrame>
        );
      case 'note':
        return (
          <StepFrame
            step={5}
            total={TOTAL}
            title={COPY.noteTitle}
            footer={
              <>
                <PrimaryButton label="Record my first note" onPress={nav.openCapture} />
                <TextButton label="Skip for now" onPress={() => void finish()} />
              </>
            }
          >
            <Text style={[styles.hint, { color: p.text, backgroundColor: p.card }]}>{COPY.noteHint}</Text>
            <Text style={[styles.lead, { color: p.secondaryText }]}>{COPY.noteMic}</Text>
          </StepFrame>
        );
    }
  })();

  return (
    <View style={[styles.screen, { backgroundColor: p.background, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 12) }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" bounces={false}>
        {content}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1 },
  lead: { fontSize: 17, lineHeight: 24 },
  hint: { fontSize: 19, fontWeight: '600', lineHeight: 26, padding: 16, borderRadius: 14, overflow: 'hidden' },
});
