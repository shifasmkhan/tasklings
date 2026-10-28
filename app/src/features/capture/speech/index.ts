import { createMockSpeechRecognizer } from './mockSpeechRecognizer';
import type { SpeechRecognizer } from './SpeechRecognizer';

export * from './SpeechRecognizer';
export { createMockSpeechRecognizer } from './mockSpeechRecognizer';
export type { MockSpeechOptions, MockSpeechScript } from './mockSpeechRecognizer';

/**
 * The app's recognizer.
 *
 * TODO(native-ios): this is the one place to swap in the real on-device recognizer. The Native iOS
 * workstream builds a native module (SFSpeechRecognizer with on-device recognition required) that
 * implements `SpeechRecognizer`, plus the microphone and speech-recognition usage strings in
 * app.json. Return it here. Don't add a speech library: that module is the only speech dependency.
 */
export function createSpeechRecognizer(): SpeechRecognizer {
  return createMockSpeechRecognizer();
}
