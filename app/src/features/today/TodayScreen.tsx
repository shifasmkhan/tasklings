import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Task } from '@/api/types';
import { useOptionalCaptureStore, usePendingCaptures } from '@/features/capture/CaptureProvider';
import { GearIcon, MoonIcon } from '@/components/icons';
import { MIN_TOUCH, usePalette } from '@/theme/colors';
import { firstNeedingReview } from './logic';
import { AllDone, DoneToday, GroupHeader, MicBar, PendingRow, ReviewCard, StartHereCard, SummaryCard, UndoToast } from './parts';
import { TaskRow } from './TaskRow';
import { useToday } from './useToday';

export interface TodayNavigation {
  /** `startLocked`: a tap on the mic starts locked recording at once; a long press just opens the sheet. */
  openCapture: (options?: { startLocked?: boolean }) => void;
  openTask: (task: Task) => void;
  openCheckIn: () => void;
  openSettings: () => void;
}

/** First-frame guess at the mic bar's height; the real height comes from onLayout. */
const MIC_BAR_ESTIMATE = 120;

function formatHeaderDate(date: Date): string {
  return date
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    .toUpperCase();
}

export function TodayScreen({
  nav,
  now = new Date(),
  refreshKey = 0,
}: {
  nav: TodayNavigation;
  now?: Date;
  /** Bump this to reload the list, e.g. when Today comes back into focus after Task detail (US-05). */
  refreshKey?: number;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const t = useToday();
  const captures = useOptionalCaptureStore();
  const pending = usePendingCaptures();
  const [doneOpen, setDoneOpen] = useState(false);
  const [measuredBar, setMeasuredBar] = useState<number | null>(null);
  const barHeight = measuredBar ?? MIC_BAR_ESTIMATE + Math.max(insets.bottom, 12);

  const { reload } = t;
  useEffect(() => {
    if (refreshKey > 0) void reload();
  }, [refreshKey, reload]);

  const reviewTask = firstNeedingReview(t.open);

  const handlers = {
    onComplete: t.complete,
    onTomorrow: t.tomorrow,
    onDrop: t.drop,
    onOpen: nav.openTask,
  };

  return (
    <View style={[styles.screen, { backgroundColor: p.background }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: barHeight + 80 }]}
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.date, { color: p.secondaryText }]}>{formatHeaderDate(now)}</Text>
            <Text role="heading" style={[styles.h1, { color: p.text }]}>
              Today
            </Text>
          </View>
          <View style={styles.headerButtons}>
            <Pressable
              role="button"
              aria-label="Settings"
              onPress={nav.openSettings}
              style={[styles.headerButton, { backgroundColor: p.card }]}
            >
              <GearIcon color={p.accent} cutout={p.card} />
            </Pressable>
            <Pressable
              role="button"
              aria-label="Open evening check-in"
              onPress={nav.openCheckIn}
              style={[styles.headerButton, { backgroundColor: p.card }]}
            >
              <MoonIcon color={p.accent} cutout={p.card} />
            </Pressable>
          </View>
        </View>

        {pending.map((c) => (
          <PendingRow key={c.capture_id} capture={c} onRetry={(id) => void captures?.retry(id)} />
        ))}

        {t.loadState === 'loading' ? (
          <ActivityIndicator accessibilityLabel="Loading today's tasks" color={p.accent} style={styles.loading} />
        ) : t.loadState === 'error' ? (
          <View style={[styles.errorCard, { backgroundColor: p.card }]}>
            <Text style={[styles.errorText, { color: p.text }]}>Couldn&apos;t load today&apos;s tasks.</Text>
            <Pressable role="button" aria-label="Try again" onPress={() => void t.reload()} style={styles.retry}>
              <Text style={[styles.retryText, { color: p.accent }]}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {reviewTask ? <ReviewCard task={reviewTask} onOpen={nav.openTask} /> : null}

            <SummaryCard summary={t.summary} />

            {t.startHere ? (
              <StartHereCard
                task={t.startHere}
                today={t.today}
                onDone={t.complete}
                onSkip={t.skip}
                onOpen={nav.openTask}
              />
            ) : null}

            {t.groups.map((g) => (
              <View key={g.kind} style={styles.group} role="list" aria-label={g.title}>
                <GroupHeader title={g.title} subtitle={g.subtitle} />
                <View style={[styles.listCard, { backgroundColor: p.card }]}>
                  {g.tasks.map((task, i) => (
                    <TaskRow key={task.id} task={task} today={t.today} first={i === 0} {...handlers} />
                  ))}
                </View>
              </View>
            ))}

            {t.open.length > 0 ? (
              <Text style={[styles.hint, { color: p.secondaryText }]}>
                Swipe right to finish · swipe left for Tomorrow or Drop
              </Text>
            ) : (
              <AllDone />
            )}

            {t.done.length > 0 ? (
              <DoneToday
                tasks={t.done}
                expanded={doneOpen}
                onToggle={() => setDoneOpen((o) => !o)}
                onUncomplete={t.uncomplete}
              />
            ) : null}
          </>
        )}
      </ScrollView>

      {t.toast ? (
        <UndoToast
          toast={t.toast}
          bottom={barHeight + 12}
          onUndo={() => {
            const undo = t.toast?.undo;
            t.dismissToast();
            undo?.();
          }}
        />
      ) : null}

      <MicBar
        onTap={() => nav.openCapture({ startLocked: true })}
        onHold={() => nav.openCapture()}
        bottomInset={insets.bottom} onHeight={setMeasuredBar}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 16, gap: 24 },
  header: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: 4 },
  headerText: { gap: 2, flexShrink: 1 },
  date: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
  h1: { fontSize: 34, fontWeight: '700' },
  headerButtons: { flexDirection: 'row', gap: 8 },
  headerButton: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, alignItems: 'center', justifyContent: 'center' },
  loading: { marginTop: 40 },
  errorCard: { borderRadius: 14, padding: 16, gap: 8 },
  errorText: { fontSize: 17 },
  retry: { minHeight: MIN_TOUCH, justifyContent: 'center', alignSelf: 'flex-start' },
  retryText: { fontSize: 17, fontWeight: '500' },
  group: { gap: 8 },
  listCard: { borderRadius: 14, overflow: 'hidden' },
  hint: { textAlign: 'center', fontSize: 13 },
});
