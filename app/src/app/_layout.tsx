import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '@/api/ApiProvider';
import { isDevSignInEnabled } from '@/api/devSignIn';
import { IntentLaunchHandler } from '@/features/capture/IntentLaunchHandler';
import { CaptureProvider } from '@/features/capture/CaptureProvider';
import { OnboardingProvider } from '@/features/onboarding/OnboardingProvider';
import { dark, light } from '@/theme/colors';

export default function RootLayout() {
  const scheme = useColorScheme();
  const p = scheme === 'dark' ? dark : light;
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, primary: p.accent, background: p.background, card: p.card, text: p.text, border: p.separator },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: p.background }}>
      <SafeAreaProvider>
        <ApiProvider>
          <OnboardingProvider>
          <CaptureProvider>
            <ThemeProvider value={theme}>
              <IntentLaunchHandler />
              <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
              <Stack screenOptions={{ contentStyle: { backgroundColor: p.background } }}>
                <Stack.Screen name="index" options={{ headerShown: false, title: 'Today' }} />
                <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false, title: 'Welcome' }} />
                <Stack.Screen name="capture" options={{ presentation: 'formSheet', title: 'Capture', headerShown: false }} />
                <Stack.Screen name="task/[id]" options={{ title: 'Task' }} />
                <Stack.Screen name="settings" options={{ title: 'Settings' }} />
                {/* Owner-only dev sign-in (TM-10): registered only in builds made with the flag. */}
                {isDevSignInEnabled() ? <Stack.Screen name="dev-signin" options={{ title: 'Developer sign-in' }} /> : null}
                <Stack.Screen name="check-in" options={{ presentation: 'modal', title: 'Evening check-in' }} />
              </Stack>
            </ThemeProvider>
          </CaptureProvider>
          </OnboardingProvider>
        </ApiProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
