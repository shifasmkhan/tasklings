import { requireOptionalNativeModule } from 'expo';

// Types and loader for the TasklingsSpeech native module (ios/). The JS wrapper that implements the
// app's SpeechRecognizer interface is src/features/capture/speech/nativeSpeechRecognizer.ts.

export interface NativeSpeechEvents {
  onPartial: { text: string };
  onLevel: { level: number };
  onError: { code: string };
}

export interface NativeSpeechSubscription {
  remove(): void;
}

export interface NativeSpeechModule {
  /** Asks for permission if needed, then starts listening. Rejects with an error whose `code` is permission_denied, unavailable or failed. */
  start(): Promise<void>;
  /** Stops listening and resolves with the final transcript. */
  stop(): Promise<string>;
  /** Stops listening and discards everything. */
  cancel(): void;
  addListener<K extends keyof NativeSpeechEvents>(
    event: K,
    listener: (payload: NativeSpeechEvents[K]) => void,
  ): NativeSpeechSubscription;
}

/** The native module, or null where it isn't built in (Expo Go, web, Jest). */
export function loadNativeSpeechModule(): NativeSpeechModule | null {
  try {
    return requireOptionalNativeModule<NativeSpeechModule>('TasklingsSpeech');
  } catch {
    return null;
  }
}
