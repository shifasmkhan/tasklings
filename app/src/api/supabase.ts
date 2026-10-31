// supabase-js stays behind this one file; polyfill first, because supabase-js builds URLs with
// URL.searchParams, which React Native's built-in URL only approximates.
import 'react-native-url-polyfill/auto';

import {
  createClient,
  FunctionsFetchError,
  FunctionsHttpError,
  isAuthRetryableFetchError,
  type SupabaseClient,
} from '@supabase/supabase-js';

import type { CaptureArrivals } from './arrivals';
import { assertClockTime, normalizeClockTime } from './clockTime';
import { ApiError, CLIENT_ERROR_CODES, toApiError } from './errors';
import type { SessionStorage } from './secureSessionStorage';
import { createSupabaseArrivals, TASK_COLUMNS } from './supabaseArrivals';
import type {
  ApiClient,
  DroppedReason,
  Enrichment,
  EnrichmentType,
  ProcessCaptureRequest,
  ProcessCaptureResponse,
  Profile,
  ProfileTimesInput,
  Session,
  Task,
  TaskDetail,
  TaskEdit,
  TaskKind,
  TodayTasks,
} from './types';
import { TASK_EDITABLE_FIELDS } from './types';

// The real backend behind the ApiClient interface, on supabase-js. RPC names, arguments, the
// today_tasks() shape and error codes follow supabase/README.md: RPC args are { id }, { id, reason }
// and { capture_id }; today_tasks() returns a flat array ordered by kind (quick, errand, project),
// then sort_order. Sign-in itself is US-10: until it exists there is no session, and every call
// except signInWithApple fails with `unauthenticated` without touching the network.

export interface SupabaseConfig {
  url: string;
  /**
   * Public by design (it is in every build of the app): the anon / publishable key. It carries no
   * privileges beyond what row-level security gives the signed-in user. A service-role or secret
   * key is refused.
   */
  anonKey: string;
  /** Where the session is kept. The app passes the Keychain-backed storage (secureSessionStorage.ts). */
  storage: SessionStorage;
  /** Refresh the access token in the background. Default true; tests turn it off. */
  autoRefreshToken?: boolean;
  fetchImpl?: typeof fetch;
  /** Test seam: the clock for the 30-day window of recentlyDropped. */
  now?: () => Date;
  /** Test seam: use this client instead of creating one. */
  client?: SupabaseClient;
}

export interface SupabaseApiClient extends ApiClient {
  /** Where a capture's tasks arrive: realtime on the captures row, then a read of its tasks. */
  arrivals: CaptureArrivals;
  /** The supabase-js client, for the app's auth wiring (AppState refresh, sign-in screens in US-10). */
  readonly client: SupabaseClient;
}

const KINDS: readonly TaskKind[] = ['quick', 'errand', 'project'];
const EDITABLE: readonly string[] = TASK_EDITABLE_FIELDS;
const PROFILE_COLUMNS = 'display_name,timezone,brief_time,checkin_time';
const ENRICHMENT_COLUMNS = 'id,type,value,source_url';
const ENRICHMENT_TYPES: readonly string[] = ['phone', 'url', 'address', 'hours', 'note'];
/** Dropped tasks stay in "Recently dropped" this long, counted from their last update. */
export const RECENTLY_DROPPED_DAYS = 30;
export const RECENTLY_DROPPED_LIMIT = 100;
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/** Refuses keys that must never ship in an app: service-role JWTs and new-style secret keys. */
export function assertPublicKey(key: string): void {
  if (!key || /^sb_secret_/.test(key)) {
    throw new ApiError('invalid_config', 'Use the public anon key, never a secret key');
  }
  const payload = key.split('.')[1];
  if (key.split('.').length === 3 && payload) {
    try {
      const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown };
      if (json.role === 'service_role') {
        throw new ApiError('invalid_config', 'Use the public anon key, never the service-role key');
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Not a decodable JWT (a publishable key, or a test value): nothing more to check.
    }
  }
}

interface PgError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

function fromPostgrest(error: PgError, status: number): ApiError {
  // postgrest-js reports a request that never got an answer as status 0.
  if (status === 0) return new ApiError(CLIENT_ERROR_CODES.network, 'Network request failed');
  return toApiError(
    { code: error.code ?? '', message: error.message ?? '', details: error.details ?? null, hint: error.hint ?? null },
    status,
  );
}

function unwrap<T>(res: { data: unknown; error: PgError | null; status: number }): T {
  if (res.error) throw fromPostgrest(res.error, res.status);
  return res.data as T;
}

async function fromFunctionsError(error: unknown): Promise<ApiError> {
  if (error instanceof FunctionsFetchError) return new ApiError(CLIENT_ERROR_CODES.network, 'Network request failed');
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return toApiError(body, typeof response.status === 'number' ? response.status : null);
  }
  return new ApiError(CLIENT_ERROR_CODES.unknown, 'Request failed');
}

function toProfile(row: unknown): Profile {
  const r = row as { display_name?: unknown; timezone?: unknown; brief_time?: unknown; checkin_time?: unknown } | null;
  if (!r || typeof r.timezone !== 'string') {
    throw new ApiError(CLIENT_ERROR_CODES.badResponse, 'Unexpected profile response');
  }
  return {
    displayName: typeof r.display_name === 'string' ? r.display_name : null,
    timezone: r.timezone,
    briefTime: normalizeClockTime(r.brief_time),
    checkinTime: normalizeClockTime(r.checkin_time),
  };
}

export function createSupabaseApi(config: SupabaseConfig): SupabaseApiClient {
  const base = config.url.replace(/\/+$/, '');
  if (!base.startsWith('https://') && !LOOPBACK.test(base)) {
    throw new ApiError('invalid_config', 'Supabase URL must use https');
  }
  assertPublicKey(config.anonKey);

  const client =
    config.client ??
    createClient(base, config.anonKey, {
      auth: {
        storage: config.storage,
        storageKey: 'tasklings.auth',
        persistSession: true,
        autoRefreshToken: config.autoRefreshToken ?? true,
        // No browser URL to read a session from in a native app.
        detectSessionInUrl: false,
      },
      global: config.fetchImpl ? { fetch: config.fetchImpl } : undefined,
      // Realtime is used only for the user's own captures; keep the connection quiet.
      realtime: { params: { eventsPerSecond: 5 } },
    });

  /** Fails closed: no session, no request (and the anon key is never used as a bearer). */
  async function requireSession(): Promise<void> {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) throw new ApiError('unauthenticated', 'Sign in first', 401);
  }

  async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await requireSession();
    return unwrap<T>(await client.rpc(name, args));
  }

  async function fn<T>(name: string, body?: unknown): Promise<T> {
    await requireSession();
    const { data, error } = await client.functions.invoke(name, { body: body ?? {} });
    if (error) throw await fromFunctionsError(error);
    return data as T;
  }

  return {
    client,
    arrivals: createSupabaseArrivals(client),

    async signInWithApple(identityToken: string, rawNonce: string): Promise<Session> {
      if (!identityToken || !rawNonce) {
        throw new ApiError('invalid_argument', 'Identity token and nonce are required', 400);
      }
      const { data, error } = await client.auth.signInWithIdToken({
        provider: 'apple',
        token: identityToken,
        nonce: rawNonce,
      });
      if (error || !data.session) {
        // The server's text is never passed on.
        if (error && isAuthRetryableFetchError(error)) {
          throw new ApiError(CLIENT_ERROR_CODES.network, 'Network request failed');
        }
        throw new ApiError('unauthenticated', 'Sign in failed', error?.status ?? 401);
      }
      const { session } = data;
      return {
        access_token: session.access_token,
        user_id: session.user.id,
        expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
      };
    },

    processCapture(req: ProcessCaptureRequest): Promise<ProcessCaptureResponse> {
      return fn<ProcessCaptureResponse>('process-capture', req);
    },

    async todayTasks(): Promise<TodayTasks> {
      const rows = await rpc<unknown>('today_tasks');
      if (!Array.isArray(rows)) {
        throw new ApiError(CLIENT_ERROR_CODES.badResponse, 'Unexpected today_tasks response');
      }
      // Filtering keeps the server's order, so each group stays in sort_order.
      const grouped: TodayTasks = { quick: [], errand: [], project: [] };
      for (const row of rows as Task[]) {
        if (KINDS.includes(row.kind)) grouped[row.kind].push(row);
      }
      return grouped;
    },

    async undoCapture(captureId: string): Promise<number> {
      const removed = await rpc<unknown>('undo_capture', { capture_id: captureId });
      if (typeof removed !== 'number') {
        throw new ApiError(CLIENT_ERROR_CODES.badResponse, 'Unexpected undo_capture response');
      }
      return removed;
    },

    completeTask: (id: string) => rpc<Task>('complete_task', { id }),
    undoTask: (id: string) => rpc<Task>('undo_task', { id }),
    deferTask: (id: string) => rpc<Task>('defer_task', { id }),
    dropTask: (id: string, reason?: DroppedReason) => rpc<Task>('drop_task', { id, reason: reason ?? null }),

    async updateTask(id: string, edit: TaskEdit): Promise<Task> {
      // Send only the PRD's editable columns, whatever the caller passed at runtime. The server
      // enforces this too (column grants and a trigger): this is not the security boundary.
      const body = Object.fromEntries(
        Object.entries(edit).filter(([k, v]) => EDITABLE.includes(k) && v !== undefined),
      );
      await requireSession();
      const rows = unwrap<Task[] | null>(await client.from('tasks').update(body).eq('id', id).select(TASK_COLUMNS));
      const row = rows?.[0];
      if (!row) throw new ApiError('task_not_found', 'Task not found', 404);
      return row;
    },

    async getProfile(): Promise<Profile> {
      await requireSession();
      // RLS limits the table to the caller's own row, so there is exactly one.
      return toProfile(unwrap<unknown>(await client.from('profiles').select(PROFILE_COLUMNS).single()));
    },

    async updateProfileTimes(input: ProfileTimesInput): Promise<Profile> {
      // Only these two columns are ever sent, whatever the caller passed at runtime.
      const body: { brief_time?: string; checkin_time?: string } = {};
      if (input.briefTime !== undefined) {
        assertClockTime(input.briefTime);
        body.brief_time = input.briefTime;
      }
      if (input.checkinTime !== undefined) {
        assertClockTime(input.checkinTime);
        body.checkin_time = input.checkinTime;
      }
      if (Object.keys(body).length === 0) throw new ApiError('invalid_request', 'Nothing to update', 400);
      const { data, error } = await client.auth.getSession();
      if (error || !data.session) throw new ApiError('unauthenticated', 'Sign in first', 401);
      const res = await client
        .from('profiles')
        .update(body)
        .eq('user_id', data.session.user.id)
        .select(PROFILE_COLUMNS)
        .single();
      return toProfile(unwrap<unknown>(res));
    },

    async getTask(id: string): Promise<TaskDetail> {
      await requireSession();
      if (!ANY_UUID.test(id)) throw new ApiError('not_found', 'Task not found', 404);
      const task = unwrap<Task | null>(await client.from('tasks').select(TASK_COLUMNS).eq('id', id).maybeSingle());
      if (!task) throw new ApiError('not_found', 'Task not found', 404);
      const [capture, found] = await Promise.all([
        task.capture_id
          ? client.from('captures').select('transcript').eq('id', task.capture_id).maybeSingle()
          : Promise.resolve({ data: null, error: null, status: 200 }),
        client.from('task_enrichments').select(ENRICHMENT_COLUMNS).eq('task_id', id).order('created_at', { ascending: true }),
      ]);
      const captureRow = unwrap<{ transcript?: unknown } | null>(capture);
      const rows = unwrap<{ id: string; type: string; value: string; source_url: string | null }[] | null>(found) ?? [];
      const enrichments: Enrichment[] = rows
        .filter((r) => ENRICHMENT_TYPES.includes(r.type))
        .map((r) => ({ id: r.id, type: r.type as EnrichmentType, value: r.value, sourceUrl: r.source_url ?? null }));
      return {
        ...task,
        transcript: typeof captureRow?.transcript === 'string' ? captureRow.transcript : null,
        enrichments,
      };
    },

    async recentlyDropped(): Promise<Task[]> {
      await requireSession();
      const since = new Date((config.now?.() ?? new Date()).getTime() - RECENTLY_DROPPED_DAYS * 86_400_000);
      const rows = unwrap<Task[] | null>(
        await client
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('status', 'dropped')
          .gte('updated_at', since.toISOString())
          .order('updated_at', { ascending: false })
          .limit(RECENTLY_DROPPED_LIMIT),
      );
      return rows ?? [];
    },

    async registerDevice(apnsToken: string): Promise<void> {
      await fn('register-device', { apns_token: apnsToken });
    },
    exportData: () => fn<unknown>('export-data'),
    async deleteAccount(appleAuthorizationCode: string): Promise<void> {
      if (!appleAuthorizationCode) {
        throw new ApiError('invalid_argument', 'Apple authorization code is required', 400);
      }
      await fn('delete-account', { apple_authorization_code: appleAuthorizationCode });
      // The auth user is gone server-side. Clear the Keychain session on this device only
      // (a global sign-out would call a server that no longer knows the user).
      await client.auth.signOut({ scope: 'local' });
    },
  };
}
