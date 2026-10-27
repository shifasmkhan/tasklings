import { StyleSheet, View } from 'react-native';

import { usePalette } from '@/theme/colors';
import { WAVEFORM_BARS } from './useCaptureSession';

const MIN_H = 6;
const MAX_H = 52;

/** Decorative level meter. VoiceOver gets the timer and transcript instead, so this is hidden. */
export function Waveform({ levels }: { levels: readonly number[] }) {
  const p = usePalette();
  // Newest on the right; bars not yet filled stay at rest.
  const padded = [...new Array<number>(Math.max(0, WAVEFORM_BARS - levels.length)).fill(0), ...levels];
  return (
    <View accessible={false} aria-hidden importantForAccessibility="no-hide-descendants" style={styles.row} testID="waveform">
      {padded.map((level, i) => (
        <View
          key={i}
          style={[
            styles.bar,
            { backgroundColor: p.accent, height: MIN_H + level * (MAX_H - MIN_H), opacity: level === 0 ? 0.35 : 1 },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { height: MAX_H + 4, flexDirection: 'row', alignItems: 'center', gap: 4 },
  bar: { width: 4, borderRadius: 2 },
});
