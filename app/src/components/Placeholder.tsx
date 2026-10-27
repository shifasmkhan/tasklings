import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { MIN_TOUCH, usePalette } from '@/theme/colors';

interface Props {
  title: string;
  story: string;
  body: string;
  onClose: () => void;
  closeLabel?: string;
}

/** Navigable stand-in for a screen another story will build. */
export function Placeholder({ title, story, body, onClose, closeLabel = 'Close' }: Props) {
  const p = usePalette();
  return (
    <ScrollView
      style={{ backgroundColor: p.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text role="heading" style={[styles.title, { color: p.text }]}>
        {title}
      </Text>
      <Text style={[styles.story, { color: p.accent }]}>{story}</Text>
      <Text style={[styles.body, { color: p.secondaryText }]}>{body}</Text>
      <Pressable
        role="button"
        aria-label={closeLabel}
        onPress={onClose}
        style={({ pressed }) => [styles.button, { backgroundColor: p.accent, opacity: pressed ? 0.8 : 1 }]}
      >
        <Text style={[styles.buttonText, { color: p.onAccent }]}>{closeLabel}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 32, gap: 12 },
  title: { fontSize: 28, fontWeight: '700' },
  story: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
  body: { fontSize: 17, lineHeight: 22 },
  button: {
    marginTop: 12,
    minHeight: MIN_TOUCH + 4,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: 17, fontWeight: '600' },
});
