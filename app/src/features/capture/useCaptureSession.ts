import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { logEvent } from '@/lib/log';
import type { CaptureStore } from './captureStore';
import { isSpeechRecognizerError, type SpeechRecognizer } from './speech/SpeechRecognizer';

/** A note can run up to 2 minutes; at the cap it saves by itself (US-01). */
export const MAX_RECORDING_MS = 120_000;
/** A press shorter than this is a tap: it locks recording instead of being a hold. */
export const TAP_MAX_MS = 300;
/** Bars shown in the waveform. */
export const WAVEFORM_BARS = 28;

export type CapturePhase =
  | 'idle'
  /** Finger down on the mic. */
  | 'holding'
  /** Recording continues with the finger up; tap again to stop. */
  | 'locked'
  /** Stopped; waiting for the final transcript. */
  | 'saving'
  | 'typing'
  /** Microphone or speech permission refused. */
  | 'denied';

export type CaptureNotice = 'no_speech' | 'unavailable' | null;

export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * State machine for the Capture sheet: hold to talk, tap or slide up to lock, slide left to cancel,
 * type instead, and save. Saving hands the note to the CaptureStore and closes the sheet at once.
 * Transcripts live in this hook's state and the store only. They are never logged.
 */
export function useCaptureSession(args: {
  recognizer: SpeechRecognizer;
  store: CaptureStore;
  /** Closes the sheet. */
  onClose: () => void;
}) {
  const { recognizer, store, onClose } = args;
  const [phase, setPhaseState] = useState<CapturePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [levels, setLevels] = useState<number[]>([]);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [notice, setNotice] = useState<CaptureNotice>(null);
  const [typed, setTyped] = useState('');

  const phaseRef = useRef<CapturePhase>('idle');
  const transcriptRef = useRef('');
  // Bumped whenever a recording ends, so late callbacks from an old recording are ignored.
  const sessionRef = useRef(0);
  const startRef = useRef<Promise<void> | null>(null);
  const startedAtRef = useRef(0);
  const pressedAtRef = useRef(0);
  const closedRef = useRef(false);

  // Phase read through a function so TypeScript doesn't narrow it across awaits.
  const phaseNow = useCallback((): CapturePhase => phaseRef.current, []);

  const setPhase = useCallback((next: CapturePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const clearRecording = useCallback(() => {
    transcriptRef.current = '';
    setTranscript('');
    setLevels([]);
    setElapsedSec(0);
  }, []);

  const startRecording = useCallback(
    (mode: 'holding' | 'locked') => {
      if (phaseRef.current !== 'idle') return;
      sessionRef.current += 1;
      const session = sessionRef.current;
      setNotice(null);
      clearRecording();
      setPhase(mode);
      startedAtRef.current = Date.now();
      const run = recognizer
        .start({
          onPartial: (text) => {
            if (session !== sessionRef.current) return;
            transcriptRef.current = text;
            setTranscript(text);
          },
          onLevel: (level) => {
            if (session !== sessionRef.current) return;
            setLevels((prev) => [...prev.slice(-(WAVEFORM_BARS - 1)), Math.min(1, Math.max(0, level))]);
          },
          onError: (error) => {
            if (session !== sessionRef.current) return;
            sessionRef.current += 1;
            logEvent('capture.speech_error', { code: error.code });
            recognizer.cancel();
            clearRecording();
            if (error.code === 'permission_denied') setPhase('denied');
            else {
              setNotice('unavailable');
              setPhase('idle');
            }
          },
        })
        .catch((error: unknown) => {
          if (session !== sessionRef.current) return;
          sessionRef.current += 1;
          const code = isSpeechRecognizerError(error) ? error.code : 'failed';
          logEvent('capture.speech_start_failed', { code });
          clearRecording();
          if (code === 'permission_denied') setPhase('denied');
          else {
            setNotice('unavailable');
            setPhase('idle');
          }
        });
      startRef.current = run;
    },
    [clearRecording, recognizer, setPhase],
  );

  const save = useCallback(async () => {
    if (phaseRef.current !== 'holding' && phaseRef.current !== 'locked') return;
    setPhase('saving');
    // Let a start that is still asking for permission settle before stopping.
    await startRef.current;
    if (phaseNow() !== 'saving') return; // start failed, or the sheet was cancelled meanwhile
    const session = sessionRef.current;
    let finalText: string;
    try {
      finalText = await recognizer.stop();
    } catch {
      finalText = '';
    }
    if (phaseNow() !== 'saving' || session !== sessionRef.current) return;
    sessionRef.current += 1;
    // If the recognizer gave nothing final, keep what was already on screen.
    const text = (finalText.trim() || transcriptRef.current.trim()).trim();
    if (!text) {
      clearRecording();
      setNotice('no_speech');
      setPhase('idle');
      return;
    }
    store.submit({ source: 'voice', transcript: text });
    closedRef.current = true;
    onClose();
  }, [clearRecording, onClose, phaseNow, recognizer, setPhase, store]);

  const cancelRecording = useCallback(() => {
    if (phaseRef.current !== 'holding' && phaseRef.current !== 'locked' && phaseRef.current !== 'saving') return;
    sessionRef.current += 1;
    recognizer.cancel();
    clearRecording();
    setPhase('idle');
    AccessibilityInfo.announceForAccessibility('Recording cancelled');
  }, [clearRecording, recognizer, setPhase]);

  const lock = useCallback(() => {
    if (phaseRef.current !== 'holding') return;
    setPhase('locked');
    AccessibilityInfo.announceForAccessibility('Recording locked. Double-tap the stop button to save.');
  }, [setPhase]);

  const pressIn = useCallback(() => {
    pressedAtRef.current = Date.now();
    startRecording('holding');
  }, [startRecording]);

  const release = useCallback(() => {
    if (phaseRef.current !== 'holding') return;
    if (Date.now() - pressedAtRef.current < TAP_MAX_MS) lock();
    else void save();
  }, [lock, save]);

  /** VoiceOver alternative to hold-to-talk: double-tap starts locked recording, double-tap again saves. */
  const toggleLocked = useCallback(() => {
    if (phaseRef.current === 'idle') startRecording('locked');
    else if (phaseRef.current === 'locked') void save();
  }, [save, startRecording]);

  /** A tap on Today's mic: start locked recording straight away (only from idle). */
  const startLocked = useCallback(() => startRecording('locked'), [startRecording]);

  const openTyping = useCallback(() => {
    if (phaseRef.current === 'holding' || phaseRef.current === 'locked' || phaseRef.current === 'saving') {
      sessionRef.current += 1;
      recognizer.cancel();
      clearRecording();
    }
    setNotice(null);
    setPhase('typing');
  }, [clearRecording, recognizer, setPhase]);

  const switchToVoice = useCallback(() => {
    if (phaseRef.current === 'typing' || phaseRef.current === 'denied') setPhase('idle');
  }, [setPhase]);

  /** Return key in the text field. */
  const submitTyped = useCallback(() => {
    if (phaseRef.current !== 'typing') return;
    const text = typed.trim();
    if (!text) return;
    store.submit({ source: 'text', transcript: text });
    closedRef.current = true;
    onClose();
  }, [onClose, store, typed]);

  /** Header Cancel: throws away anything unsaved and closes. */
  const cancelAndClose = useCallback(() => {
    sessionRef.current += 1;
    recognizer.cancel();
    onClose();
  }, [onClose, recognizer]);

  // Clock, and the 2-minute cap.
  const recording = phase === 'holding' || phase === 'locked';
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedSec(Math.floor(elapsed / 1000));
      if (elapsed >= MAX_RECORDING_MS) {
        AccessibilityInfo.announceForAccessibility('Two minute limit reached. Saving.');
        void save();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [recording, save]);

  // Leaving the screen any other way (swipe down, back) must not leave the microphone on.
  useEffect(
    () => () => {
      sessionRef.current += 1;
      if (!closedRef.current) recognizer.cancel();
    },
    [recognizer],
  );

  return useMemo(
    () => ({
      phase,
      transcript,
      levels,
      elapsedSec,
      notice,
      typed,
      setTyped,
      pressIn,
      release,
      lock,
      cancelRecording,
      toggleLocked,
      startLocked,
      openTyping,
      switchToVoice,
      submitTyped,
      cancelAndClose,
      stopAndSave: save,
    }),
    [phase, transcript, levels, elapsedSec, notice, typed, pressIn, release, lock, cancelRecording, toggleLocked, startLocked, openTyping, switchToVoice, submitTyped, cancelAndClose, save],
  );
}
