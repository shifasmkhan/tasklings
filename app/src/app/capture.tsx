import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import { clearCaptureLaunch, peekCaptureLaunch } from '@/features/capture/captureLaunch';
import { releaseIntentCover } from '@/features/capture/intentLaunch';
import { CaptureSheet, COPY } from '@/features/capture/CaptureSheet';

/**
 * Deliberately reads NO route parameters. `tasklings://capture` (or `?start=lock&...`) from another
 * app or a web page must open the sheet idle; only our own code can arm auto-start, in-process
 * (see captureLaunch.ts).
 */
export default function CaptureRoute() {
  const router = useRouter();
  const [launch] = useState(peekCaptureLaunch);
  // Read once, then drop the flag so it can't apply to a later open.
  useEffect(() => {
    clearCaptureLaunch();
    // However the sheet goes away (button, swipe down), Today may show tasks again.
    return releaseIntentCover;
  }, []);
  return <CaptureSheet onClose={() => router.back()} startLocked={launch.autoStart} hint={launch.firstNoteHint ? COPY.firstNoteHint : undefined} />;
}
