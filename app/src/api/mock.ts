import { ApiError } from './errors';
import { MOCK_USER_ID, seedTasks } from './fixtures';
import type {
  ApiClient,
  DroppedReason,
  IsoDate,
  ProcessCaptureRequest,
  ProcessCaptureResponse,
  Session,
  Task,
  TaskEdit,
  TodayTasks,
} from './types';
import { TASK_EDITABLE_FIELDS } from './types';
import { addDays, localIsoDate } from '@/lib/dates';

export interface MockApiOptions {
  /** Starting tasks. Defaults to the synthetic seed set. */
  tasks?: Task[];
  /** Returns today's date in the user's time zone. Defaults to the device date. */
  today?: () => IsoDate;
  /** Clock for completed_at and updated_at. */
  now?: () => Date;
  /** Artificial latency in ms. */
  latencyMs?: number;
}

export interface MockApiClient extends ApiClient {
  /** Test hook: the next call rejects with this standard error. */
  failNext(code: string, message?: string): void;
  /** Test hook: a copy of every stored task. */
  snapshot(): Task[];
}

const EDITABLE: readonly string[] = TASK_EDITABLE_FIELDS;

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
    const updated: Task = { ...prev, ...next, updated_at: now().toISOString() };
    tasks.set(updated.id, updated);
    return { ...updated };
  }

  function requireOpen(t: Task): void {
    if (t.status !== 'open') throw new ApiError('invalid_state', 'Task is not open', 409);
  }

  return {
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

    registerDevice(apnsToken: string): Promise<void> {
      return call(() => {
        if (!apnsToken) throw new ApiError('invalid_request', 'Missing APNs token', 400);
      });
    },

    exportData(): Promise<unknown> {
      return call(() => ({ tasks: [...tasks.values()].map((t) => ({ ...t })) }));
    },

    deleteAccount(): Promise<void> {
      return call(() => {
        tasks.clear();
        history.clear();
      });
    },
  };
}
