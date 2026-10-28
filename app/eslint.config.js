// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['node_modules/*', '.expo/*', 'dist/*', 'targets/*', 'expo-env.d.ts'],
  },
  {
    rules: {
      // Logs must never carry task titles, notes or transcripts (security rule).
      // Use src/lib/log.ts, which only accepts IDs and codes.
      'no-console': 'error',
    },
  },
  {
    rules: {
      // The Supabase session lives in the Keychain (expo-secure-store, security review S-12),
      // never in AsyncStorage, which is plain files.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@react-native-async-storage/async-storage',
              message: 'Sessions and tokens go in expo-secure-store (Keychain), never AsyncStorage.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/lib/log.ts', 'jest.setup.js'],
    rules: { 'no-console': 'off' },
  },
]);
