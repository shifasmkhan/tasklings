import type { SpeechListener, SpeechRecognizer } from './SpeechRecognizer';
import { SpeechRecognizerError } from './SpeechRecognizer';

// Mock recognizer: plays a scripted synthetic transcript as partial results. Synthetic text only.
// The words also steer the mock backend (api/mock.ts): "nothing to add" yields zero tasks and
// "garbled" yields the needs_review fallback, so demos can show every outcome.

export type MockSpeechScript = 'default' | 'empty' | 'fallback';

const SCRIPTS: Record<MockSpeechScript, string> = {
  default:
    'Call the dentist to move the cleaning, buy stamps at the post office, and email Sam about the invoice tomorrow.',
  empty: 'Um, never mind, nothing to add.',
  fallback: 'Garbled. Buy stamps, book the vet, email Sam about the invoice.',
};

export interface MockSpeechOptions {
  /** Which scripted transcript to play. Default: three ordinary tasks. */
  script?: MockSpeechScript;
  /** Overrides the script with exact text. */
  transcript?: string;
  /** Start rejects with permission_denied. */
  denyPermission?: boolean;
  /** Ends the run on its own after this many ticks, like an interruption: onEnded fires and stop() still returns the text so far. */
  endAfterTicks?: number;
  /** Milliseconds between partial results. Default 400. */
  tickMs?: number;
}

/** Words revealed per tick. */
const WORDS_PER_TICK = 2;

export function createMockSpeechRecognizer(options: MockSpeechOptions = {}): SpeechRecognizer {
  const text = options.transcript ?? SCRIPTS[options.script ?? 'default'];
  const words = text.split(/\s+/).filter(Boolean);
  const tickMs = options.tickMs ?? 400;
  let timer: ReturnType<typeof setInterval> | null = null;
  let revealed = 0;
  let tick = 0;
  let listening = false;

  function halt() {
    if (timer) clearInterval(timer);
    timer = null;
    listening = false;
  }

  return {
    async start(listener: SpeechListener) {
      if (options.denyPermission) throw new SpeechRecognizerError('permission_denied');
      halt();
      revealed = 0;
      tick = 0;
      listening = true;
      timer = setInterval(() => {
        tick += 1;
        revealed = Math.min(words.length, revealed + WORDS_PER_TICK);
        listener.onPartial(words.slice(0, revealed).join(' '));
        // Deterministic, lively-looking levels. Not random: tests stay stable.
        listener.onLevel?.(0.25 + 0.7 * Math.abs(Math.sin(tick * 1.3)));
        if (options.endAfterTicks !== undefined && tick >= options.endAfterTicks) {
          // Stop the clock but stay "listening", so stop() returns what was heard.
          if (timer) clearInterval(timer);
          timer = null;
          listener.onEnded?.();
        }
      }, tickMs);
    },

    async stop() {
      const wasListening = listening;
      halt();
      // Like a real recognizer, whatever was heard so far is final.
      return wasListening ? words.slice(0, revealed).join(' ') : '';
    },

    cancel() {
      halt();
      revealed = 0;
    },
  };
}
