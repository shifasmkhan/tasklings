import { useCallback } from 'react';

import { useApi } from '@/api/ApiProvider';

export interface ProfileTimes {
  briefTime: string;
  checkinTime: string;
}

export type SaveTimes = (times: ProfileTimes) => Promise<void>;

/** The Times step saves through ApiClient.updateProfileTimes (US-11). */
export function useSaveTimes(): SaveTimes {
  const api = useApi();
  return useCallback(
    async (times) => {
      await api.updateProfileTimes(times);
    },
    [api],
  );
}
