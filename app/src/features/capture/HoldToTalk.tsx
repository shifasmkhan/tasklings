import { useRef } from 'react';
import { StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import { MicIcon } from '@/components/icons';
import { usePalette } from '@/theme/colors';
import type { CapturePhase } from './useCaptureSession';

/** Slide this far up to lock, or left to cancel (points). */
export const SLIDE_UP_PT = 60;
export const SLIDE_LEFT_PT = 80;

interface Props {
  phase: CapturePhase;
  onPressIn: () => void;
  /** Finger lifted after a hold or a tap. */
  onRelease: () => void;
  onSlideUp: () => void;
  onSlideLeft: () => void;
  /** Tap on the button while recording is locked. */
  onStop: () => void;
  /** VoiceOver double-tap: start locked recording, or stop and save when already locked. */
  onToggleLocked: () => void;
  /** VoiceOver custom action: throw the recording away. */
  onCancel: () => void;
}

/**
 * The big mic button. Raw responder events instead of a gesture library: one finger, three
 * outcomes (release, slide up, slide left), and the same events drive the tests.
 */
export function HoldToTalk({ phase, onPressIn, onRelease, onSlideUp, onSlideLeft, onStop, onToggleLocked, onCancel }: Props) {
  const p = usePalette();
  const gesture = useRef({ x: 0, y: 0, fired: false, startedLocked: false });
  const holding = phase === 'holding';
  const locked = phase === 'locked';
  const busy = phase === 'saving';

  const label = locked
    ? 'Stop and save'
    : holding
      ? 'Recording. Release to save.'
      : busy
        ? 'Saving'
        : 'Record a task';
  const hint = locked
    ? 'Double-tap to stop and save the recording'
    : holding || busy
      ? undefined
      : 'Hold to talk. With VoiceOver, double-tap to start recording, then double-tap again to stop and save.';

  return (
    <View style={styles.wrap}>
      {holding ? (
        // Shows where to slide; the sheet's other buttons cover everything it does.
        <View accessible={false} aria-hidden style={[styles.lockHint, { backgroundColor: p.fill }]}>
          <Text style={[styles.lockGlyph, { color: p.secondaryText }]}>{'↑'}</Text>
        </View>
      ) : null}
      <View
        testID="hold-to-talk"
        accessible
        role="button"
        aria-label={label}
        accessibilityHint={hint}
        aria-busy={busy}
        accessibilityActions={[{ name: 'activate' }, ...(holding || locked ? [{ name: 'cancel', label: 'Cancel recording' }] : [])]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate') onToggleLocked();
          else if (e.nativeEvent.actionName === 'cancel') onCancel();
        }}
        onStartShouldSetResponder={() => !busy}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e: GestureResponderEvent) => {
          gesture.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, fired: false, startedLocked: locked };
          if (!locked) onPressIn();
        }}
        onResponderMove={(e: GestureResponderEvent) => {
          const g = gesture.current;
          if (g.startedLocked || g.fired) return;
          const dx = e.nativeEvent.pageX - g.x;
          const dy = e.nativeEvent.pageY - g.y;
          if (dx <= -SLIDE_LEFT_PT) {
            g.fired = true;
            onSlideLeft();
          } else if (dy <= -SLIDE_UP_PT) {
            g.fired = true;
            onSlideUp();
          }
        }}
        onResponderRelease={() => {
          const g = gesture.current;
          if (g.startedLocked) onStop();
          else if (!g.fired) onRelease();
        }}
        onResponderTerminate={() => {
          // The system took the touch (a call, a gesture). Keep the recording rather than lose it.
          const g = gesture.current;
          if (!g.startedLocked && !g.fired) onSlideUp();
        }}
        style={[
          styles.mic,
          locked
            ? { backgroundColor: p.card, borderColor: p.accent, borderWidth: 4 }
            : { backgroundColor: p.accent, borderColor: p.accent, borderWidth: 0 },
          holding ? styles.halo : null,
          busy ? styles.busy : null,
        ]}
      >
        {locked ? (
          <View accessible={false} aria-hidden style={[styles.stopSquare, { backgroundColor: p.accent }]} />
        ) : (
          <MicIcon color={p.onAccent} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 10 },
  mic: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center' },
  halo: { shadowColor: '#4458D6', shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  busy: { opacity: 0.5 },
  stopSquare: { width: 30, height: 30, borderRadius: 8 },
  lockHint: { width: 44, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  lockGlyph: { fontSize: 20 },
});
