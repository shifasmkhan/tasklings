import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import Swipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';

import type { IsoDate, Task } from '@/api/types';
import { CheckIcon } from '@/components/icons';
import { MIN_TOUCH, usePalette, type Palette } from '@/theme/colors';
import { completionHaptic, selectionHaptic } from './haptics';
import { carriedLabel, taskMeta } from './logic';

export interface RowHandlers {
  onComplete: (task: Task) => void;
  onTomorrow: (task: Task) => void;
  onDrop: (task: Task) => void;
  onOpen: (task: Task) => void;
}

/**
 * What a finished swipe does. Swiping right (finger moves right) opens the left panel and
 * completes; swiping left opens the right panel with Tomorrow and Drop and waits for a tap.
 */
export function swipeOutcome(direction: SwipeDirection): 'complete' | 'reveal' {
  return direction === SwipeDirection.RIGHT ? 'complete' : 'reveal';
}

export const ROW_ACTIONS = [
  { name: 'complete', label: 'Mark done' },
  { name: 'tomorrow', label: 'Move to tomorrow' },
  { name: 'drop', label: 'Drop' },
] as const;

interface Props extends RowHandlers {
  task: Task;
  today: IsoDate;
  first: boolean;
}

export function TaskRow({ task, today, first, onComplete, onTomorrow, onDrop, onOpen }: Props) {
  const p = usePalette();
  const swipeRef = useRef<SwipeableMethods>(null);
  const carried = carriedLabel(task);
  const meta = taskMeta(task, today);

  const complete = () => {
    completionHaptic();
    onComplete(task);
  };
  const tomorrow = () => {
    swipeRef.current?.close();
    onTomorrow(task);
  };
  const drop = () => {
    swipeRef.current?.close();
    onDrop(task);
  };

  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    switch (e.nativeEvent.actionName) {
      case 'complete':
        complete();
        break;
      case 'tomorrow':
        onTomorrow(task);
        break;
      case 'drop':
        onDrop(task);
        break;
      case 'activate':
        onOpen(task);
        break;
    }
  };

  return (
    <Swipeable
      ref={swipeRef}
      friction={1.5}
      leftThreshold={72}
      rightThreshold={48}
      overshootLeft={false}
      overshootRight={false}
      onSwipeableWillOpen={(direction) => {
        if (swipeOutcome(direction) === 'complete') {
          swipeRef.current?.close();
          complete();
        } else {
          selectionHaptic();
        }
      }}
      renderLeftActions={() => <CompleteUnderlay palette={p} />}
      renderRightActions={() => <DeferDropActions palette={p} title={task.title} onTomorrow={tomorrow} onDrop={drop} />}
      containerStyle={{ backgroundColor: p.card }}
    >
      <View
        style={[
          styles.row,
          { backgroundColor: p.card, borderTopColor: p.separator },
          first ? null : styles.rowBorder,
        ]}
      >
        <Pressable
          role="button"
          aria-label={`Mark done: ${task.title}`}
          hitSlop={4}
          onPress={complete}
          style={styles.circleHit}
        >
          <View style={[styles.circle, { borderColor: p.circle }]} />
        </Pressable>
        <Pressable
          role="button"
          aria-label={[task.title, meta, carried].filter(Boolean).join(', ')}
          accessibilityHint="Opens task details. Swipe up or down for more actions."
          accessibilityActions={[...ROW_ACTIONS, { name: 'activate' }]}
          onAccessibilityAction={onAccessibilityAction}
          onPress={() => onOpen(task)}
          style={styles.body}
        >
          <View style={styles.bodyText}>
            <Text style={[styles.title, { color: p.text }]}>{task.title}</Text>
            <Text style={[styles.meta, { color: p.secondaryText }]}>{meta}</Text>
          </View>
          {carried ? (
            <View style={[styles.carried, { backgroundColor: p.fill }]}>
              <Text style={[styles.carriedText, { color: p.secondaryText }]}>{carried}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>
    </Swipeable>
  );
}

function CompleteUnderlay({ palette: p }: { palette: Palette }) {
  return (
    <View
      style={[styles.underlay, { backgroundColor: p.accent }]}
      accessible={false}
      aria-hidden
    >
      <CheckIcon color={p.onAccent} size={16} />
      <Text style={[styles.underlayText, { color: p.onAccent }]}>Done</Text>
    </View>
  );
}

function DeferDropActions({
  palette: p,
  title,
  onTomorrow,
  onDrop,
}: {
  palette: Palette;
  title: string;
  onTomorrow: () => void;
  onDrop: () => void;
}) {
  return (
    <View style={styles.actions}>
      <Pressable
        role="button"
        aria-label={`Move to tomorrow: ${title}`}
        onPress={onTomorrow}
        style={[styles.action, styles.tomorrow, { backgroundColor: p.deferAction }]}
      >
        <Text style={styles.actionText}>Tomorrow</Text>
      </Pressable>
      <Pressable
        role="button"
        aria-label={`Drop: ${title}`}
        onPress={onDrop}
        style={[styles.action, styles.drop, { backgroundColor: p.dropAction }]}
      >
        <Text style={styles.actionText}>Drop</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 60,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: 16,
    gap: 4,
  },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth },
  circleHit: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  circle: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5 },
  body: { flex: 1, minHeight: MIN_TOUCH, flexDirection: 'row', alignItems: 'center', gap: 8 },
  bodyText: { flex: 1, gap: 2, paddingVertical: 6 },
  title: { fontSize: 17, lineHeight: 22 },
  meta: { fontSize: 13 },
  carried: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  carriedText: { fontSize: 12, fontWeight: '500' },
  underlay: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: 24, gap: 10, minWidth: 120 },
  underlayText: { fontSize: 15, fontWeight: '600' },
  actions: { flexDirection: 'row' },
  action: { alignItems: 'center', justifyContent: 'center', minHeight: MIN_TOUCH, paddingHorizontal: 12 },
  tomorrow: { minWidth: 96 },
  drop: { minWidth: 76 },
  actionText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
