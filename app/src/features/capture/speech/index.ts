import { loadNativeSpeechModule } from '../../../../modules/tasklings-speech/src';
import { createMockSpeechRecognizer } from './mockSpeechRecognizer';
import { createNativeSpeechRecognizer } from './nativeSpeechRecognizer';
import type { SpeechRecognizer } from './SpeechRecognizer';

export * from './SpeechRecognizer';
export { createMockSpeechRecognizer } from './mockSpeechRecognizer';
export { createNativeSpeechRecognizer, toSpeechErrorCode } from './nativeSpeechRecognizer';
export type { MockSpeechOptions, MockSpeechScript } from './mockSpeechRecognizer';

/**
 * The app's recognizer: the on-device native module (US-01) when it is built into the app, else the
 * scripted mock (Jest, Expo Go, web). Audio stays on the phone: the module requires on-device
 * recognition and has no server fallback.
 */
export function createSpeechRecognizer(): SpeechRecognizer {
  const native = loadNativeSpeechModule();
  return native ? createNativeSpeechRecognizer(native) : createMockSpeechRecognizer();
}
