import { useEffect, useRef } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { IsoDate, Task } from '@/api/types';
import type { PendingCapture } from '@/features/capture/captureStore';
import { CheckIcon, MicIcon } from '@/components/icons';
import { MIN_TOUCH, usePalette } from '@/theme/colors';
import { completionHaptic } from './haptics';
import {
  formatMinutes,
  GROUP_LABELS,
  isDueByToday,
  NEEDS_REVIEW_CARD_TEXT,
  NEEDS_REVIEW_LABEL,
  plural,
  taskMeta, type TodaySummary,
} from './logic';
import type { Toast } from './useToday';

/**
 * Passive card for a task saved as a single note. It is a plain tappable card: no prompt, modal
 * or push, and it asks nothing. Tapping opens the Task detail placeholder.
 */
export function ReviewCard({ task, onOpen }: { task: Task; onOpen: (task: Task) => void }) {
  const p = usePalette();
  return (
    <Pressable
      role="button"
      aria-label={NEEDS_REVIEW_CARD_TEXT}
      accessibilityHint="Opens task details"
      onPress={() => onOpen(task)}
      style={[styles.card, styles.review, { backgroundColor: p.card }]}
    >
      <Text style={[styles.secondary15, { color: p.text }]}>{NEEDS_REVIEW_CARD_TEXT}</Text>
    </Pressable>
  );
}

export const SORTING_LABEL = 'Sorting your note…';
export const QUEUED_LABEL = 'Saved on this device';
export const QUEUED_DETAIL = 'We’ll sort it when you’re back online.';
export const FAILED_LABEL = 'Couldn’t sort your note';

/**
 * A capture that hasn't turned into tasks yet (US-03). A typed note shows its text straight away,
 * even when the request is queued offline.
 */
export function PendingRow({ capture, onRetry }: { capture: PendingCapture; onRetry: (id: string) => void }) {
  const p = usePalette();
  const queued = capture.status === 'queued';
  const failed = capture.status === 'failed';
  const label = failed ? FAILED_LABEL : queued ? QUEUED_LABEL : SORTING_LABEL;
  return (
    <View
      role="status"
      aria-live="polite"
      accessible
      aria-label={[label, queued ? QUEUED_DETAIL : null, capture.text].filter(Boolean).join('. ')}
      style={[styles.card, styles.pending, { backgroundColor: p.card }]}
    >
      {failed || queued ? null : <ActivityIndicator color={p.accent} accessibilityElementsHidden />}
      <View style={styles.pendingText}>
        <Text style={[styles.pendingTitle, { color: p.text }]}>{label}</Text>
        {queued ? <Text style={[styles.secondary15, { color: p.secondaryText }]}>{QUEUED_DETAIL}</Text> : null}
        {capture.text ? (
          <Text numberOfLines={2} style={[styles.secondary15, { color: p.secondaryText }]}>
            {capture.text}
          </Text>
        ) : null}
      </View>
      {failed ? (
        <Pressable role="button" aria-label="Try again" onPress={() => onRetry(capture.capture_id)} style={styles.toastButton}>
          <Text style={[styles.toastAction, { color: p.accent }]}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function SummaryCard({ summary }: { summary: TodaySummary }) {
  const p = usePalette();
  const pct = Math.round(summary.progress * 100);
  const allDone = summary.left === 0;
  return (
    <View role="summary" aria-label="Today summary" style={[styles.card, styles.summary, { backgroundColor: p.card }]}>
      <View style={styles.gap4}>
        <Text style={[styles.summaryTitle, { color: p.text }]}>
          {allDone ? 'All done for today' : plural(summary.left, 'task left', 'tasks left')}
        </Text>
        <Text style={[styles.secondary15, { color: p.secondaryText }]}>
          {allDone ? 'Nice work. Enjoy your evening.' : `About ${formatMinutes(summary.totalMinutes)}`}
        </Text>
      </View>
      <View
        accessible
        role="progressbar"
        aria-label="Today's progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${summary.done} of ${summary.done + summary.left} done`}
        style={[styles.track, { backgroundColor: p.track }]}
      >
        <View testID="progress-fill" style={[styles.fill, { backgroundColor: p.accent, width: `${pct}%` }]} />
      </View>
      <View style={styles.chips}>
        <Chip label={`${summary.counts.quick} quick`} />
        <Chip label={plural(summary.counts.errand, 'errand', 'errands')} />
        <Chip label={`${summary.counts.project} bigger`} />
      </View>
    </View>
  );
}

function Chip({ label }: { label: string }) {
  const p = usePalette();
  return (
    <View style={[styles.chip, { backgroundColor: p.fill }]}>
      <Text style={[styles.chipText, { color: p.text }]}>{label}</Text>
    </View>
  );
}

interface StartHereProps {
  task: Task;
  today: IsoDate;
  onDone: (task: Task) => void;
  onSkip: (task: Task) => void;
  onOpen: (task: Task) => void;
}

export function StartHereCard({ task, today, onDone, onSkip, onOpen }: StartHereProps) {
  const p = usePalette();
  const reason = isDueByToday(task, today)
    ? 'Due today'
    : task.carry_count > 0
      ? `Day ${task.carry_count + 1}`
      : null;
  const eyebrow = ['Start here', GROUP_LABELS[task.kind].startLabel, reason].filter(Boolean).join(' · ');
  return (
    <View
      role="region"
      aria-label="Start here"
      style={[styles.card, styles.start, { backgroundColor: p.card, borderColor: p.accent }]}
    >
      <Text style={[styles.eyebrow, { color: p.accent }]}>{eyebrow.toUpperCase()}</Text>
      <Pressable
        role="button"
        aria-label={[task.title, taskMeta(task, today), task.needs_review ? NEEDS_REVIEW_LABEL : null].filter(Boolean).join(', ')}
        accessibilityHint="Opens task details"
        onPress={() => onOpen(task)}
        style={styles.gap4}
      >
        <Text style={[styles.startTitle, { color: p.text }]}>{task.title}</Text>
        <Text style={[styles.secondary15, { color: p.secondaryText }]}>
          {[taskMeta(task, today), task.needs_review ? NEEDS_REVIEW_LABEL : null].filter(Boolean).join(' · ')}
        </Text>
      </Pressable>
      <View style={styles.startButtons}>
        <Pressable
          role="button"
          aria-label={`Done: ${task.title}`}
          onPress={() => {
            completionHaptic();
            onDone(task);
          }}
          style={({ pressed }) => [styles.bigButton, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={[styles.bigButtonText, { color: p.onAccent }]}>Done</Text>
        </Pressable>
        <Pressable
          role="button"
          aria-label="Skip for now"
          accessibilityHint="Shows a different task here"
          onPress={() => onSkip(task)}
          style={({ pressed }) => [styles.bigButton, { backgroundColor: p.fill, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={[styles.bigButtonText, styles.regular, { color: p.text }]}>Skip for now</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function GroupHeader({ title, subtitle }: { title: string; subtitle: string }) {
  const p = usePalette();
  return (
    <View style={styles.groupHeader}>
      <Text role="heading" style={[styles.groupTitle, { color: p.secondaryText }]}>
        {title.toUpperCase()}
      </Text>
      <Text style={[styles.groupSub, { color: p.secondaryText }]}>{subtitle}</Text>
    </View>
  );
}

export function AllDone() {
  const p = usePalette();
  return (
    <View style={[styles.card, styles.allDone, { backgroundColor: p.card }]}>
      <View style={[styles.allDoneBadge, { backgroundColor: p.accent }]}>
        <CheckIcon color={p.onAccent} size={26} />
      </View>
      <Text role="heading" style={[styles.allDoneTitle, { color: p.text }]}>
        All done for today
      </Text>
      <Text style={[styles.secondary15, styles.center, { color: p.secondaryText }]}>
        Nice work. Anything new can wait for tomorrow&apos;s brief.
      </Text>
    </View>
  );
}

interface DoneTodayProps {
  tasks: Task[];
  expanded: boolean;
  onToggle: () => void;
  onUncomplete: (task: Task) => void;
}

export function DoneToday({ tasks, expanded, onToggle, onUncomplete }: DoneTodayProps) {
  const p = usePalette();
  return (
    <View style={styles.gap8}>
      <Pressable
        role="button"
        aria-label={`Done today, ${tasks.length}`}
        aria-expanded={expanded}
        onPress={onToggle}
        style={styles.doneHeader}
      >
        <Text style={[styles.groupTitle, { color: p.secondaryText }]}>{`DONE TODAY (${tasks.length})`}</Text>
        <Text style={[styles.secondary15, { color: p.accent }]}>{expanded ? 'Hide' : 'Show'}</Text>
      </Pressable>
      {expanded ? (
        <View style={[styles.listCard, { backgroundColor: p.card }]}>
          {tasks.map((t, i) => (
            <View
              key={t.id}
              style={[
                styles.doneRow,
                i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.separator } : null,
              ]}
            >
              <Pressable
                role="button"
                aria-label={`Mark not done: ${t.title}`}
                onPress={() => onUncomplete(t)}
                style={styles.circleHit}
              >
                <View style={[styles.doneCircle, { backgroundColor: p.accent }]}>
                  <CheckIcon color={p.onAccent} size={10} />
                </View>
              </Pressable>
              <Text style={[styles.doneTitle, { color: p.secondaryText }]}>{t.title}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function UndoToast({ toast, onUndo, bottom }: { toast: Toast; onUndo: () => void; bottom: number }) {
  const p = usePalette();
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (announced.current !== toast.key) {
      announced.current = toast.key;
      AccessibilityInfo.announceForAccessibility(toast.undo ? `${toast.message}. Undo available.` : toast.message);
    }
  }, [toast]);
  return (
    <View
      role="status"
      aria-live="polite"
      style={[styles.toast, { backgroundColor: p.toastBackground, bottom }]}
    >
      <Text numberOfLines={2} style={[styles.toastText, { color: p.toastText }]}>
        {toast.message}
      </Text>
      {toast.undo ? (
        <Pressable role="button" aria-label="Undo" onPress={onUndo} style={styles.toastButton}>
          <Text style={[styles.toastAction, { color: p.toastAction }]}>Undo</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function MicBar({
  onPress,
  bottomInset,
  onHeight,
}: {
  onPress: () => void;
  bottomInset: number;
  /** Reports the bar's height, which grows with Dynamic Type, so content can clear it. */
  onHeight?: (height: number) => void;
}) {
  const p = usePalette();
  return (
    <View
      onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
      style={[
        styles.micBar,
        { backgroundColor: p.barBackground, borderTopColor: p.separator, paddingBottom: Math.max(bottomInset, 12) },
      ]}
    >
      <Pressable
        role="button"
        aria-label="Hold to talk, or tap to lock recording"
        accessibilityHint="Opens capture"
        onPress={onPress}
        onLongPress={onPress}
        style={({ pressed }) => [styles.mic, { backgroundColor: p.accent, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
      >
        <MicIcon color={p.onAccent} />
      </Pressable>
      {/* The button's label already says this; hide the duplicate from VoiceOver. */}
      <Text style={[styles.micLabel, { color: p.secondaryText }]} aria-hidden>
        Hold to talk · tap to lock
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, padding: 16 },
  listCard: { borderRadius: 14, overflow: 'hidden' },
  summary: { gap: 14 },
  review: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  pending: { minHeight: MIN_TOUCH, flexDirection: 'row', alignItems: 'center', gap: 12 },
  pendingText: { flex: 1, gap: 2 },
  pendingTitle: { fontSize: 17, fontWeight: '500' },
  gap4: { gap: 4 },
  gap8: { gap: 8 },
  center: { textAlign: 'center' },
  regular: { fontWeight: '500' },
  summaryTitle: { fontSize: 22, fontWeight: '600' },
  secondary15: { fontSize: 15 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: '500' },
  start: { gap: 12, borderWidth: 2 },
  eyebrow: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
  startTitle: { fontSize: 20, fontWeight: '600', lineHeight: 25 },
  startButtons: { flexDirection: 'row', gap: 8 },
  bigButton: { flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  bigButtonText: { fontSize: 17, fontWeight: '600' },
  groupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 4, gap: 8 },
  groupTitle: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
  groupSub: { fontSize: 13, flexShrink: 1, textAlign: 'right' },
  allDone: { alignItems: 'center', gap: 10, paddingVertical: 28 },
  allDoneBadge: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  allDoneTitle: { fontSize: 24, fontWeight: '600' },
  doneHeader: { minHeight: MIN_TOUCH, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  doneRow: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingLeft: 6, paddingRight: 16, gap: 4 },
  circleHit: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  doneCircle: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  doneTitle: { flex: 1, fontSize: 17, textDecorationLine: 'line-through' },
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    minHeight: 52,
    borderRadius: 14,
    paddingLeft: 16,
    paddingRight: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
  },
  toastText: { flex: 1, fontSize: 15, paddingVertical: 8 },
  toastButton: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  toastAction: { fontSize: 17, fontWeight: '600' },
  micBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    gap: 8,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  mic: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 6 },
  },
  micLabel: { fontSize: 13 },
});
