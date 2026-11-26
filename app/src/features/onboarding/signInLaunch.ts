/**
 * Lets Today's "You're signed out" card open onboarding straight on its Sign in step.
 *
 * Like captureLaunch.ts this is an in-process one-shot, not a URL parameter, so a deep link can't
 * pick a step. The onboarding route reads it once, on mount.
 */
const TTL_MS = 5000;
let armedAt: number | null = null;

export function armSignInLaunch(): void {
  armedAt = Date.now();
}

/** Returns true once per arm (and only within the TTL), then clears it. */
export function consumeSignInLaunch(): boolean {
  const live = armedAt !== null && Date.now() - armedAt <= TTL_MS;
  armedAt = null;
  return live;
}
