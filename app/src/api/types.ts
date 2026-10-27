// Types mirror the Phase 0 data model and API contracts in the PRD.
// Do not add fields here that the PRD does not define.

export type TaskKind = 'quick' | 'errand' | 'project';
export type TaskStatus = 'open' | 'done' | 'dropped';
export type DroppedReason = 'not_needed' | 'done_elsewhere' | 'obsolete';

/** ISO calendar date, YYYY-MM-DD. */
export type IsoDate = string;
/** ISO timestamp with offset. */
export type IsoTimestamp = string;

export interface Task {
  id: string;
  user_id: string;
  capture_id: string | null;
  /** Imperative, 60 characters or fewer. User content: never log it. */
  title: string;
  /** User content: never log it. */
  notes: string | null;
  kind: TaskKind;
  effort_min: number;
  /** The AI's original estimate; never user-editable. */
  effort_min_initial: number;
  due_date: IsoDate | null;
  status: TaskStatus;
  first_planned_for: IsoDate;
  planned_for: IsoDate;
  carry_count: number;
  completed_at: IsoTimestamp | null;
  dropped_reason: DroppedReason | null;
  script: string | null;
  /**
   * True when extraction failed twice and the whole transcript was saved as one task. The backend
   * clears it when the user edits the task. Owner-approved addition; pending a PRD update.
   */
  needs_review: boolean;
  sort_order: number;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** today_tasks(): open tasks planned today or earlier, grouped by kind. */
export type TodayTasks = Record<TaskKind, Task[]>;

/** Task edits (table update): the only user-editable columns. */
export const TASK_EDITABLE_FIELDS = ['title', 'kind', 'effort_min', 'due_date', 'notes'] as const;
export type TaskEdit = Partial<Pick<Task, (typeof TASK_EDITABLE_FIELDS)[number]>>;

export interface Session {
  access_token: string;
  user_id: string;
  /** Unix seconds. */
  expires_at: number;
}

export interface ProcessCaptureRequest {
  capture_id: string;
  transcript: string;
  captured_at: IsoTimestamp;
  /** IANA time zone, e.g. America/Chicago. */
  timezone: string;
}

export interface ProcessCaptureResponse {
  capture_id: string;
}

/**
 * The boundary between the app and the backend. Every Phase 0 contract is one method.
 * Implementations: mock (in-memory synthetic data) and supabase (thin HTTP client).
 * Every method rejects with ApiError on failure.
 */
export interface ApiClient {
  /**
   * Sign in: Supabase Auth with an Apple identity token. `rawNonce` is the unhashed nonce whose
   * SHA-256 hex was sent to Apple (see lib/nonce.ts); Supabase checks it against the token.
   */
  signInWithApple(identityToken: string, rawNonce: string): Promise<Session>;
  /** process-capture edge function: 202 {capture_id}; tasks arrive by realtime. */
  processCapture(request: ProcessCaptureRequest): Promise<ProcessCaptureResponse>;
  /** today_tasks() RPC. */
  todayTasks(): Promise<TodayTasks>;
  /** complete_task(id) RPC. */
  completeTask(id: string): Promise<Task>;
  /** undo_task(id) RPC. */
  undoTask(id: string): Promise<Task>;
  /** defer_task(id) RPC: planned_for becomes tomorrow. */
  deferTask(id: string): Promise<Task>;
  /** drop_task(id, reason) RPC. */
  dropTask(id: string, reason?: DroppedReason): Promise<Task>;
  /** Task edits: table update of title, kind, effort_min, due_date, notes. */
  updateTask(id: string, edit: TaskEdit): Promise<Task>;
  /** register-device edge function: 204. */
  registerDevice(apnsToken: string): Promise<void>;
  /** export-data edge function: JSON file. Needs a session under 5 minutes old. */
  exportData(): Promise<unknown>;
  /** delete-account edge function: 204. Needs a session under 5 minutes old. */
  deleteAccount(): Promise<void>;
}
