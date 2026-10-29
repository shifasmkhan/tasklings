import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { IsoDate } from '@/api/types';
import { localIsoDate } from '@/lib/dates';
import { NEEDS_REVIEW_LABEL } from '@/features/today/logic';
import { UndoToast } from '@/features/today/parts';
import { MIN_TOUCH, usePalette, type Palette } from '@/theme/colors';
import {
  allowedEnrichments,
  dueChipLabel,
  dueOptions,
  effortChipLabel,
  effortOptions,
  ENRICHMENT_LABELS,
  KIND_OPTIONS,
  kindLabel,
  showsScript,
  TITLE_MAX,
} from './logic';
import { useTaskDetail, type Outcome } from './useTaskDetail';

type MenuName = 'kind' | 'effort' | 'due';

const OUTCOME_TEXT: Record<Exclude<Outcome, null>, string> = {
  complete: 'Done',
  tomorrow: 'Moved to tomorrow',
  drop: 'Dropped',
};

interface Props {
  taskId: string;
  onBack: () => void;
  today?: IsoDate;
}

export function TaskDetailScreen({ taskId, onBack, today = localIsoDate() }: Props) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const d = useTaskDetail(taskId);
  const [menu, setMenu] = useState<MenuName | null>(null);
  const [barHeight, setBarHeight] = useState(96 + insets.bottom);

  if (d.loadState === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: p.background }]}>
        <ActivityIndicator accessibilityLabel="Loading task" color={p.accent} />
      </View>
    );
  }
  if (d.loadState !== 'ready' || !d.task) {
    const failed = d.loadState === 'error';
    return (
      <View style={[styles.center, { backgroundColor: p.background }]}>
        <Text style={[styles.body, { color: p.text }]}>
          {failed ? "Couldn't load this task." : "Couldn't find this task."}
        </Text>
        {failed ? <TextButton label="Try again" color={p.accent} onPress={() => void d.reload()} /> : null}
        <TextButton label="Back to Today" color={p.accent} onPress={onBack} />
      </View>
    );
  }

  const task = d.task;
  const open = d.outcome === null;
  const enrichments = allowedEnrichments(d.enrichments);
  const toggle = (name: MenuName) => setMenu((m) => (m === name ? null : name));
  const choose = (edit: Parameters<typeof d.save>[0]) => {
    setMenu(null);
    void d.save(edit);
  };

  return (
    <View style={[styles.screen, { backgroundColor: p.background }]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, { paddingBottom: barHeight + 24 }]}
      >
        <View style={styles.gap8}>
          <TextInput
            value={d.draftTitle}
            onChangeText={d.changeTitle}
            onBlur={d.commitTitle}
            editable={open}
            multiline
            submitBehavior="blurAndSubmit"
            maxLength={TITLE_MAX}
            returnKeyType="done"
            accessibilityLabel="Task title"
            accessibilityHint="Edit the title. It saves on its own."
            style={[styles.title, { color: p.text }]}
            placeholderTextColor={p.secondaryText}
          />
          {task.needs_review ? (
            <Text style={[styles.review, { color: p.accent }]}>{NEEDS_REVIEW_LABEL}</Text>
          ) : null}
          {d.error ? (
            <Text role="alert" aria-live="polite" style={[styles.error, { color: p.dropAction }]}>
              {d.error}
            </Text>
          ) : null}
        </View>

        <View style={styles.chips}>
          <Chip
            palette={p}
            label={kindLabel(task.kind)}
            name="Type"
            expanded={menu === 'kind'}
            disabled={!open}
            onPress={() => toggle('kind')}
          />
          <Chip
            palette={p}
            label={effortChipLabel(task.effort_min)}
            name="Effort"
            expanded={menu === 'effort'}
            disabled={!open}
            onPress={() => toggle('effort')}
          />
          <Chip
            palette={p}
            label={dueChipLabel(task.due_date, today)}
            name="Due date"
            expanded={menu === 'due'}
            disabled={!open}
            onPress={() => toggle('due')}
          />
        </View>

        {menu === 'kind' ? (
          <Menu palette={p} title="Type">
            {KIND_OPTIONS.map((k) => (
              <MenuItem key={k} palette={p} label={kindLabel(k)} selected={k === task.kind} onPress={() => choose({ kind: k })} />
            ))}
          </Menu>
        ) : null}
        {menu === 'effort' ? (
          <Menu palette={p} title="Effort">
            {effortOptions(task.effort_min).map((m) => (
              <MenuItem
                key={m}
                palette={p}
                label={effortChipLabel(m)}
                selected={m === task.effort_min}
                onPress={() => choose({ effort_min: m })}
              />
            ))}
          </Menu>
        ) : null}
        {menu === 'due' ? (
          <Menu palette={p} title="Due date">
            {dueOptions(today).map((o) => (
              <MenuItem
                key={o.label}
                palette={p}
                label={o.label}
                selected={o.value === task.due_date}
                onPress={() => choose({ due_date: o.value })}
              />
            ))}
          </Menu>
        ) : null}

        {showsScript(task) ? <ScriptCard palette={p} script={task.script ?? ''} /> : null}

        {enrichments.length > 0 ? (
          <View style={styles.gap8} role="list" aria-label="Found for you">
            <Text role="heading" style={[styles.sectionTitle, { color: p.secondaryText }]}>
              FOUND FOR YOU
            </Text>
            <View style={[styles.card, { backgroundColor: p.card }]}>
              {enrichments.map((e) => (
                <View key={e.id} role="listitem" accessible style={styles.found} aria-label={`${ENRICHMENT_LABELS[e.type]}: ${e.value}`}>
                  <Text style={[styles.foundLabel, { color: p.secondaryText }]}>{ENRICHMENT_LABELS[e.type]}</Text>
                  <Text selectable style={[styles.body, { color: p.text }]}>
                    {e.value}
                  </Text>
                </View>
              ))}
              <Text style={[styles.source, { color: p.secondaryText }]}>From Apple Maps</Text>
            </View>
          </View>
        ) : null}
        {d.transcript !== null && d.transcript.trim() !== '' ? (
          <View style={styles.gap8}>
            <Text role="heading" style={[styles.sectionTitle, { color: p.secondaryText }]}>
              FROM YOUR VOICE NOTE
            </Text>
            <View style={[styles.card, { backgroundColor: p.card }]}>
              <Text selectable style={[styles.body, { color: p.text }]}>
                {d.transcript}
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>

      {d.toast ? (
        <UndoToast
          toast={d.toast}
          bottom={barHeight + 12}
          onUndo={() => {
            const undo = d.toast?.undo;
            d.dismissToast();
            undo?.();
          }}
        />
      ) : null}

      <View
        onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}
        style={[styles.bar, { backgroundColor: p.barBackground, borderTopColor: p.separator, paddingBottom: Math.max(insets.bottom, 12) }]}
      >
        {open ? (
          <View style={styles.barRow}>
            <BarButton label="Done" a11y="Mark done" bg={p.accent} color={p.onAccent} disabled={d.busy} onPress={() => void d.complete()} />
            <BarButton label="Tomorrow" a11y="Move to tomorrow" bg={p.deferAction} color="#FFFFFF" disabled={d.busy} onPress={() => void d.tomorrow()} />
            <BarButton label="Drop" a11y="Drop" bg={p.dropAction} color="#FFFFFF" disabled={d.busy} onPress={() => void d.drop()} />
          </View>
        ) : (
          <View style={styles.barRow}>
            <Text style={[styles.outcome, { color: p.text }]}>{d.outcome ? OUTCOME_TEXT[d.outcome] : ''}</Text>
            <TextButton label="Back to Today" color={p.accent} onPress={onBack} />
          </View>
        )}
      </View>
    </View>
  );
}

function TextButton({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable role="button" aria-label={label} onPress={onPress} style={styles.textButton}>
      <Text style={[styles.textButtonLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

function Chip({
  palette: p,
  label,
  name,
  expanded,
  disabled,
  onPress,
}: {
  palette: Palette;
  label: string;
  name: string;
  expanded: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      aria-label={`${name}: ${label}`}
      accessibilityHint="Opens a menu"
      aria-expanded={expanded}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: expanded ? p.accent : p.card }]}
    >
      <Text style={[styles.chipText, { color: expanded ? p.onAccent : p.text }]}>{label}</Text>
    </Pressable>
  );
}

function Menu({ palette: p, title, children }: { palette: Palette; title: string; children: React.ReactNode }) {
  return (
    <View role="menu" aria-label={title} style={[styles.card, styles.menu, { backgroundColor: p.card }]}>
      {children}
    </View>
  );
}

function MenuItem({
  palette: p,
  label,
  selected,
  onPress,
}: {
  palette: Palette;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable role="menuitem" aria-label={label} aria-selected={selected} onPress={onPress} style={styles.menuItem}>
      <Text style={[styles.body, { color: p.text }]}>{label}</Text>
      {selected ? <Text style={[styles.body, { color: p.accent }]} accessibilityElementsHidden>{'✓'}</Text> : null}
    </Pressable>
  );
}

function ScriptCard({ palette: p, script }: { palette: Palette; script: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(script);
      setCopied(true);
      AccessibilityInfo.announceForAccessibility('Copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Copy is a convenience; the text stays on screen to select by hand.
    }
  };
  return (
    <View style={styles.gap8}>
      <Text role="heading" style={[styles.sectionTitle, { color: p.secondaryText }]}>
        WHAT TO SAY
      </Text>
      <View style={[styles.card, styles.gap8, { backgroundColor: p.card }]}>
        <Text selectable style={[styles.body, { color: p.text }]}>
          {script}
        </Text>
        <Pressable
          role="button"
          aria-label={copied ? 'Copied' : 'Copy script'}
          onPress={() => void copy()}
          style={styles.textButton}
        >
          <Text style={[styles.textButtonLabel, { color: p.accent }]}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function BarButton({
  label,
  a11y,
  bg,
  color,
  disabled,
  onPress,
}: {
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
      style={[styles.barButton, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={[styles.barButtonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  content: { padding: 16, gap: 20 },
  gap8: { gap: 8 },
  title: { fontSize: 28, fontWeight: '700', paddingHorizontal: 4, paddingVertical: 4, minHeight: MIN_TOUCH },
  review: { fontSize: 15, fontWeight: '600', paddingHorizontal: 4 },
  error: { fontSize: 15, paddingHorizontal: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, borderRadius: 22, paddingHorizontal: 16, justifyContent: 'center' },
  chipText: { fontSize: 15, fontWeight: '500' },
  card: { borderRadius: 14, padding: 16 },
  menu: { padding: 4 },
  menuItem: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  body: { fontSize: 17, lineHeight: 23 },
  sectionTitle: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3, paddingHorizontal: 4 },
  found: { gap: 2, paddingVertical: 6 },
  foundLabel: { fontSize: 13, fontWeight: '600' },
  source: { fontSize: 13, paddingTop: 6 },
  textButton: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: 'center', alignSelf: 'flex-start' },
  textButtonLabel: { fontSize: 17, fontWeight: '600' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 12, paddingHorizontal: 16, borderTopWidth: StyleSheet.hairlineWidth },
  barRow: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'space-between' },
  barButton: { flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  barButtonText: { fontSize: 17, fontWeight: '600' },
  outcome: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
});
