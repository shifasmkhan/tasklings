import { useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from '@/api/ApiProvider';
import { isApiError } from '@/api/errors';
import type { Task, TaskEdit } from '@/api/types';
import { logEvent } from '@/lib/log';
import { useScreenReaderRef } from '@/lib/useScreenReader';
import { undoWindowMs, type Toast } from '@/features/today/useToday';
import { AUTOSAVE_DELAY_MS } from './logic';

type LoadState = 'loading' | 'ready' | 'missing' | 'error';
export type DetailAction = 'complete' | 'tomorrow' | 'drop';
/** What happened to the task from this screen, if anything. */
export type Outcome = DetailAction | null;

export const SAVE_ERROR = "Couldn't save that change. It was put back.";

function codeOf(err: unknown): string {
  return isApiError(err) ? err.code : 'unknown_error';
}

/**
 * State for Task detail (US-05). There is no get-task contract, so the task comes from
 * today_tasks(). Edits save on their own and revert on failure; actions share Today's undo rules.
 */
export function useTaskDetail(id: string) {
  const api = useApi();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [task, setTask] = useState<Task | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const screenReader = useScreenReaderRef();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastKey = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest values for flushing on blur and on leaving the screen.
  const latest = useRef({ task: null as Task | null, draft: '' });
  const mounted = useRef(true);

  const setTaskBoth = (next: Task | null) => {
    latest.current.task = next;
    setTask(next);
  };
  const setDraftBoth = (next: string) => {
    latest.current.draft = next;
    setDraftTitle(next);
  };

  const clearToastTimer = () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
  };
  const showToast = useCallback((message: string, undo: (() => void) | null) => {
    clearToastTimer();
    toastKey.current += 1;
    setToast({ key: toastKey.current, message, undo });
    toastTimer.current = setTimeout(() => setToast(null), undoWindowMs(screenReader.current));
  }, [screenReader]);
  const dismissToast = useCallback(() => {
    clearToastTimer();
    setToast(null);
  }, []);

  const fetchTask = useCallback(
    () =>
      api.todayTasks().then(
        (grouped) => {
          const found = [...grouped.quick, ...grouped.errand, ...grouped.project].find((t) => t.id === id);
          if (!mounted.current) return;
          if (!found) {
            setLoadState('missing');
            return;
          }
          setTaskBoth(found);
          setDraftBoth(found.title);
          setLoadState('ready');
        },
        (err: unknown) => {
          logEvent('task_detail.load_failed', { task_id: id, code: codeOf(err) });
          if (mounted.current) setLoadState('error');
        },
      ),
    [api, id],
  );

  const load = useCallback(() => {
    setLoadState('loading');
    return fetchTask();
  }, [fetchTask]);

  useEffect(() => {
    mounted.current = true;
    const live = latest.current;
    void fetchTask();
    return () => {
      mounted.current = false;
      clearToastTimer();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Leaving the screen with an unsaved title: save it rather than lose it. State is gone, so
      // this only sends the edit; a failure is logged and the stored title stays as it was.
      const { task: t, draft } = live;
      const title = draft.trim();
      if (t && title !== '' && title !== t.title) {
        api.updateTask(t.id, { title }).catch((err: unknown) => {
          logEvent('task_detail.save_failed', { task_id: t.id, code: codeOf(err) });
        });
      }
    };
  }, [api, fetchTask]);

  /** Applies an edit at once, sends it, and puts the old values back if it fails. */
  const save = useCallback(
    async (edit: TaskEdit): Promise<boolean> => {
      const before = latest.current.task;
      if (!before) return false;
      const previous: Record<string, unknown> = {};
      for (const key of Object.keys(edit)) previous[key] = before[key as keyof Task];
      setTaskBoth({ ...before, ...edit });
      setError(null);
      try {
        const updated = await api.updateTask(before.id, edit);
        if (!mounted.current) return true;
        // Take the server's row (it clears needs_review) but keep any newer title being typed.
        const current = latest.current.task;
        setTaskBoth(current ? { ...updated, title: 'title' in edit ? updated.title : current.title } : updated);
        logEvent('task_detail.saved', { task_id: before.id });
        return true;
      } catch (err) {
        logEvent('task_detail.save_failed', { task_id: before.id, code: codeOf(err) });
        if (!mounted.current) return false;
        const current = latest.current.task;
        if (current) setTaskBoth({ ...current, ...(previous as Partial<Task>) });
        if ('title' in edit) setDraftBoth(String(previous.title));
        setError(SAVE_ERROR);
        return false;
      }
    },
    [api],
  );

  const commitTitle = useCallback((): Promise<boolean> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const t = latest.current.task;
    if (!t) return Promise.resolve(true);
    const title = latest.current.draft.trim();
    if (title === t.title) return Promise.resolve(true);
    // An empty title can't be saved: quietly go back to the saved one.
    if (title === '') {
      setDraftBoth(t.title);
      return Promise.resolve(true);
    }
    return save({ title });
  }, [save]);

  const changeTitle = useCallback(
    (text: string) => {
      setDraftBoth(text);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void commitTitle(), AUTOSAVE_DELAY_MS);
    },
    [commitTitle],
  );

  const undo = useCallback(
    async (action: DetailAction) => {
      dismissToast();
      setBusy(true);
      try {
        const restored = await api.undoTask(id);
        setTaskBoth(restored);
        setDraftBoth(restored.title);
        setOutcome(null);
        logEvent('task.undo', { task_id: id, action });
      } catch (err) {
        logEvent('task.undo_failed', { task_id: id, code: codeOf(err) });
        showToast("Couldn't undo. Try again.", null);
      } finally {
        setBusy(false);
      }
    },
    [api, dismissToast, id, showToast],
  );

  const act = useCallback(
    async (action: DetailAction) => {
      const t = latest.current.task;
      if (!t || busy || outcome) return;
      // Save a title still being typed before the task leaves the open list.
      setBusy(true);
      try {
        if (saveTimer.current && !(await commitTitle())) {
          setBusy(false);
          return;
        }
        const updated =
          action === 'complete'
            ? await api.completeTask(t.id)
            : action === 'tomorrow'
              ? await api.deferTask(t.id)
              : await api.dropTask(t.id);
        setTaskBoth(updated);
        setOutcome(action);
        logEvent('task.action', { task_id: t.id, action });
        const message =
          action === 'complete' ? `Done: ${updated.title}` : action === 'tomorrow' ? 'Moved to tomorrow' : 'Dropped';
        showToast(message, () => void undo(action));
      } catch (err) {
        logEvent('task.action_failed', { task_id: t.id, action, code: codeOf(err) });
        showToast("Couldn't save that. Try again.", null);
      } finally {
        setBusy(false);
      }
    },
    [api, busy, commitTitle, outcome, showToast, undo],
  );

  return {
    loadState,
    reload: load,
    task,
    draftTitle,
    changeTitle,
    commitTitle: () => void commitTitle(),
    save,
    error,
    outcome,
    busy,
    toast,
    dismissToast,
    complete: () => act('complete'),
    tomorrow: () => act('tomorrow'),
    drop: () => act('drop'),
  };
}
