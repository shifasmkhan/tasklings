import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useApi } from '@/api/ApiProvider';
import { isApiError } from '@/api/errors';
import { ErrorText, PrimaryButton } from '@/features/onboarding/parts';
import { logEvent } from '@/lib/log';
import { MIN_TOUCH, usePalette } from '@/theme/colors';

// Owner-only email and password sign-in (interim proof of concept, TM-10). Reachable only in builds
// made with EXPO_PUBLIC_ENABLE_DEV_SIGNIN=1: every caller checks isDevSignInEnabled() before rendering
// this, and the ApiClient method refuses with `unavailable` without it. Error copy is generic on
// purpose. The address and the password are never logged.

export const DEV_SIGNIN_LINK = 'Developer sign-in';
/** After a failed attempt Sign in stays disabled this long (Supabase also rate-limits sign-ins). */
export const FAILURE_COOLDOWN_MS = 5_000;

export const DEV_COPY = {
  lead: 'Owner-only sign-in for testing.',
  failed: 'Couldn’t sign in',
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
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When Sign in may be used again (ms since epoch); 0 when it already may.
  const [until, setUntil] = useState(0);
  const [, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Re-render once the cooldown is over so the button enables itself.
  useEffect(() => {
    const wait = until - now();
    if (wait <= 0) return;
    const id = setTimeout(() => setTick((t) => t + 1), wait);
    return () => clearTimeout(id);
  }, [until, now]);

  const cooling = until > now();
  const canSignIn = email.trim().length > 2 && email.includes('@') && password.length > 0 && !busy && !cooling;

  const signIn = async () => {
    if (!canSignIn) return;
    setBusy(true);
    setError(null);
    try {
      await api.signInWithPassword(email, password);
      logEvent('devsignin.signed_in', {});
      if (mounted.current) onSignedIn();
    } catch (err) {
      logEvent('devsignin.failed', { code: isApiError(err) ? err.code : 'unknown_error' });
      if (!mounted.current) return;
      setError(DEV_COPY.failed);
      setPassword('');
      setUntil(now() + FAILURE_COOLDOWN_MS);
      setBusy(false);
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
        textContentType="username"
        returnKeyType="next"
        editable={!busy}
        style={input}
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        placeholderTextColor={p.secondaryText}
        accessibilityLabel="Password"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="done"
        onSubmitEditing={() => void signIn()}
        editable={!busy}
        style={input}
      />
      <PrimaryButton label="Sign in" onPress={() => void signIn()} disabled={!canSignIn} />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12 },
  lead: { fontSize: 17, lineHeight: 24 },
  input: { minHeight: MIN_TOUCH, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 17 },
});
