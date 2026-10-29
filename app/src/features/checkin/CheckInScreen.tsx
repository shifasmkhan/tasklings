import { useMemo, useState } from 'react';
import { ActivityIndicator, Animated, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Task } from '@/api/types';
import { localIsoDate } from '@/lib/dates';
import { carriedLabel, plural, taskMeta } from '@/features/today/logic';
import { MIN_TOUCH, usePalette, type Palette } from '@/theme/colors';
import { briefLine, DROP_CHOICES, isStale, moreMovedText, summaryLines, swipeAction } from './logic';
import { useCheckIn } from './useCheckIn';

// TODO(native/push): the notification action "Remind me in 1 hour" belongs to the push and native
// work (APNs category and a local reschedule). It is not part of this screen.

interface Props {
  onClose: () => void;
  today?: string;
}

export function CheckInScreen({ onClose, today = localIsoDate() }: Props) {
  const p = usePalette();
  const c = useCheckIn(today);

  if (c.loadState === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: p.background }]}>
        <ActivityIndicator accessibilityLabel="Loading your check-in" color={p.accent} />
      </View>
    );
  }
  if (c.loadState === 'error') {
    return (
      <View style={[styles.center, { backgroundColor: p.background }]}>
        <Text style={[styles.body, { color: p.text }]}>Couldn&apos;t load your check-in.</Text>
        <TextButton label="Try again" color={p.accent} onPress={() => void c.reload()} />
        <TextButton label="Close" color={p.accent} onPress={onClose} />
      </View>
    );
  }

  if (c.finished) {
    const empty = c.cards.length === 0;
    const lines = summaryLines(c.counts, c.rolledOver, c.briefTime);
    return (
      <ScrollView style={{ backgroundColor: p.background }} contentContainerStyle={styles.summary}>
        <Text role="heading" style={[styles.h1, { color: p.text }]}>
          {empty ? 'Nothing left open' : 'That’s the day'}
        </Text>
        <View style={[styles.card, styles.gap8, { backgroundColor: p.card }]} accessible>
          {empty ? <Text style={[styles.body, { color: p.text }]}>Nothing is waiting on you tonight.</Text> : null}
          {(empty ? [briefLine(c.briefTime)].filter((l): l is string => l !== null) : lines).map((line) => (
            <Text key={line} style={[styles.body, { color: p.text }]}>
              {line}
            </Text>
          ))}
        </View>
        <Pressable
          role="button"
          aria-label="Good night"
          onPress={onClose}
          style={[styles.primary, { backgroundColor: p.accent }]}
        >
          <Text style={[styles.primaryText, { color: p.onAccent }]}>Good night</Text>
        </Pressable>
      </ScrollView>
    );
  }

  const task = c.current;
  if (!task) return null;
  const stale = isStale(task);

  return (
    <ScrollView
      style={{ backgroundColor: p.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View
        accessible
        role="progressbar"
        aria-label={`Card ${c.index + 1} of ${c.cards.length}`}
        aria-valuemin={1}
        aria-valuemax={c.cards.length}
        aria-valuenow={c.index + 1}
        style={styles.dots}
      >
        {c.cards.map((card, i) => (
          <View
            key={card.id}
            aria-hidden
            style={[styles.dot, { backgroundColor: i < c.index ? p.accent : i === c.index ? p.text : p.track }]}
          />
        ))}
      </View>

      <SwipeCard
        key={task.id}
        // A still-need-this card has no Done button, so a right swipe does nothing there.
        allowDone={!stale}
        disabled={c.busy}
        onDone={() => void c.done()}
        onTomorrow={() => void c.tomorrow()}
      >
        <View style={[styles.card, styles.gap12, { backgroundColor: p.card }]}>
          {stale ? (
            <Text role="heading" style={[styles.eyebrow, { color: p.accent }]}>
              STILL NEED THIS?
            </Text>
          ) : null}
          <Text style={[styles.cardTitle, { color: p.text }]}>{task.title}</Text>
          <CardMeta task={task} today={today} palette={p} stale={stale} />
        </View>
      </SwipeCard>

      {c.error ? (
        <Text role="alert" aria-live="polite" style={[styles.error, { color: p.dropAction }]}>
          {c.error}
        </Text>
      ) : null}

      {c.choosingDrop ? (
        <View style={styles.gap8} role="menu" aria-label="Why drop it?">
          <Text role="heading" style={[styles.body, styles.bold, { color: p.text }]}>
            Why drop it?
          </Text>
          {DROP_CHOICES.map((choice) => (
            <Pressable
              key={choice.label}
              role="menuitem"
              aria-label={choice.label}
              aria-disabled={c.busy}
              disabled={c.busy}
              onPress={() => void c.drop(choice.reason)}
              style={[styles.choice, { backgroundColor: p.card, opacity: c.busy ? 0.5 : 1 }]}
            >
              <Text style={[styles.body, { color: p.text }]}>{choice.label}</Text>
            </Pressable>
          ))}
          <TextButton label="Back" color={p.accent} onPress={c.cancelDrop} />
        </View>
      ) : (
        <View style={styles.buttons}>
          {stale ? (
            <>
              <ActionButton palette={p} label="Keep" a11y="Keep it, move to tomorrow" bg={p.accent} color={p.onAccent} disabled={c.busy} onPress={() => void c.tomorrow()} />
              <ActionButton palette={p} label="Drop" a11y="Drop" bg={p.dropAction} color="#FFFFFF" disabled={c.busy} onPress={c.askDrop} />
            </>
          ) : (
            <>
              <ActionButton palette={p} label="Done" a11y="Mark done" bg={p.accent} color={p.onAccent} disabled={c.busy} onPress={() => void c.done()} />
              <ActionButton palette={p} label="Tomorrow" a11y="Move to tomorrow" bg={p.deferAction} color="#FFFFFF" disabled={c.busy} onPress={() => void c.tomorrow()} />
              <ActionButton palette={p} label="Drop" a11y="Drop" bg={p.dropAction} color="#FFFFFF" disabled={c.busy} onPress={c.askDrop} />
            </>
          )}
        </View>
      )}

      {!c.choosingDrop ? (
        <Text style={[styles.note, styles.centerText, { color: p.secondaryText }]}>
          {stale ? 'Swipe left to keep it' : 'Swipe right for done · swipe left for tomorrow'}
        </Text>
      ) : null}
      {c.rolledOver > 0 ? (
        <Text style={[styles.note, styles.centerText, { color: p.secondaryText }]}>{moreMovedText(c.rolledOver)}</Text>
      ) : null}
    </ScrollView>
  );
}

function CardMeta({ task, today, palette: p, stale }: { task: Task; today: string; palette: Palette; stale: boolean }) {
  const carried = carriedLabel(task);
  const parts = [taskMeta(task, today)];
  if (stale) parts.push(`Carried over ${plural(task.carry_count, 'day', 'days')}`);
  else if (carried) parts.push(carried);
  return <Text style={[styles.meta, { color: p.secondaryText }]}>{parts.join(' · ')}</Text>;
}

interface SwipeState {
  allowDone: boolean;
  disabled: boolean;
  onDone: () => void;
  onTomorrow: () => void;
}

function createSwipeResponder(x: Animated.Value, state: SwipeState) {
  return PanResponder.create({
    // Only claim clearly horizontal drags, so vertical scrolling still works.
    onMoveShouldSetPanResponder: (_e, g) => !state.disabled && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_e, g) => x.setValue(state.allowDone ? g.dx : Math.min(0, g.dx)),
    onPanResponderRelease: (_e, g) => {
      const action = swipeAction(g.dx);
      Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
      if (action === 'done' && state.allowDone) state.onDone();
      else if (action === 'tomorrow') state.onTomorrow();
    },
    onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: true }).start(),
  });
}

function SwipeCard({
  children,
  allowDone,
  disabled,
  onDone,
  onTomorrow,
}: {
  children: React.ReactNode;
  allowDone: boolean;
  disabled: boolean;
  onDone: () => void;
  onTomorrow: () => void;
}) {
  const [x] = useState(() => new Animated.Value(0));
  // The responder is created once; it reads the latest props through this ref.
  const pan = useMemo(
    () => createSwipeResponder(x, { allowDone, disabled, onDone, onTomorrow }),
    [x, allowDone, disabled, onDone, onTomorrow],
  );

  return (
    <Animated.View
      testID="swipe-card"
      {...pan.panHandlers}
      style={{ transform: [{ translateX: x }, { rotate: x.interpolate({ inputRange: [-200, 200], outputRange: ['-4deg', '4deg'] }) }] }}
    >
      {children}
    </Animated.View>
  );
}

function ActionButton({
  label,
  a11y,
  bg,
  color,
  disabled,
  onPress,
}: {
  palette: Palette;
  label: string;
  a11y: string;
  bg: string;
  color: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      aria-label={a11y}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

function TextButton({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable role="button" aria-label={label} onPress={onPress} style={styles.textButton}>
      <Text style={[styles.textButtonLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  content: { padding: 16, gap: 20 },
  summary: { padding: 16, paddingTop: 32, gap: 20 },
  h1: { fontSize: 28, fontWeight: '700' },
  card: { borderRadius: 18, padding: 20 },
  gap8: { gap: 8 },
  gap12: { gap: 12 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, minHeight: 20, alignItems: 'center', flexWrap: 'wrap' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  eyebrow: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3 },
  cardTitle: { fontSize: 24, fontWeight: '600', lineHeight: 30 },
  meta: { fontSize: 15 },
  buttons: { flexDirection: 'row', gap: 8 },
  action: { flex: 1, minHeight: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  actionText: { fontSize: 17, fontWeight: '600' },
  choice: { minHeight: 52, borderRadius: 12, justifyContent: 'center', paddingHorizontal: 16 },
  body: { fontSize: 17, lineHeight: 23 },
  bold: { fontWeight: '600' },
  note: { fontSize: 13 },
  centerText: { textAlign: 'center' },
  error: { fontSize: 15, textAlign: 'center' },
  primary: { minHeight: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { fontSize: 17, fontWeight: '600' },
  textButton: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: 'center', alignSelf: 'flex-start' },
  textButtonLabel: { fontSize: 17, fontWeight: '600' },
});
