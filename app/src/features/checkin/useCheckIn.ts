import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApi } from '@/api/ApiProvider';
import { isApiError } from '@/api/errors';
import type { DroppedReason, Task } from '@/api/types';
import { localIsoDate } from '@/lib/dates';
import { logEvent } from '@/lib/log';
import { buildStack, type CheckInCounts } from './logic';

type LoadState = 'loading' | 'ready' | 'error';
export type CardAction = 'done' | 'tomorrow' | 'drop';

export const CHECKIN_SAVE_ERROR = "Couldn't save that. Try again.";

/**
 * State for the Evening check-in (US-07, US-12). The stack is built once from today_tasks() and
 * does not change while the user works through it. A card moves on only after its call succeeds.
 */
export function useCheckIn(today: string = localIsoDate()) {
  const api = useApi();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [cards, setCards] = useState<Task[]>([]);
  const [rolledOver, setRolledOver] = useState(0);
  const [index, setIndex] = useState(0);
  const [counts, setCounts] = useState<CheckInCounts>({ done: 0, tomorrow: 0, dropped: 0 });
  const [choosingDrop, setChoosingDrop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Blocks a second action (button then swipe) from starting while one is in flight.
  const working = useRef(false);

  const fetchStack = useCallback(
    () =>
      api.todayTasks().then(
        (grouped) => {
          const stack = buildStack([...grouped.quick, ...grouped.errand, ...grouped.project], today);
          setCards(stack.cards);
          setRolledOver(stack.rolledOver);
          setIndex(0);
          setCounts({ done: 0, tomorrow: 0, dropped: 0 });
          setLoadState('ready');
        },
        (err: unknown) => {
          logEvent('checkin.load_failed', { code: isApiError(err) ? err.code : 'unknown_error' });
          setLoadState('error');
        },
      ),
    [api, today],
  );

  const load = useCallback(() => {
    setLoadState('loading');
    return fetchStack();
  }, [fetchStack]);

  useEffect(() => {
    void fetchStack();
  }, [fetchStack]);

  const finished = loadState === 'ready' && index >= cards.length;
  const current = !finished && loadState === 'ready' ? (cards[index] ?? null) : null;

  const run = useCallback(
    async (action: CardAction, reason?: DroppedReason) => {
      const task = cards[index];
      if (!task || working.current) return;
      working.current = true;
      setBusy(true);
      setError(null);
      try {
        if (action === 'done') await api.completeTask(task.id);
        else if (action === 'tomorrow') await api.deferTask(task.id);
        else await api.dropTask(task.id, reason);
        logEvent('checkin.action', { task_id: task.id, action });
        setCounts((c) => ({
          done: c.done + (action === 'done' ? 1 : 0),
          tomorrow: c.tomorrow + (action === 'tomorrow' ? 1 : 0),
          dropped: c.dropped + (action === 'drop' ? 1 : 0),
        }));
        setChoosingDrop(false);
        setIndex((i) => i + 1);
      } catch (err) {
        logEvent('checkin.action_failed', { task_id: task.id, action, code: isApiError(err) ? err.code : 'unknown_error' });
        setError(CHECKIN_SAVE_ERROR);
      } finally {
        working.current = false;
        setBusy(false);
      }
    },
    [api, cards, index],
  );

  return useMemo(
    () => ({
      loadState,
      reload: load,
      cards,
      rolledOver,
      index,
      current,
      finished,
      counts,
      busy,
      error,
      choosingDrop,
      askDrop: () => {
        setError(null);
        setChoosingDrop(true);
      },
      cancelDrop: () => setChoosingDrop(false),
      done: () => run('done'),
      tomorrow: () => run('tomorrow'),
      drop: (reason: DroppedReason | null) => run('drop', reason ?? undefined),
    }),
    [loadState, load, cards, rolledOver, index, current, finished, counts, busy, error, choosingDrop, run],
  );
}
