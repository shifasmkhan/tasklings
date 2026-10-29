/**
 * How the Capture sheet learns it should start recording or show the first-note hint (US-01).
 *
 * This is deliberately NOT a URL parameter: anything in a URL (`tasklings://capture?...`) can be
 * produced by another app or a web page, and starting the microphone must never be triggerable
 * from outside. Our own code arms this one-shot in-process flag just before opening the sheet, and
 * the sheet reads it once. A deep link therefore always opens the sheet idle.
 */
export interface CaptureLaunch {
  /** Start locked recording as soon as the sheet appears. */
  autoStart: boolean;
  /** Show the onboarding example line. */
  firstNoteHint: boolean;
}

const IDLE: CaptureLaunch = { autoStart: false, firstNoteHint: false };
/** An armed launch that the sheet doesn't pick up within this time is dropped. */
export const ARM_TTL_MS = 5000;

let armed: { launch: CaptureLaunch; at: number } | null = null;

export function armCaptureLaunch(launch: Partial<CaptureLaunch>): void {
  armed = { launch: { ...IDLE, ...launch }, at: Date.now() };
}

/** Pure read, safe to call during render. */
export function peekCaptureLaunch(): CaptureLaunch {
  if (!armed || Date.now() - armed.at > ARM_TTL_MS) return IDLE;
  return armed.launch;
}

/** The sheet calls this from an effect once it has read the launch, so it can't apply twice. */
export function clearCaptureLaunch(): void {
  armed = null;
}
