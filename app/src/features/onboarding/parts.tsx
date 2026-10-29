import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { MIN_TOUCH, usePalette } from '@/theme/colors';

export function StepFrame({
  step,
  total,
  title,
  children,
  footer,
}: {
  step: number;
  total: number;
  title: string;
  children?: ReactNode;
  footer: ReactNode;
}) {
  const p = usePalette();
  return (
    <View style={styles.frame}>
      <Text
        accessibilityLabel={`Step ${step} of ${total}`}
        style={[styles.progress, { color: p.secondaryText }]}
      >
        {step} of {total}
      </Text>
      <View style={styles.body}>
        <Text role="heading" style={[styles.title, { color: p.text }]}>
          {title}
        </Text>
        {children}
      </View>
      <View style={styles.footer}>{footer}</View>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const p = usePalette();
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[styles.primary, { backgroundColor: p.accent, opacity: disabled ? 0.6 : 1 }]}
    >
      <Text style={[styles.primaryText, { color: p.onAccent }]}>{label}</Text>
    </Pressable>
  );
}

export function TextButton({ label, onPress }: { label: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable role="button" aria-label={label} onPress={onPress} style={styles.textButton}>
      <Text style={[styles.textButtonText, { color: p.accent }]}>{label}</Text>
    </Pressable>
  );
}

/** Apple's Sign in with Apple button styling (black on light, white on dark; Apple logo glyph; 44 pt minimum). */
export function AppleSignInButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  const dark = useColorScheme() === 'dark';
  const bg = dark ? '#FFFFFF' : '#000000';
  const fg = dark ? '#000000' : '#FFFFFF';
  return (
    <Pressable
      role="button"
      aria-label="Sign in with Apple"
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[styles.apple, { backgroundColor: bg, opacity: disabled ? 0.6 : 1 }]}
    >
      <Text accessible={false} aria-hidden style={[styles.appleLogo, { color: fg }]}>
        {''}
      </Text>
      <Text style={[styles.appleText, { color: fg }]}>Sign in with Apple</Text>
    </Pressable>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  const p = usePalette();
  return (
    <Text role="alert" style={[styles.error, { color: p.dropAction }]}>
      {children}
    </Text>
  );
}

/** A time with Earlier / Later buttons: no typing, one tap per 15 minutes. */
export function TimeStepper({
  label,
  value,
  display,
  onEarlier,
  onLater,
}: {
  label: string;
  value: string;
  display: string;
  onEarlier: () => void;
  onLater: () => void;
}) {
  const p = usePalette();
  return (
    <View style={[styles.stepper, { backgroundColor: p.card }]}>
      <Text style={[styles.stepperLabel, { color: p.secondaryText }]}>{label}</Text>
      <View style={styles.stepperRow}>
        <Pressable
          role="button"
          aria-label={`${label}, 15 minutes earlier`}
          onPress={onEarlier}
          style={[styles.stepperButton, { backgroundColor: p.fill }]}
        >
          <Text style={[styles.stepperGlyph, { color: p.accent }]}>−</Text>
        </Pressable>
        <Text
          testID={`time-${value}`}
          aria-label={`${label} time`}
          aria-live="polite"
          style={[styles.stepperValue, { color: p.text }]}
        >
          {display}
        </Text>
        <Pressable
          role="button"
          aria-label={`${label}, 15 minutes later`}
          onPress={onLater}
          style={[styles.stepperButton, { backgroundColor: p.fill }]}
        >
          <Text style={[styles.stepperGlyph, { color: p.accent }]}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, paddingHorizontal: 24, paddingVertical: 16, gap: 24 },
  progress: { fontSize: 13, fontWeight: '600' },
  body: { flex: 1, gap: 20, justifyContent: 'center' },
  title: { fontSize: 32, fontWeight: '700' },
  footer: { gap: 8 },
  primary: { minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  primaryText: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  textButton: { minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  textButtonText: { fontSize: 17 },
  apple: { minHeight: 52, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 16 },
  appleLogo: { fontSize: 22 },
  appleText: { fontSize: 19, fontWeight: '600' },
  error: { fontSize: 15 },
  stepper: { borderRadius: 14, padding: 16, gap: 8 },
  stepperLabel: { fontSize: 15, fontWeight: '600' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  stepperButton: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, alignItems: 'center', justifyContent: 'center' },
  stepperGlyph: { fontSize: 24, fontWeight: '600' },
  stepperValue: { fontSize: 28, fontWeight: '700', flexShrink: 1, textAlign: 'center' },
});
