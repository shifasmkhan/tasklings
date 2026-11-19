import { Redirect } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isDevSignInEnabled } from '@/api/devSignIn';
import { usePalette } from '@/theme/colors';
import { DevSignInForm } from './DevSignInForm';

/**
 * The standalone dev sign-in screen (opened from Settings when signed out). Without the build flag
 * it renders nothing but a redirect to Today, so a deep link can't reach the form either.
 */
export function DevSignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  if (!isDevSignInEnabled()) return <Redirect href="/" />;
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: p.background }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
    >
      <Text role="heading" style={[styles.title, { color: p.text }]}>
        Developer sign-in
      </Text>
      <DevSignInForm onSignedIn={onSignedIn} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 16 },
  title: { fontSize: 28, fontWeight: '700' },
});
