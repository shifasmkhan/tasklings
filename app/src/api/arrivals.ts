import type { Task } from './types';

// process-capture answers 202 {capture_id} and the tasks arrive by realtime (PRD). Realtime isn't
// wired yet, so the app listens through this seam. The mock implements it with a short delay; the
// real implementation will subscribe to the user's captures and tasks channels (RLS applies).

export interface CaptureArrival {
  capture_id: string;
  /**
   * The tasks created for the capture. Empty: extraction found nothing to add (the capture is done
   * and no task exists). One task with needs_review: extraction fell back to the raw transcript.
   */
  tasks: Task[];
}

export interface CaptureArrivals {
  /** Calls `listener` once when the capture's result arrives. Returns an unsubscribe function. */
  subscribe(captureId: string, listener: (arrival: CaptureArrival) => void): () => void;
}

export function hasArrivals(client: unknown): client is { arrivals: CaptureArrivals } {
  return (
    typeof client === 'object' &&
    client !== null &&
    'arrivals' in client &&
    typeof (client as { arrivals?: { subscribe?: unknown } }).arrivals?.subscribe === 'function'
  );
}
