import * as Crypto from 'expo-crypto';

import { hasArrivals, type CaptureArrival, type CaptureArrivals } from '@/api/arrivals';
import { CLIENT_ERROR_CODES, isApiError } from '@/api/errors';
import type { ApiClient, ProcessCaptureRequest, Task } from '@/api/types';
import { deviceTimeZone } from '@/lib/dates';
import { logEvent } from '@/lib/log';

/** Where the note came from. Client side only: process-capture has no source field (see PR notes). */
export type CaptureSource = 'voice' | 'text';

export type PendingStatus =
  /** The request is on its way. */
  | 'sending'
  /** The server has it (202); the tasks arrive by realtime. */
  | 'sorting'
  /** The request failed with a network error. Kept here and retried when the app returns to the foreground. */
  | 'queued'
  /** The server refused it. Kept so the note isn't lost; the row offers Try again. */
  | 'failed';

export interface PendingCapture {
  capture_id: string;
  source: CaptureSource;
  status: PendingStatus;
  /** Typed notes only: shown on Today straight away. User content: never log it. */
  text: string | null;
}

export interface CaptureResult {
  capture_id: string;
  source: CaptureSource;
  tasks: Task[];
}

export interface CaptureStoreDeps {
  api: ApiClient;
  arrivals: CaptureArrivals | null;
  /** A secure random UUID v4. Default: expo-crypto's platform CSPRNG. */
  newId?: () => string;
  now?: () => Date;
  timeZone?: () => string;
}

interface Entry {
  pending: PendingCapture;
  /** User content: kept in memory only, never logged. */
  request: ProcessCaptureRequest;
  unsubscribe: (() => void) | null;
  inFlight: boolean;
}

/**
 * Everything between "Save" and the tasks showing up on Today (US-01, US-02, US-03).
 *
 * Offline queue: a capture whose request fails with a network error stays here as `queued` and is
 * sent again by `retryQueued()`, which the provider calls when the app returns to the foreground.
 * The queue is IN MEMORY ONLY for now: closing the app loses queued notes. Persisting it comes
 * with the local SQLite store.
 */
export class CaptureStore {
  private readonly api: ApiClient;
  private readonly arrivals: CaptureArrivals | null;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly timeZone: () => string;
  private readonly entries = new Map<string, Entry>();
  private snapshot: readonly PendingCapture[] = [];
  private readonly changeListeners = new Set<() => void>();
  private readonly resultListeners = new Set<(result: CaptureResult) => void>();
  // Results that arrived while no screen was listening (for example the user was on a task page).
  private unseen: CaptureResult[] = [];

  constructor(deps: CaptureStoreDeps) {
    this.api = deps.api;
    this.arrivals = deps.arrivals ?? (hasArrivals(deps.api) ? deps.api.arrivals : null);
    this.newId = deps.newId ?? (() => Crypto.randomUUID());
    this.now = deps.now ?? (() => new Date());
    this.timeZone = deps.timeZone ?? deviceTimeZone;
  }

  /**
   * Starts a capture and returns at once with its client-generated id; the caller can close the
   * sheet. captured_at and the device's IANA time zone are taken now, so a queued capture keeps
   * the moment it was made.
   */
  submit(input: { source: CaptureSource; transcript: string }): string {
    const transcript = input.transcript.trim();
    const capture_id = this.newId();
    const request: ProcessCaptureRequest = {
      capture_id,
      transcript,
      captured_at: this.now().toISOString(),
      timezone: this.timeZone(),
    };
    this.entries.set(capture_id, {
      pending: { capture_id, source: input.source, status: 'sending', text: input.source === 'text' ? transcript : null },
      request,
      unsubscribe: null,
      inFlight: false,
    });
    this.publish();
    void this.send(capture_id);
    return capture_id;
  }

  /** Sends every queued capture again. Called when the app returns to the foreground. */
  async retryQueued(): Promise<void> {
    const ids = [...this.entries.values()].filter((e) => e.pending.status === 'queued').map((e) => e.pending.capture_id);
    await Promise.all(ids.map((id) => this.send(id)));
  }

  /** Try again for a failed capture (the row's button). */
  retry(captureId: string): Promise<void> {
    const entry = this.entries.get(captureId);
    return entry && (entry.pending.status === 'failed' || entry.pending.status === 'queued') ? this.send(captureId) : Promise.resolve();
  }

  getPending = (): readonly PendingCapture[] => this.snapshot;

  /** For useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  };

  /** Listens for results. Anything that arrived while nobody listened is delivered first. */
  onResult(listener: (result: CaptureResult) => void): () => void {
    this.resultListeners.add(listener);
    const missed = this.unseen;
    this.unseen = [];
    for (const result of missed) listener(result);
    return () => {
      this.resultListeners.delete(listener);
    };
  }

  /** Stops listening for every capture. */
  dispose(): void {
    for (const entry of this.entries.values()) entry.unsubscribe?.();
    this.entries.clear();
    this.publish();
  }

  private async send(captureId: string): Promise<void> {
    const entry = this.entries.get(captureId);
    if (!entry || entry.inFlight) return;
    entry.inFlight = true;
    this.setStatus(captureId, 'sending');
    // Listen before asking, so a result that comes back quickly can't be missed.
    if (!entry.unsubscribe && this.arrivals) {
      entry.unsubscribe = this.arrivals.subscribe(captureId, (arrival) => this.onArrival(entry, arrival));
    }
    try {
      await this.api.processCapture(entry.request);
      this.setStatus(captureId, 'sorting');
    } catch (err) {
      const code = isApiError(err) ? err.code : CLIENT_ERROR_CODES.unknown;
      if (code === CLIENT_ERROR_CODES.network) {
        logEvent('capture.queued', { capture_id: captureId });
        this.setStatus(captureId, 'queued');
      } else {
        logEvent('capture.failed', { capture_id: captureId, code });
        entry.unsubscribe?.();
        entry.unsubscribe = null;
        this.setStatus(captureId, 'failed');
      }
    } finally {
      entry.inFlight = false;
    }
  }

  private onArrival(entry: Entry, arrival: CaptureArrival): void {
    const { capture_id, source } = entry.pending;
    if (!this.entries.has(capture_id)) return;
    entry.unsubscribe?.();
    this.entries.delete(capture_id);
    this.publish();
    logEvent('capture.result', { capture_id, count: arrival.tasks.length });
    const result: CaptureResult = { capture_id, source, tasks: arrival.tasks };
    if (this.resultListeners.size === 0) this.unseen.push(result);
    else for (const listener of [...this.resultListeners]) listener(result);
  }

  private setStatus(captureId: string, status: PendingStatus): void {
    const entry = this.entries.get(captureId);
    // The result can beat the 202 back; then the entry is already gone.
    if (!entry || entry.pending.status === status) return;
    entry.pending = { ...entry.pending, status };
    this.publish();
  }

  private publish(): void {
    this.snapshot = [...this.entries.values()].map((e) => e.pending);
    for (const listener of [...this.changeListeners]) listener();
  }
}
