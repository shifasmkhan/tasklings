import type { NativeSpeechModule, NativeSpeechSubscription } from '../../../../modules/tasklings-speech/src';
import { SpeechRecognizerError, type SpeechErrorCode, type SpeechListener, type SpeechRecognizer } from './SpeechRecognizer';

// Adapts the on-device TasklingsSpeech native module (US-01) to the app's SpeechRecognizer.
// Never log or store transcript text here.

const KNOWN_CODES: readonly SpeechErrorCode[] = ['permission_denied', 'unavailable', 'failed'];

/** Maps whatever the native side threw to one of the interface's stable codes. */
export function toSpeechErrorCode(error: unknown): SpeechErrorCode {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return KNOWN_CODES.find((known) => known === code) ?? 'failed';
}

export function createNativeSpeechRecognizer(native: NativeSpeechModule): SpeechRecognizer {
  let subscriptions: NativeSpeechSubscription[] = [];
  /** Bumped on every start and cancel, so callbacks from an older run are ignored. */
  let run = 0;

  function unsubscribe() {
    subscriptions.forEach((subscription) => subscription.remove());
    subscriptions = [];
  }

  return {
    async start(listener: SpeechListener) {
      unsubscribe();
      run += 1;
      const mine = run;
      const current = () => mine === run;
      subscriptions = [
        native.addListener('onPartial', ({ text }) => {
          if (current()) listener.onPartial(text);
        }),
        native.addListener('onLevel', ({ level }) => {
          if (current()) listener.onLevel?.(Math.min(1, Math.max(0, level)));
        }),
        native.addListener('onError', ({ code }) => {
          if (!current()) return;
          // The native side is idle after an error.
          run += 1;
          unsubscribe();
          listener.onError(new SpeechRecognizerError(toSpeechErrorCode({ code })));
        }),
      ];
      try {
        await native.start();
      } catch (error) {
        if (current()) {
          run += 1;
          unsubscribe();
        }
        throw new SpeechRecognizerError(toSpeechErrorCode(error));
      }
    },

    async stop() {
      const wasActive = subscriptions.length > 0;
      // Partials that arrive while stopping are superseded by the final transcript.
      run += 1;
      unsubscribe();
      if (!wasActive) return '';
      try {
        return await native.stop();
      } catch {
        return '';
      }
    },

    cancel() {
      run += 1;
      unsubscribe();
      native.cancel();
    },
  };
}
