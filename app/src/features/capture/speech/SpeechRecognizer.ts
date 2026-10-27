// The boundary between the Capture sheet and speech recognition (US-01).
// The sheet depends on this interface only. The real on-device recognizer is a native module
// built by the Native iOS workstream (see ./index.ts); until then the app uses the mock.

export type SpeechErrorCode =
  /** The user denied microphone or speech-recognition access. */
  | 'permission_denied'
  /** Recognition isn't available on this device or in this language right now. */
  | 'unavailable'
  /** The recognizer failed while listening. */
  | 'failed';

export class SpeechRecognizerError extends Error {
  readonly code: SpeechErrorCode;

  constructor(code: SpeechErrorCode) {
    // The message is for developers; UI copy comes from the code. Never put transcript text here.
    super(`Speech recognizer error: ${code}`);
    this.name = 'SpeechRecognizerError';
    this.code = code;
  }
}

export interface SpeechListener {
  /** Live transcript so far. Replaces the previous partial; it is not a delta. */
  onPartial: (transcript: string) => void;
  /** Input level from 0 to 1, a few times a second, for the waveform. */
  onLevel?: (level: number) => void;
  /** Listening stopped on its own with an error. The recognizer is idle afterwards. */
  onError: (error: SpeechRecognizerError) => void;
}

export interface SpeechRecognizer {
  /**
   * Asks for permission if needed, then starts listening and streams partial results.
   * Rejects with SpeechRecognizerError('permission_denied') when access is refused.
   */
  start(listener: SpeechListener): Promise<void>;
  /** Stops listening and resolves with the final transcript (possibly empty). */
  stop(): Promise<string>;
  /** Stops listening and discards everything. No final transcript is produced. */
  cancel(): void;
}

export function isSpeechRecognizerError(value: unknown): value is SpeechRecognizerError {
  return value instanceof SpeechRecognizerError;
}
