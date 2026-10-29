import { requireOptionalNativeModule } from 'expo';

// Types and loader for the TasklingsIntents native module (ios/). It reports whether the app was
// opened by our own "Add a task" App Intent. The URL scheme can never carry this signal.

export interface NativeIntentsSubscription {
  remove(): void;
}

export interface NativeIntentsModule {
  /** True once per intent run (reads and clears the flag); false if none, already consumed or older than 15 s. */
  consumePendingLaunch(): boolean;
  /** Fires in-process when the intent runs while the app is already alive. */
  addListener(event: 'onIntentLaunch', listener: () => void): NativeIntentsSubscription;
}

/** The native module, or null where it isn't built in (Expo Go, web, Jest). */
export function loadNativeIntentsModule(): NativeIntentsModule | null {
  try {
    return requireOptionalNativeModule<NativeIntentsModule>('TasklingsIntents');
  } catch {
    return null;
  }
}
