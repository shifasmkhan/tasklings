import { createContext, useContext, useState, type ReactNode } from 'react';

import { createDefaultApi } from './index';
import type { ApiClient } from './types';

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client?: ApiClient; children: ReactNode }) {
  const [value] = useState<ApiClient>(() => client ?? createDefaultApi());
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside ApiProvider');
  return api;
}
