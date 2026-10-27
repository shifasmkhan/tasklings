import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '@/api/ApiProvider';
import { isApiError } from '@/api/errors';
import type { Task } from '@/api/types';
import { localIsoDate } from '@/lib/dates';
import { logEvent } from '@/lib/log';
import { groupTasks, pickStartHere, summarize } from './logic';

export const UNDO_WINDOW_MS = 5000;

export type TaskAction = 'complete' | 'tomorrow' | 'drop';

export interface Toast {
  key: number;
  message: string;
  /** Null for error toasts, which have nothing to undo. */
  undo: (() => void) | null;
}

type LoadState = 'loading' | 'ready' | 'error';

/**
 * State for the Today screen. Actions are optimistic: the row moves at once, the RPC runs,
 * and a failure puts it back. Every action offers Undo for 5 seconds (US-09), which calls undo_task.
 */
export function useToday(today: string = localIsoDate()) {
  const api = useApi();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [open, setOpen] = useState<Task[]>([]);
  // today_tasks() returns open tasks only, so Done today holds what was completed on this device today.
  const [done, setDone] = useState<Task[]>([]);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastKey = useRef(0);

  const clearToastTimer = () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
  };

  const showToast = useCallback((message: string, undo: (() => void) | null) => {
    clearToastTimer();
    toastKey.current += 1;
    setToast({ key: toastKey.current, message, undo });
    toastTimer.current = setTimeout(() => setToast(null), UNDO_WINDOW_MS);
  }, []);

  const dismissToast = useCallback(() => {
    clearToastTimer();
    setToast(null);
  }, []);

  useEffect(() => clearToastTimer, []);

  const fetchToday = useCallback(
    () =>
      api.todayTasks().then(
        (grouped) => {
          setOpen([...grouped.quick, ...grouped.errand, ...grouped.project]);
          setLoadState('ready');
        },
        (err: unknown) => {
          logEvent('today.load_failed', { code: isApiError(err) ? err.code : 'unknown_error' });
          setLoadState('error');
        },
      ),
    [api],
  );

  const load = useCallback(() => {
    setLoadState((s) => (s === 'error' ? 'loading' : s));
    return fetchToday();
  }, [fetchToday]);

  useEffect(() => {
    void fetchToday();
  }, [fetchToday]);

  // The RPC for each optimistic action, keyed by task id, resolving to whether it succeeded.
  // Undo waits for it so undo_task never reaches the server before the action it reverses.
  const inFlight = useRef(new Map<string, Promise<boolean>>());
  // Tasks the user undid while their action was still in flight.
  const undoneEarly = useRef(new Set<string>());

  const restoreOpen = (task: Task) => {
    const reopened: Task = { ...task, status: 'open', completed_at: null, dropped_reason: null };
    setDone((d) => d.filter((t) => t.id !== task.id));
    setOpen((o) => (o.some((t) => t.id === task.id) ? o : [...o, reopened]));
  };

  const undo = useCallback(
    async (task: Task, action: TaskAction | 'uncomplete') => {
      dismissToast();
      restoreOpen(task);
      const pending = inFlight.current.get(task.id);
      if (pending) {
        undoneEarly.current.add(task.id);
        const succeeded = await pending;
        undoneEarly.current.delete(task.id);
        // If the action itself failed, nothing changed on the server: there is nothing to undo.
        if (!succeeded) return;
      }
      try {
        const restored = await api.undoTask(task.id);
        setOpen((o) => o.map((t) => (t.id === restored.id ? restored : t)));
        logEvent('task.undo', { task_id: task.id, action });
      } catch (err) {
        logEvent('task.undo_failed', { task_id: task.id, code: isApiError(err) ? err.code : 'unknown_error' });
        // The server still has the action applied; reload so the list tells the truth.
        showToast("Couldn't undo. Try again.", null);
        void load();
      }
    },
    [api, dismissToast, load, showToast],
  );

  const act = useCallback(
    async (task: Task, action: TaskAction) => {
      setOpen((o) => o.filter((t) => t.id !== task.id));
      if (action === 'complete') {
        setDone((d) => [{ ...task, status: 'done' }, ...d.filter((t) => t.id !== task.id)]);
      }
      const message =
        action === 'complete' ? `Done: ${task.title}` : action === 'tomorrow' ? 'Moved to tomorrow' : 'Dropped';
      showToast(message, () => void undo(task, action));
      const run = (async () => {
        try {
          const updated =
            action === 'complete'
              ? await api.completeTask(task.id)
              : action === 'tomorrow'
                ? await api.deferTask(task.id)
                : await api.dropTask(task.id);
          if (action === 'complete') setDone((d) => d.map((t) => (t.id === updated.id ? updated : t)));
          logEvent('task.action', { task_id: task.id, action });
          return true;
        } catch (err) {
          logEvent('task.action_failed', { task_id: task.id, action, code: isApiError(err) ? err.code : 'unknown_error' });
          restoreOpen(task);
          // Already undone by the user: the list is right, so stay quiet.
          if (!undoneEarly.current.has(task.id)) showToast("Couldn't save that. Try again.", null);
          return false;
        }
      })();
      inFlight.current.set(task.id, run);
      await run;
      if (inFlight.current.get(task.id) === run) inFlight.current.delete(task.id);
    },
    [api, showToast, undo],
  );

  const uncomplete = useCallback((task: Task) => void undo(task, 'uncomplete'), [undo]);

  // Skip for now walks down the rule. After the last task it wraps to the top and keeps going.
  const skip = useCallback(
    (task: Task) => {
      setSkipped((s) => {
        const next = new Set([...s, task.id]);
        return open.every((t) => next.has(t.id)) ? new Set([task.id]) : next;
      });
    },
    [open],
  );

  const startHere = useMemo(() => pickStartHere(open, today, skipped), [open, today, skipped]);
  const groups = useMemo(() => groupTasks(open, startHere?.id ?? null), [open, startHere]);
  const summary = useMemo(() => summarize(open, done.length), [open, done.length]);

  return {
    loadState,
    reload: load,
    today,
    open,
    done,
    startHere,
    groups,
    summary,
    toast,
    dismissToast,
    complete: (t: Task) => act(t, 'complete'),
    tomorrow: (t: Task) => act(t, 'tomorrow'),
    drop: (t: Task) => act(t, 'drop'),
    uncomplete,
    skip,
  };
}
