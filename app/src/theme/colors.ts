import { useColorScheme } from 'react-native';

export interface Palette {
  accent: string;
  onAccent: string;
  background: string;
  card: string;
  fill: string;
  text: string;
  secondaryText: string;
  separator: string;
  circle: string;
  track: string;
  deferAction: string;
  dropAction: string;
  toastBackground: string;
  toastText: string;
  toastAction: string;
  barBackground: string;
}

// Light values come from the signed-off prototype. Every text pair is checked for
// at least 4.5:1 contrast (see src/theme/__tests__/contrast.test.ts).
export const light: Palette = {
  accent: '#4458D6',
  onAccent: '#FFFFFF',
  background: '#F2F2F7',
  card: '#FFFFFF',
  fill: '#F2F2F7',
  text: '#1C1C1E',
  secondaryText: '#6E6E73',
  separator: '#E5E5EA',
  circle: '#8E8E93',
  track: '#E5E5EA',
  deferAction: '#5C5C61',
  dropAction: '#C4001A',
  toastBackground: '#1C1C1E',
  toastText: '#FFFFFF',
  toastAction: '#B9C4FF',
  barBackground: 'rgba(242, 242, 247, 0.94)',
};

// Dark follows iOS system dark colors; the accent is lifted so it passes on dark cards.
export const dark: Palette = {
  accent: '#8C9AF5',
  onAccent: '#0B0F2E',
  background: '#000000',
  card: '#1C1C1E',
  fill: '#2C2C2E',
  text: '#FFFFFF',
  secondaryText: '#AEAEB2',
  separator: '#38383A',
  circle: '#8E8E93',
  track: '#38383A',
  deferAction: '#636366',
  dropAction: '#C4001A',
  toastBackground: '#3A3A3C',
  toastText: '#FFFFFF',
  toastAction: '#C7CEFF',
  barBackground: 'rgba(0, 0, 0, 0.92)',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Minimum touch target in points (Apple HIG). */
export const MIN_TOUCH = 44;
