import type { CaptureArrival, CaptureArrivals } from './arrivals';
import { ApiError } from './errors';
import { assertClockTime } from './clockTime';
import { makeTask, mockEnrichments, MOCK_SEED_CAPTURE_ID, MOCK_SEED_TRANSCRIPT, MOCK_USER_ID, seedTasks } from './fixtures';
import { synthesizeCapture } from './syntheticCapture';
import type {
  ApiClient,
  CaptureSource,
  DroppedReason,
  Enrichment,
  IsoDate,
  ProcessCaptureRequest,
  ProcessCaptureResponse,
  Profile,
  ProfileTimesInput,
  Session,
  Task,
  TaskDetail,
  TaskEdit,
  TodayTasks,
} from './types';
import { TASK_EDITABLE_FIELDS } from './types';
import { addDays, deviceTimeZone, localIsoDate } from '@/lib/dates';

export interface MockApiOptions {
  /** Starting tasks. Defaults to the synthetic seed set. */
  tasks?: Task[];
  /** Returns today's date in the user's time zone. Defaults to the device date. */
  today?: () => IsoDate;
  /** Clock for completed_at and updated_at. */
  now?: () => Date;
  /** Artificial latency in ms. */
  latencyMs?: number;
  /**
   * How long process-capture takes to "extract" before its tasks arrive (the stand-in for the
   * realtime push). Default 1200 ms.
   */
  captureResultDelayMs?: number;
  /** Test seam: transcripts by capture_id, beside the seeded synthetic one. */
  transcripts?: Record<string, string>;
  /** Test seam: enrichments by task id; defaults to the synthetic fixtures. */
  enrichments?: (taskId: string) => Enrichment[];
}

export interface MockApiClient extends ApiClient {
  /** Test hook: the next call rejects with this standard error. */
  failNext(code: string, message?: string): void;
  /** Test hook: a copy of every stored task. */
  snapshot(): Task[];
  /** Test hook: the source stored for an accepted capture (captures.source), or undefined. */
  captureSource(captureId: string): CaptureSource | undefined;
  /** Stand-in for the realtime channel: where a capture's tasks arrive. */
  arrivals: CaptureArrivals;
}

const CAPTURE_SOURCES: readonly string[] = ['voice', 'text', 'siri', 'widget'];
/** undo_capture works for this long after the capture finished (supabase/README.md). */
export const UNDO_CAPTURE_WINDOW_MS = 30_000;

const EDITABLE: readonly string[] = TASK_EDITABLE_FIELDS;
const RECENTLY_DROPPED_MS = 30 * 86_400_000;
const RECENTLY_DROPPED_LIMIT = 100;

function defaultProfile(): Profile {
  return { displayName: null, timezone: deviceTimeZone(), briefTime: '08:00', checkinTime: '20:30' };
}

let taskCounter = 0;
/** Deterministic, unique, UUID-shaped ids for tasks the mock creates. */
function newTaskId(): string {
  taskCounter += 1;
  return `00000000-0000-4000-9000-${taskCounter.toString(16).padStart(12, '0')}`;
}

/**
 * In-memory implementation of every Phase 0 contract, so the app runs with no backend.
 * Behaviour follows the PRD queries: Today = open AND planned_for <= today, ordered by kind, sort_order.
 */
export function createMockApi(options: MockApiOptions = {}): MockApiClient {
  const today = options.today ?? (() => localIsoDate());
  const now = options.now ?? (() => new Date());
  const latency = options.latencyMs ?? 0;
  const tasks = new Map<string, Task>();
  // Prior versions for undo_task: done/dropped -> open, or a defer's previous planned_for (backend README).
  const history = new Map<string, Task[]>();
  let pendingFailure: ApiError | null = null;
  const resultDelay = options.captureResultDelayMs ?? 1200;
  // Captures already accepted: a retry of the same capture_id is idempotent, like the backend.
  // finishedAt is when the capture became `done` (the start of the undo_capture window).
  const captures = new Map<string, { source: CaptureSource; finishedAt: number | null }>();
  // Tasks changed since they were inserted (the backend sees this as updated_at moving).
  const touched = new Set<string>();
  const arrivalListeners = new Map<string, Set<(arrival: CaptureArrival) => void>>();
  const arrived = new Map<string, CaptureArrival>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let profile = defaultProfile();
  // Transcripts of captures, by capture_id: the seeded synthetic note plus every accepted capture.
  const transcripts = new Map<string, string>([
    [MOCK_SEED_CAPTURE_ID, MOCK_SEED_TRANSCRIPT],
    ...Object.entries(options.transcripts ?? {}),
  ]);

  for (const t of options.tasks ?? seedTasks(today())) tasks.set(t.id, { ...t });

  async function call<T>(fn: () => T): Promise<T> {
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    if (pendingFailure) {
      const err = pendingFailure;
      pendingFailure = null;
      throw err;
    }
    return fn();
  }

  function get(id: string): Task {
    const t = tasks.get(id);
    if (!t) throw new ApiError('task_not_found', 'Task not found', 404);
    return t;
  }

  function write(prev: Task, next: Partial<Task>, recordHistory = true): Task {
    if (recordHistory) history.set(prev.id, [...(history.get(prev.id) ?? []), prev]);
    touched.add(prev.id);
    const updated: Task = { ...prev, ...next, updated_at: now().toISOString() };
    tasks.set(updated.id, updated);
    return { ...updated };
  }

  /** Runs the synthetic extraction (keyword rules in syntheticCapture.ts) and creates the tasks. */
  function extract(request: ProcessCaptureRequest): CaptureArrival {
    const d = today();
    const outcome = synthesizeCapture(request.transcript, d, addDays(d, 1));
    const specs = outcome.type === 'tasks' ? outcome.tasks : outcome.type === 'fallback' ? [outcome.task] : [];
    let order = Math.max(-1, ...[...tasks.values()].map((t) => t.sort_order));
    const created = specs.map((spec) => {
      order += 1;
      const task = makeTask(
        {
          id: newTaskId(),
          capture_id: request.capture_id,
          title: spec.title,
          kind: spec.kind,
          effort_min: spec.effort_min,
          due_date: spec.due_date,
          needs_review: outcome.type === 'fallback',
          sort_order: order,
          created_at: now().toISOString(),
          updated_at: now().toISOString(),
        },
        d,
      );
      tasks.set(task.id, task);
      return { ...task };
    });
    return { capture_id: request.capture_id, tasks: created };
  }

  function deliver(arrival: CaptureArrival): void {
    const capture = captures.get(arrival.capture_id);
    if (capture) capture.finishedAt = now().getTime();
    arrived.set(arrival.capture_id, arrival);
    for (const listener of [...(arrivalListeners.get(arrival.capture_id) ?? [])]) {
      listener({ ...arrival, tasks: arrival.tasks.map((t) => ({ ...t })) });
    }
  }

  const arrivals: CaptureArrivals = {
    subscribe(captureId, listener) {
      const set = arrivalListeners.get(captureId) ?? new Set();
      arrivalListeners.set(captureId, set);
      const once = (arrival: CaptureArrival) => {
        set.delete(once);
        listener(arrival);
      };
      set.add(once);
      // Like a realtime catch-up, a result that already arrived is delivered straight away.
      const early = arrived.get(captureId);
      if (early) queueMicrotask(() => set.has(once) && once(early));
      return () => {
        set.delete(once);
      };
    },
  };

  function requireOpen(t: Task): void {
    if (t.status !== 'open') throw new ApiError('invalid_state', 'Task is not open', 409);
  }

  return {
    arrivals,

    captureSource: (captureId) => captures.get(captureId)?.source,

    failNext(code, message = 'Injected failure') {
      pendingFailure = new ApiError(code, message, 500);
    },

    snapshot() {
      return [...tasks.values()].map((t) => ({ ...t }));
    },

    signInWithApple(identityToken: string, rawNonce: string): Promise<Session> {
      return call(() => {
        if (!identityToken) throw new ApiError('unauthenticated', 'Missing identity token', 401);
        if (!rawNonce) throw new ApiError('invalid_argument', 'Missing nonce', 400);
        return {
          access_token: 'mock-session',
          user_id: MOCK_USER_ID,
          expires_at: Math.floor(now().getTime() / 1000) + 3600,
        };
      });
    },

    processCapture(request: ProcessCaptureRequest): Promise<ProcessCaptureResponse> {
      return call(() => {
        if (!request.capture_id) throw new ApiError('invalid_request', 'capture_id is required', 400);
        if (typeof request.transcript !== 'string' || request.transcript.trim() === '') {
          throw new ApiError('invalid_request', 'transcript is required', 400);
        }
        if (!request.timezone || Number.isNaN(Date.parse(request.captured_at))) {
          throw new ApiError('invalid_request', 'captured_at and timezone are required', 400);
        }
        // Strict, like the backend: omitted means voice; anything else outside the list is refused.
        if (request.source !== undefined && !CAPTURE_SOURCES.includes(request.source)) {
          throw new ApiError('invalid_request', 'source must be voice, text, siri or widget', 400);
        }
        if (!captures.has(request.capture_id)) {
          captures.set(request.capture_id, { source: request.source ?? 'voice', finishedAt: null });
          transcripts.set(request.capture_id, request.transcript);
          // 202 now; the tasks follow after the "extraction" delay, as they will by realtime.
          const timer = setTimeout(() => {
            timers.delete(timer);
            deliver(extract(request));
          }, resultDelay);
          timers.add(timer);
        }
        return { capture_id: request.capture_id };
      });
    },

    todayTasks(): Promise<TodayTasks> {
      return call(() => {
        const d = today();
        const open = [...tasks.values()]
          .filter((t) => t.status === 'open' && t.planned_for <= d)
          .sort((a, b) => a.sort_order - b.sort_order);
        return {
          quick: open.filter((t) => t.kind === 'quick').map((t) => ({ ...t })),
          errand: open.filter((t) => t.kind === 'errand').map((t) => ({ ...t })),
          project: open.filter((t) => t.kind === 'project').map((t) => ({ ...t })),
        };
      });
    },

    undoCapture(captureId: string): Promise<number> {
      return call(() => {
        if (!captureId) throw new ApiError('invalid_argument', 'capture_id is required', 400);
        const capture = captures.get(captureId);
        const expired = () => new ApiError('undo_expired', 'This capture can no longer be undone', 409);
        // Unknown, unfinished and too-old captures all look the same, like another user's.
        if (!capture || capture.finishedAt === null || now().getTime() - capture.finishedAt > UNDO_CAPTURE_WINDOW_MS) {
          throw expired();
        }
        const created = [...tasks.values()].filter((t) => t.capture_id === captureId);
        if (created.some((t) => t.status !== 'open' || touched.has(t.id))) throw expired();
        for (const t of created) {
          tasks.delete(t.id);
          history.delete(t.id);
          touched.delete(t.id);
        }
        return created.length;
      });
    },

    completeTask(id: string): Promise<Task> {
      return call(() => {
        const t = get(id);
        requireOpen(t);
        return write(t, { status: 'done', completed_at: now().toISOString() });
      });
    },

    undoTask(id: string): Promise<Task> {
      return call(() => {
        const t = get(id);
        const stack = history.get(id) ?? [];
        const prev = stack.pop();
        if (!prev) throw new ApiError('nothing_to_undo', 'Nothing to undo', 409);
        history.set(id, stack);
        return write(t, { ...prev }, false);
      });
    },

    deferTask(id: string): Promise<Task> {
      return call(() => {
        const t = get(id);
        requireOpen(t);
        return write(t, { planned_for: addDays(today(), 1) });
      });
    },

    dropTask(id: string, reason?: DroppedReason): Promise<Task> {
      return call(() => {
        const t = get(id);
        requireOpen(t);
        return write(t, { status: 'dropped', dropped_reason: reason ?? null });
      });
    },

    updateTask(id: string, edit: TaskEdit): Promise<Task> {
      return call(() => {
        const t = get(id);
        const patch: Partial<Task> = {};
        for (const key of Object.keys(edit)) {
          if (!EDITABLE.includes(key)) throw new ApiError('protected_column', 'Field is not editable', 403);
        }
        if (edit.title !== undefined) {
          const title = edit.title.trim();
          if (title.length === 0 || title.length > 60) {
            throw new ApiError('invalid_argument', 'Title must be 1 to 60 characters', 400);
          }
          patch.title = title;
        }
        if (edit.effort_min !== undefined) {
          if (!Number.isInteger(edit.effort_min) || edit.effort_min < 1 || edit.effort_min > 480) {
            throw new ApiError('invalid_argument', 'effort_min must be 1 to 480', 400);
          }
          patch.effort_min = edit.effort_min;
        }
        if (edit.kind !== undefined) patch.kind = edit.kind;
        if (edit.due_date !== undefined) patch.due_date = edit.due_date;
        if (edit.notes !== undefined) patch.notes = edit.notes;
        // The backend clears needs_review on any user edit (owner-approved rule).
        patch.needs_review = false;
        return write(t, patch, false);
      });
    },

    getProfile(): Promise<Profile> {
      return call(() => ({ ...profile }));
    },

    updateProfileTimes(input: ProfileTimesInput): Promise<Profile> {
      return call(() => {
        if (input.briefTime === undefined && input.checkinTime === undefined) {
          throw new ApiError('invalid_request', 'Nothing to update', 400);
        }
        if (input.briefTime !== undefined) assertClockTime(input.briefTime);
        if (input.checkinTime !== undefined) assertClockTime(input.checkinTime);
        profile = {
          ...profile,
          briefTime: input.briefTime ?? profile.briefTime,
          checkinTime: input.checkinTime ?? profile.checkinTime,
        };
        return { ...profile };
      });
    },

    getTask(id: string): Promise<TaskDetail> {
      return call(() => {
        const t = tasks.get(id);
        if (!t) throw new ApiError('not_found', 'Task not found', 404);
        return {
          ...t,
          transcript: t.capture_id ? (transcripts.get(t.capture_id) ?? null) : null,
          enrichments: (options.enrichments ?? mockEnrichments)(id),
        };
      });
    },

    recentlyDropped(): Promise<Task[]> {
      return call(() => {
        const since = now().getTime() - RECENTLY_DROPPED_MS;
        return [...tasks.values()]
          .filter((t) => t.status === 'dropped' && Date.parse(t.updated_at) >= since)
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
          .slice(0, RECENTLY_DROPPED_LIMIT)
          .map((t) => ({ ...t }));
      });
    },

    registerDevice(apnsToken: string): Promise<void> {
      return call(() => {
        if (!apnsToken) throw new ApiError('invalid_request', 'Missing APNs token', 400);
      });
    },

    exportData(): Promise<unknown> {
      return call(() => ({ tasks: [...tasks.values()].map((t) => ({ ...t })) }));
    },

    deleteAccount(appleAuthorizationCode: string): Promise<void> {
      // The mock's stand-in for "back to a fresh install": no tasks, default profile.
      return call(() => {
        if (!appleAuthorizationCode) {
          throw new ApiError('invalid_argument', 'Apple authorization code is required', 400);
        }
        tasks.clear();
        profile = defaultProfile();
        history.clear();
        touched.clear();
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      });
    },
  };
}
