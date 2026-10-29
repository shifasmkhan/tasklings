// Notification permission (US-06), behind an interface. The real implementation needs
// expo-notifications, which adds the push entitlement and breaks free-tier device installs, so
// only the mock exists until the paid Apple membership. Do not add expo-notifications before then.

export type NotificationStatus = 'undetermined' | 'granted' | 'denied';

export interface NotificationPermission {
  status(): Promise<NotificationStatus>;
  /** Shows the system prompt if the status is undetermined. Resolves to the resulting status. */
  request(): Promise<NotificationStatus>;
}

export function createMockNotificationPermission(
  options: { initial?: NotificationStatus; answer?: 'granted' | 'denied' } = {},
): NotificationPermission {
  let current: NotificationStatus = options.initial ?? 'undetermined';
  return {
    async status() {
      return current;
    },
    async request() {
      if (current === 'undetermined') current = options.answer ?? 'granted';
      return current;
    },
  };
}

export function createNotificationPermission(): NotificationPermission {
  return createMockNotificationPermission();
}
