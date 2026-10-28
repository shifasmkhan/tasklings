import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MicIcon } from '@/components/icons';
import { MIN_TOUCH, usePalette } from '@/theme/colors';
import { useCaptureStore } from './CaptureProvider';
import { HoldToTalk } from './HoldToTalk';
import { createSpeechRecognizer } from './speech';
import type { SpeechRecognizer } from './speech/SpeechRecognizer';
import { formatElapsed, MAX_RECORDING_MS, useCaptureSession } from './useCaptureSession';
import { Waveform } from './Waveform';

/** Longest typed note the sheet accepts. Keeps the request far under the 64 KiB edge-function limit. */
export const MAX_TYPED_CHARS = 10_000;

export const COPY = {
  denied: 'Microphone or speech access is off, so Tasklings can’t listen. Turn it on in Settings, or type instead.',
  noSpeech: 'Didn’t catch anything. Hold the mic and try again, or type instead.',
  unavailable: 'Voice capture isn’t available right now. You can type instead.',
  idleHint: 'Hold to talk · tap to lock',
  holdingHint: 'Release to save · slide up to lock · slide left to cancel',
  lockedHint: 'Locked · tap to stop and save',
  footnote: `Tasks get sorted after you save. Notes can run up to ${MAX_RECORDING_MS / 60_000} minutes.`,
  typeFootnote: 'Press Return to save. Write as many things as you like; they get sorted after you save.',
} as const;

interface Props {
  /** Closes the sheet. */
  onClose: () => void;
  /** Swap point for the real recognizer in tests and, later, the native module. */
  createRecognizer?: () => SpeechRecognizer;
  /** Opened by a tap on Today's mic: start locked recording as soon as the sheet appears. */
  startLocked?: boolean;
}

/**
 * The Capture sheet (US-01 voice, US-02 typing). Saving closes it at once; Today takes over from
 * there (US-03).
 */
export function CaptureSheet({ onClose, createRecognizer = createSpeechRecognizer, startLocked = false }: Props) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const store = useCaptureStore();
  // One recognizer for the life of the sheet.
  const [recognizer] = useState(() => createRecognizer());
  const s = useCaptureSession({ recognizer, store, onClose });

  const autoStarted = useRef(false);
  const { startLocked: beginLocked } = s;
  useEffect(() => {
    if (!startLocked || autoStarted.current) return;
    autoStarted.current = true;
    beginLocked();
  }, [startLocked, beginLocked]);

  const recording = s.phase === 'holding' || s.phase === 'locked';
  const typing = s.phase === 'typing';
  const denied = s.phase === 'denied';
  const statusLabel = `${s.phase === 'locked' ? 'Recording, locked' : 'Listening'} · ${formatElapsed(s.elapsedSec)}`;
  const footerHint = s.phase === 'holding' ? COPY.holdingHint : s.phase === 'locked' ? COPY.lockedHint : COPY.idleHint;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.sheet, { backgroundColor: p.card, paddingBottom: Math.max(insets.bottom, 16) }]}
    >
      <View style={styles.header}>
        <Pressable role="button" aria-label="Cancel" onPress={s.cancelAndClose} style={styles.headerSide}>
          <Text style={[styles.headerAction, { color: p.accent }]}>Cancel</Text>
        </Pressable>
        <Text role="heading" style={[styles.title, { color: p.text }]}>
          New task
        </Text>
        <View style={[styles.headerSide, styles.headerEnd]}>
          {typing || denied ? (
            <Pressable
              role="button"
              aria-label="Use voice instead"
              onPress={s.switchToVoice}
              style={styles.iconButton}
            >
              <MicIcon color={p.accent} />
            </Pressable>
          ) : (
            <Pressable role="button" aria-label="Type instead" onPress={s.openTyping} style={styles.iconButton}>
              <KeyboardGlyph color={p.accent} />
            </Pressable>
          )}
        </View>
      </View>

      {typing ? (
        <View style={styles.body}>
          <TextInput
            testID="typed-input"
            aria-label="What do you need to do?"
            placeholder="What do you need to do?"
            placeholderTextColor={p.secondaryText}
            value={s.typed}
            onChangeText={s.setTyped}
            autoFocus
            multiline
            // Return saves instead of adding a line (US-02).
            submitBehavior="submit"
            returnKeyType="done"
            enablesReturnKeyAutomatically
            maxLength={MAX_TYPED_CHARS}
            onSubmitEditing={s.submitTyped}
            style={[styles.input, { color: p.text }]}
          />
          <Text style={[styles.footnote, { color: p.secondaryText }]}>{COPY.typeFootnote}</Text>
        </View>
      ) : denied ? (
        <View style={styles.body}>
          <Text role="alert" style={[styles.message, { color: p.text }]}>
            {COPY.denied}
          </Text>
          <Pressable
            role="button"
            aria-label="Type instead"
            onPress={s.openTyping}
            style={[styles.primaryButton, { backgroundColor: p.accent }]}
          >
            <Text style={[styles.primaryText, { color: p.onAccent }]}>Type instead</Text>
          </Pressable>
          <Pressable role="button" aria-label="Open Settings" onPress={() => void Linking.openSettings()} style={styles.textButton}>
            <Text style={[styles.headerAction, { color: p.accent }]}>Open Settings</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <ScrollView style={styles.flex} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {recording ? (
              <View style={styles.statusRow}>
                <View accessible={false} aria-hidden style={[styles.dot, { backgroundColor: p.dropAction }]} />
                <Text
                  role="timer"
                  aria-label={`${s.phase === 'locked' ? 'Recording, locked' : 'Listening'}, ${formatElapsed(s.elapsedSec)}`}
                  style={[styles.status, { color: p.secondaryText }]}
                >
                  {statusLabel}
                </Text>
              </View>
            ) : null}
            {recording ? (
              <Text testID="live-transcript" style={[styles.transcript, { color: s.transcript ? p.text : p.secondaryText }]}>
                {s.transcript || 'Start talking…'}
              </Text>
            ) : null}
            {recording ? <Waveform levels={s.levels} /> : null}
            {s.notice ? (
              <Text role="alert" style={[styles.message, { color: p.text }]}>
                {s.notice === 'no_speech' ? COPY.noSpeech : COPY.unavailable}
              </Text>
            ) : null}
            <Text style={[styles.footnote, { color: p.secondaryText }]}>{COPY.footnote}</Text>
          </ScrollView>
          <View style={styles.footer}>
            <HoldToTalk
              phase={s.phase}
              onPressIn={s.pressIn}
              onRelease={s.release}
              onSlideUp={s.lock}
              onSlideLeft={s.cancelRecording}
              onStop={() => void s.stopAndSave()}
              onToggleLocked={s.toggleLocked}
              onCancel={s.cancelRecording}
            />
            <Text style={[styles.footerHint, { color: p.secondaryText }]} aria-hidden>
              {footerHint}
            </Text>
            {s.phase === 'locked' ? (
              <Pressable role="button" aria-label="Discard recording" onPress={s.cancelRecording} style={styles.textButton}>
                <Text style={[styles.headerAction, { color: p.accent }]}>Discard recording</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

/** Keyboard icon drawn with Views, like the app's other icons. */
function KeyboardGlyph({ color }: { color: string }) {
  return (
    <View accessible={false} aria-hidden style={[styles.kbd, { borderColor: color }]}>
      <View style={[styles.kbdBar, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingHorizontal: 20, paddingTop: 8 },
  flex: { flex: 1 },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerSide: { minWidth: MIN_TOUCH + 28, minHeight: MIN_TOUCH, justifyContent: 'center' },
  headerEnd: { alignItems: 'flex-end' },
  headerAction: { fontSize: 17 },
  title: { fontSize: 17, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  iconButton: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  body: { gap: 20, paddingTop: 12, flexGrow: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { fontSize: 15, fontWeight: '500' },
  transcript: { fontSize: 24, fontWeight: '600', lineHeight: 31 },
  footnote: { fontSize: 13 },
  message: { fontSize: 17, lineHeight: 24 },
  input: { fontSize: 24, fontWeight: '600', minHeight: 120, textAlignVertical: 'top', paddingVertical: 0 },
  primaryButton: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { fontSize: 17, fontWeight: '600' },
  textButton: { minHeight: MIN_TOUCH, justifyContent: 'center', alignItems: 'center' },
  footer: { alignItems: 'center', gap: 10, paddingTop: 8 },
  footerHint: { fontSize: 13, textAlign: 'center' },
  kbd: { width: 26, height: 18, borderWidth: 1.8, borderRadius: 4, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 3 },
  kbdBar: { width: 12, height: 1.8, borderRadius: 1 },
});
