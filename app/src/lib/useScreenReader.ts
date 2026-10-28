import { useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';

/** A ref that tracks whether a screen reader (VoiceOver) is running; read it when a toast starts. */
export function useScreenReaderRef() {
  const enabled = useRef(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled().then(
      (on) => {
        if (active) enabled.current = on;
      },
      () => undefined,
    );
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (on) => {
      enabled.current = on;
    });
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return enabled;
}
