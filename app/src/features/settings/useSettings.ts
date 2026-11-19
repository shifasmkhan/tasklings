import { useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from '@/api/ApiProvider';
import { ApiError } from '@/api/errors';
import type { Profile, SignInMethod, Task } from '@/api/types';
import { logEvent } from '@/lib/log';
import { useScreenReaderRef } from '@/lib/useScreenReader';
import { undoWindowMs, type Toast } from '@/features/today/useToday';
import type { AppleCredential, AppleCredentialSource } from '@/features/auth/appleCredential';
import type { ExportSharer } from './exportShare';
import {
  APPLE_ONLY_COPY,
  codeOf,
  dataErrorMessage,
  EXPORT_DONE,
  RESTORE_ERROR,
  RESTORED_MESSAGE,
  TIME_SAVE_ERROR,
  type DataAction,
  type TimeKind,
} from './logic';

type LoadState = 'loading' | 'ready' | 'error';

export interface SettingsDeps {
  credentialSource: AppleCredentialSource;
  shareExport: ExportSharer;
  /** Called once the account is deleted and the session is cleared. */
  onAccountDeleted: () => void;
}

/**
 * State for Settings (US-11) and Recently dropped (US-09). Time changes save at once: the new
 * value shows immediately and is put back, with an inline error, if the save fails. Saves go one
 * at a time; while one is in flight only the newest change per field waits behind it.
 */
export function useSettings({ credentialSource, shareExport, onAccountDeleted }: SettingsDeps) {
  const api = useApi();
  const mounted = useRef(true);
  const screenReader = useScreenReaderRef();

  const [profileState, setProfileState] = useState<LoadState>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  // The last value the server confirmed, per field: where a failed save goes back to.
  const confirmed = useRef<Profile | null>(null);
  const saving = useRef(false);
  const queued = useRef<Partial<Record<TimeKind, string>>>({});

  const [droppedState, setDroppedState] = useState<LoadState>('loading');
  const [dropped, setDropped] = useState<Task[]>([]);
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(new Set());

  // How the session was made: null when signed out. Undefined until it is read.
  const [method, setMethod] = useState<SignInMethod | null | undefined>(undefined);

  const [toast, setToast] = useState<Toast | null>(null);
  const toastKey = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [working, setWorking] = useState<DataAction | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);

  const showToast = useCallback(
    (message: string) => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastKey.current += 1;
      setToast({ key: toastKey.current, message, undo: null });
      toastTimer.current = setTimeout(() => setToast(null), undoWindowMs(screenReader.current));
    },
    [screenReader],
  );
  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  const fetchProfile = useCallback(
    () =>
      api.getProfile().then(
        (p) => {
          if (!mounted.current) return;
          confirmed.current = p;
          setProfile(p);
          setProfileState('ready');
        },
        (err: unknown) => {
          logEvent('settings.profile_load_failed', { code: codeOf(err) });
          if (mounted.current) setProfileState('error');
        },
      ),
    [api],
  );

  const fetchDropped = useCallback(
    () =>
      api.recentlyDropped().then(
        (rows) => {
          if (!mounted.current) return;
          setDropped(rows);
          setDroppedState('ready');
        },
        (err: unknown) => {
          logEvent('settings.dropped_load_failed', { code: codeOf(err) });
          if (mounted.current) setDroppedState('error');
        },
      ),
    [api],
  );

  const fetchMethod = useCallback(
    () =>
      api.signInMethod().then(
        (m) => {
          if (mounted.current) setMethod(m);
        },
        () => {
          // Unknown: keep the Apple path; the server still decides.
          if (mounted.current) setMethod(undefined);
        },
      ),
    [api],
  );

  /** Reloads everything that depends on who is signed in (after the dev sign-in screen closes). */
  const reloadAll = useCallback(() => {
    void fetchMethod();
    void fetchProfile();
    void fetchDropped();
  }, [fetchMethod, fetchProfile, fetchDropped]);

  const reloadProfile = useCallback(() => {
    setProfileState('loading');
    return fetchProfile();
  }, [fetchProfile]);
  const reloadDropped = useCallback(() => {
    setDroppedState('loading');
    return fetchDropped();
  }, [fetchDropped]);

  useEffect(() => {
    mounted.current = true;
    void fetchProfile();
    void fetchDropped();
    void fetchMethod();
    return () => {
      mounted.current = false;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [fetchProfile, fetchDropped, fetchMethod]);

  const flushTimes = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      while (Object.keys(queued.current).length > 0) {
        const batch = queued.current;
        queued.current = {};
        try {
          const saved = await api.updateProfileTimes(batch);
          if (!mounted.current) return;
          confirmed.current = saved;
          // Keep anything the person changed again while this save was in flight.
          setProfile((cur) => {
            if (!cur) return saved;
            const next = { ...saved };
            for (const key of Object.keys(queued.current) as TimeKind[]) next[key] = cur[key];
            return next;
          });
          setTimeError(null);
          logEvent('settings.times_saved', {});
        } catch (err) {
          logEvent('settings.times_save_failed', { code: codeOf(err) });
          if (!mounted.current) return;
          const back = confirmed.current;
          // Put back only the fields this batch changed, and drop later queued edits of them.
          setProfile((cur) => {
            if (!cur || !back) return cur;
            const next = { ...cur };
            for (const key of Object.keys(batch) as TimeKind[]) next[key] = back[key];
            return next;
          });
          for (const key of Object.keys(batch) as TimeKind[]) delete queued.current[key];
          setTimeError(TIME_SAVE_ERROR);
        }
      }
    } finally {
      saving.current = false;
    }
  }, [api]);

  const changeTime = useCallback(
    (kind: TimeKind, hhmm: string) => {
      setProfile((cur) => (cur ? { ...cur, [kind]: hhmm } : cur));
      setTimeError(null);
      queued.current = { ...queued.current, [kind]: hhmm };
      void flushTimes();
    },
    [flushTimes],
  );

  const restore = useCallback(
    async (id: string) => {
      if (restoring.has(id)) return;
      setRestoring((s) => new Set(s).add(id));
      try {
        await api.undoTask(id);
        logEvent('settings.restored', { task_id: id });
        if (!mounted.current) return;
        setDropped((rows) => rows.filter((t) => t.id !== id));
        showToast(RESTORED_MESSAGE);
      } catch (err) {
        logEvent('settings.restore_failed', { task_id: id, code: codeOf(err) });
        if (mounted.current) showToast(RESTORE_ERROR);
      } finally {
        if (mounted.current) {
          setRestoring((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          });
        }
      }
    },
    [api, restoring, showToast],
  );

  /** Fresh Sign in with Apple first (the server needs a session under 5 minutes old), then the call. */
  const withFreshSignIn = useCallback(
    async (action: DataAction, run: (credential: AppleCredential) => Promise<void>) => {
      if (working) return;
      setWorking(action);
      setDataError(null);
      setDataMessage(null);
      try {
        // An email-code session (owner-only dev sign-in) is not Sign in with Apple, and starting the
        // Apple flow here would replace it with a different account. Say so and stop.
        if ((await api.signInMethod()) === 'email') {
          if (mounted.current) {
            setMethod('email');
            setDataError(APPLE_ONLY_COPY);
          }
          return;
        }
        const credential = await credentialSource();
        await api.signInWithApple(credential.identityToken, credential.rawNonce);
        await run(credential);
      } catch (err) {
        logEvent(`settings.${action}_failed`, { code: codeOf(err) });
        if (mounted.current) setDataError(codeOf(err) === 'reauth_required' && method === 'email' ? APPLE_ONLY_COPY : dataErrorMessage(err));
      } finally {
        if (mounted.current) setWorking(null);
      }
    },
    [api, credentialSource, method, working],
  );

  const exportMyData = useCallback(
    () =>
      withFreshSignIn('export', async () => {
        const data = await api.exportData();
        const json = JSON.stringify(data, null, 2);
        const shared = await shareExport(json);
        logEvent('settings.export_done', { status: shared ? 'shared' : 'dismissed' });
        if (mounted.current && shared) setDataMessage(EXPORT_DONE);
      }),
    [api, shareExport, withFreshSignIn],
  );

  const askDelete = useCallback(() => {
    setDataError(null);
    setDataMessage(null);
    setConfirmingDelete(true);
  }, []);
  const cancelDelete = useCallback(() => setConfirmingDelete(false), []);

  const confirmDelete = useCallback(async () => {
    setConfirmingDelete(false);
    await withFreshSignIn('delete', async (credential) => {
      // The code from this same sign-in lets the server revoke it with Apple. Without one the
      // account can't be deleted properly, so say sign-in isn't set up instead of guessing.
      if (!credential.authorizationCode) throw new ApiError('unauthenticated', 'No authorization code');
      await api.deleteAccount(credential.authorizationCode);
      logEvent('settings.account_deleted', {});
      onAccountDeleted();
    });
  }, [api, onAccountDeleted, withFreshSignIn]);

  return {
    signInMethod: method,
    reloadAll,
    profileState,
    profile,
    timeError,
    changeTime,
    reloadProfile,
    droppedState,
    dropped,
    restoring,
    restore,
    reloadDropped,
    toast,
    dismissToast,
    working,
    dataMessage,
    dataError,
    exportMyData,
    confirmingDelete,
    askDelete,
    cancelDelete,
    confirmDelete,
  };
}
