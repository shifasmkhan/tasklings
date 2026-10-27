import * as Haptics from 'expo-haptics';

/** Completion haptic (US-04). Failures are ignored: haptics are a nicety, never a blocker. */
export function completionHaptic(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}

export function selectionHaptic(): void {
  Haptics.selectionAsync().catch(() => undefined);
}
