import { ApiError, CLIENT_ERROR_CODES, toApiError } from './errors';
import type {
  ApiClient,
  DroppedReason,
  ProcessCaptureRequest,
  ProcessCaptureResponse,
  Session,
  Task,
  TaskEdit,
  TaskKind,
  TodayTasks,
} from './types';
import { TASK_EDITABLE_FIELDS } from './types';

// Thin stub of the real backend behind the same ApiClient interface. It is not wired into
// the app yet (the mock is the default) and has no tests against a live project.
// Open questions for the Backend workstream, assumed here and flagged in the PR:
// - RPC argument names: { id } and { id, reason }.
// - today_tasks() response shape: either { quick, errand, project } or a flat array.

export interface SupabaseConfig {
  url: string;
  /** Public anon key. Never the service-role key: that never ships in the app. */
  anonKey: string;
  /** Returns the current user JWT, or null when signed out. */
  getAccessToken: () => string | null;
  fetchImpl?: typeof fetch;
}

const EMPTY_TODAY: TodayTasks = { quick: [], errand: [], project: [] };
const KINDS: readonly TaskKind[] = ['quick', 'errand', 'project'];
const EDITABLE: readonly string[] = TASK_EDITABLE_FIELDS;

export function createSupabaseApi(config: SupabaseConfig): ApiClient {
  const base = config.url.replace(/\/+$/, '');
  if (!base.startsWith('https://')) {
    throw new ApiError('invalid_config', 'Supabase URL must use https');
  }
  const doFetch = config.fetchImpl ?? fetch;

  async function request<T>(path: string, init: { method: string; body?: unknown; auth?: boolean; headers?: Record<string, string> }): Promise<T> {
    const headers: Record<string, string> = {
      apikey: config.anonKey,
      'Content-Type': 'application/json',
      ...init.headers,
    };
    if (init.auth !== false) {
      const token = config.getAccessToken();
      if (!token) throw new ApiError('not_authenticated', 'Sign in first', 401);
      headers.Authorization = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new ApiError(CLIENT_ERROR_CODES.network, 'Network request failed');
    }
    if (res.status === 204) return undefined as T;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw toApiError(body, res.status);
    return body as T;
  }

  const rpc = <T>(name: string, args: Record<string, unknown> = {}) =>
    request<T>(`/rest/v1/rpc/${name}`, { method: 'POST', body: args });

  const fn = <T>(name: string, body?: unknown) =>
    request<T>(`/functions/v1/${name}`, { method: 'POST', body: body ?? {} });

  return {
    async signInWithApple(identityToken: string): Promise<Session> {
      const res = await request<{ access_token: string; expires_at: number; user: { id: string } }>(
        '/auth/v1/token?grant_type=id_token',
        { method: 'POST', auth: false, body: { provider: 'apple', id_token: identityToken } },
      );
      return { access_token: res.access_token, user_id: res.user.id, expires_at: res.expires_at };
    },

    processCapture(req: ProcessCaptureRequest): Promise<ProcessCaptureResponse> {
      return fn('process-capture', req);
    },

    async todayTasks(): Promise<TodayTasks> {
      const res = await rpc<unknown>('today_tasks');
      if (Array.isArray(res)) {
        const rows = res as Task[];
        return {
          quick: rows.filter((t) => t.kind === 'quick'),
          errand: rows.filter((t) => t.kind === 'errand'),
          project: rows.filter((t) => t.kind === 'project'),
        };
      }
      if (res && typeof res === 'object') {
        const grouped = res as Partial<TodayTasks>;
        return KINDS.reduce<TodayTasks>(
          (acc, k) => ({ ...acc, [k]: Array.isArray(grouped[k]) ? grouped[k] : [] }),
          EMPTY_TODAY,
        );
      }
      throw new ApiError(CLIENT_ERROR_CODES.badResponse, 'Unexpected today_tasks response');
    },

    completeTask: (id: string) => rpc<Task>('complete_task', { id }),
    undoTask: (id: string) => rpc<Task>('undo_task', { id }),
    deferTask: (id: string) => rpc<Task>('defer_task', { id }),
    dropTask: (id: string, reason?: DroppedReason) => rpc<Task>('drop_task', { id, reason: reason ?? null }),

    async updateTask(id: string, edit: TaskEdit): Promise<Task> {
      // Send only the PRD's editable columns, whatever the caller passed at runtime. The server
      // must still enforce this (column grants or a trigger): this is not the security boundary.
      const body = Object.fromEntries(
        Object.entries(edit).filter(([k, v]) => EDITABLE.includes(k) && v !== undefined),
      );
      const rows = await request<Task[]>(`/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body,
        headers: { Prefer: 'return=representation' },
      });
      const row = rows[0];
      if (!row) throw new ApiError('not_found', 'Task not found', 404);
      return row;
    },

    registerDevice: (apnsToken: string) => fn<void>('register-device', { apns_token: apnsToken }),
    exportData: () => fn<unknown>('export-data'),
    deleteAccount: () => fn<void>('delete-account'),
  };
}
