import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useApi } from '@/api/ApiProvider';
import { isApiError } from '@/api/errors';
import { ErrorText, PrimaryButton } from '@/features/onboarding/parts';
import { logEvent } from '@/lib/log';
import { MIN_TOUCH, usePalette } from '@/theme/colors';

// Owner-only email-code sign-in (interim proof of concept, TM-10). Reachable only in builds made with
// EXPO_PUBLIC_ENABLE_DEV_SIGNIN=1: every caller checks isDevSignInEnabled() before rendering this, and
// the ApiClient methods refuse with `unavailable` without it. Error copy is generic on purpose: it
// never says whether an address exists. The address and the code are never logged.

export const DEV_SIGNIN_LINK = 'Developer sign-in (email code)';
/** Send stays disabled this long after a send (the project also rate-limits codes server-side). */
export const SEND_COOLDOWN_MS = 60_000;

export const DEV_COPY = {
  lead: 'Owner-only sign-in for testing. Enter your email and we’ll send a 6-digit code.',
  sent: 'If that address can sign in, a code is on its way.',
  sendFailed: 'Couldn’t send a code.',
  verifyFailed: 'That code didn’t work.',
  network: 'No connection. Check it and try again.',
} as const;

interface Props {
  onSignedIn: () => void;
  /** Test seam for the clock that drives the cooldown. */
  now?: () => number;
}

export function DevSignInForm({ onSignedIn, now = Date.now }: Props) {
  const p = usePalette();
  const api = useApi();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When Send may be used again (ms since epoch); 0 when it already may.
  const [until, setUntil] = useState(0);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const remainingMs = Math.max(0, until - now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  useEffect(() => {
    if (until <= now()) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      if (until <= now()) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
    // `tick` is only here to re-render; the interval is keyed on the cooldown it counts down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  void tick;

  const emailOk = email.trim().length > 2 && email.includes('@');
  const canSend = emailOk && !sending && !verifying && remainingMs === 0;
  const canVerify = emailOk && /^\d{6}$/.test(code) && !verifying && !sending;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await api.requestEmailCode(email);
      logEvent('devsignin.code_requested', {});
      if (!mounted.current) return;
      setSent(true);
      setUntil(now() + SEND_COOLDOWN_MS);
    } catch (err) {
      const errCode = isApiError(err) ? err.code : 'unknown_error';
      logEvent('devsignin.code_request_failed', { code: errCode });
      if (!mounted.current) return;
      setSent(false);
      if (errCode === 'network_error') {
        // Nothing reached the server, so no cooldown.
        setError(DEV_COPY.network);
      } else {
        setError(DEV_COPY.sendFailed);
        setUntil(now() + SEND_COOLDOWN_MS);
      }
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  const verify = async () => {
    if (!canVerify) return;
    setVerifying(true);
    setError(null);
    try {
      await api.verifyEmailCode(email, code);
      logEvent('devsignin.signed_in', {});
      if (mounted.current) onSignedIn();
    } catch (err) {
      const errCode = isApiError(err) ? err.code : 'unknown_error';
      logEvent('devsignin.verify_failed', { code: errCode });
      if (!mounted.current) return;
      setError(errCode === 'network_error' ? DEV_COPY.network : DEV_COPY.verifyFailed);
      setVerifying(false);
    }
  };

  const input = [styles.input, { color: p.text, backgroundColor: p.card, borderColor: p.separator }];
  return (
    <View style={styles.form}>
      <Text style={[styles.lead, { color: p.secondaryText }]}>{DEV_COPY.lead}</Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor={p.secondaryText}
        accessibilityLabel="Email"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        returnKeyType="send"
        editable={!verifying}
        style={input}
      />
      <PrimaryButton label="Send code" onPress={() => void send()} disabled={!canSend} />
      {remainingMs > 0 ? (
        <Text aria-live="polite" style={[styles.note, { color: p.secondaryText }]}>
          {sent ? `${DEV_COPY.sent} ` : ''}You can ask for another code in {remainingSeconds} s.
        </Text>
      ) : sent ? (
        <Text aria-live="polite" style={[styles.note, { color: p.secondaryText }]}>
          {DEV_COPY.sent}
        </Text>
      ) : null}
      <TextInput
        value={code}
        onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
        placeholder="6-digit code"
        placeholderTextColor={p.secondaryText}
        accessibilityLabel="6-digit code"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="one-time-code"
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        maxLength={6}
        returnKeyType="done"
        editable={!verifying}
        style={input}
      />
      <PrimaryButton label="Sign in" onPress={() => void verify()} disabled={!canVerify} />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12 },
  lead: { fontSize: 17, lineHeight: 24 },
  note: { fontSize: 15, lineHeight: 20 },
  input: { minHeight: MIN_TOUCH, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 17 },
});
