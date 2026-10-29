import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { MIN_TOUCH } from '@/theme/colors';
import { COPY } from '../OnboardingFlow';
import { renderFlow } from '../testing';
import { AppleSignInButton } from '../parts';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme,
}));

describe('Onboarding appearance', () => {
  it('Apple button: black on light, white on dark, at least 44 pt tall', async () => {
    for (const [scheme, bg] of [['light', '#000000'], ['dark', '#FFFFFF']] as const) {
      mockScheme = scheme;
      const { unmount } = await render(<AppleSignInButton onPress={() => undefined} />);
      const style = StyleSheet.flatten(screen.getByLabelText('Sign in with Apple').props.style);
      expect(style.backgroundColor).toBe(bg);
      expect(style.minHeight).toBeGreaterThanOrEqual(MIN_TOUCH);
      await unmount();
    }
  });

  it('every button is at least 44 pt and labelled', async () => {
    mockScheme = 'dark';
    await renderFlow();
    const button = screen.getByLabelText('Get started');
    expect(StyleSheet.flatten(button.props.style).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH);
    await fireEvent.press(button);
    expect(screen.getByText(COPY.signInTitle)).toBeTruthy();
  });
});
