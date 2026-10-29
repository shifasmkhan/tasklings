import { useSyncExternalStore } from 'react';

import type { NativeIntentsModule } from '../../../modules/tasklings-intents/src';
import { armCaptureLaunch, clearCaptureLaunch } from './captureLaunch';

/**
 * State for launches made by our own App Intent (Siri, Shortcuts, Action Button, Control Center
 * control, Home Screen widget button). `consumePendingLaunch()` is true only for those: it is set
 * in-process by the intent, never by a URL.
 *
 * - `cover`: while true Today renders a neutral background, so existing tasks are never visible
 *   behind the sheet (lock screen and Action Button captures).
 * - `pendingOpen`: the sheet still has to be opened (waits for navigation and the onboarding gate).
 */
interface State {
  cover: boolean;
  pendingOpen: boolean;
}

let state: State = { cover: false, pendingOpen: false };
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  listeners.forEach((l) => l());
}

/** Reads the one-shot flag from the native module; on a hit, covers Today and queues the sheet. */
export function pollIntentLaunch(native: NativeIntentsModule | null): boolean {
  if (!native) return false;
  let hit = false;
  try {
    hit = native.consumePendingLaunch();
  } catch {
    hit = false;
  }
  if (!hit) return false;
  armCaptureLaunch({ autoStart: true });
  set({ cover: true, pendingOpen: true });
  return true;
}

/** The sheet was opened (or the launch was dropped): nothing is queued any more. */
export function markIntentLaunchHandled(): void {
  if (state.pendingOpen) set({ ...state, pendingOpen: false });
}

/** Today may show tasks again. Called when the Capture sheet goes away, or the launch is dropped. */
export function releaseIntentCover(): void {
  if (state.cover || state.pendingOpen) set({ cover: false, pendingOpen: false });
}

/** The launch can't be honoured (e.g. first-run onboarding): forget it and clear the armed flag. */
export function dropIntentLaunch(): void {
  clearCaptureLaunch();
  releaseIntentCover();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useIntentLaunchState(): State {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function useIntentCover(): boolean {
  return useIntentLaunchState().cover;
}

export function resetIntentLaunchForTests(): void {
  state = { cover: false, pendingOpen: false };
  listeners.clear();
}
