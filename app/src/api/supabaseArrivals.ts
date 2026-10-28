import type { SupabaseClient } from '@supabase/supabase-js';

import type { CaptureArrival, CaptureArrivals } from './arrivals';
import type { Task } from './types';
import { logEvent } from '@/lib/log';

// CaptureArrivals over Supabase realtime. process-capture answers 202 and works in the background;
// the app hears about the result from the user's own captures row. Realtime postgres_changes apply
// the subscriber's row-level security, so another user's capture id yields no events at all.
//
// Flow per capture: subscribe to changes of captures.id = <id>; when the status becomes `done`,
// read the capture's tasks and deliver them once. The read (not the event stream) is the source of
// truth for the task list, so a dropped or reordered event can't lose a task. Every time the channel
// (re)joins, the status is read once too, so a capture that finished before the subscription was
// live, or while the connection was down, is still delivered.
//
// `failed` is not delivered: CaptureArrival has no failure, and the capture store already offers
// Try again when no result arrives within 60 seconds.

/** The columns of the Task type, in one place so a new column on the table can't leak in by `select *`. */
export const TASK_COLUMNS =
  'id,user_id,capture_id,title,notes,kind,effort_min,effort_min_initial,due_date,status,' +
  'first_planned_for,planned_for,carry_count,completed_at,dropped_reason,script,needs_review,' +
  'sort_order,created_at,updated_at';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSupabaseArrivals(client: SupabaseClient): CaptureArrivals {
  return {
    subscribe(captureId, listener) {
      // The id goes into a realtime filter string, so it must be exactly a UUID.
      if (!UUID.test(captureId)) {
        logEvent('capture.realtime_bad_id', {});
        return () => {};
      }
      let finished = false;
      let reading = false;

      const channel = client.channel(`capture-${captureId}`);

      async function deliver(): Promise<void> {
        if (finished || reading) return;
        reading = true;
        try {
          const { data, error } = await client
            .from('tasks')
            .select(TASK_COLUMNS)
            .eq('capture_id', captureId)
            .order('sort_order', { ascending: true });
          if (error || !Array.isArray(data)) {
            logEvent('capture.tasks_read_failed', { capture_id: captureId, code: error?.code || 'bad_response' });
            return; // the next rejoin, or Try again, reads again
          }
          if (finished) return;
          finished = true;
          stop();
          const arrival: CaptureArrival = { capture_id: captureId, tasks: data as unknown as Task[] };
          listener(arrival);
        } finally {
          reading = false;
        }
      }

      async function catchUp(): Promise<void> {
        if (finished) return;
        const { data, error } = await client.from('captures').select('status').eq('id', captureId).maybeSingle();
        if (error) {
          logEvent('capture.status_read_failed', { capture_id: captureId, code: error.code || 'unknown_error' });
          return;
        }
        if (data?.status === 'done') await deliver();
      }

      function stop(): void {
        void client.removeChannel(channel);
      }

      channel
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'captures', filter: `id=eq.${captureId}` },
          (payload) => {
            const row = payload.new as { status?: unknown } | undefined;
            if (row?.status === 'done') void deliver();
          },
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') void catchUp();
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            // supabase-js rejoins by itself; the catch-up runs again when it does.
            logEvent('capture.realtime_error', { capture_id: captureId, code: status });
          }
        });

      return () => {
        if (finished) return;
        finished = true;
        stop();
      };
    },
  };
}
