import { useCallback } from 'react';

import { useApi } from '@/api/ApiProvider';
import type { ApiClient } from '@/api/types';

export interface ProfileTimes {
  briefTime: string;
  checkinTime: string;
}

export type SaveTimes = (times: ProfileTimes) => Promise<void>;

/**
 * Adapter between the Times step and the profile API (US-11 adds updateProfileTimes to ApiClient).
 * Until that lands on this branch it is a local no-op, so the UI can be built and tested.
 */
type WithProfile = ApiClient & { updateProfileTimes?: (times: Partial<ProfileTimes>) => Promise<unknown> };

export function useSaveTimes(): SaveTimes {
  const api = useApi() as WithProfile;
  return useCallback(
    async (times) => {
      if (typeof api.updateProfileTimes === 'function') await api.updateProfileTimes(times);
    },
    [api],
  );
}
