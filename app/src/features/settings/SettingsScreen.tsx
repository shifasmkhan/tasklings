import DateTimePicker from '@react-native-community/datetimepicker';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Task } from '@/api/types';
import { UndoToast } from '@/features/today/parts';
import { MIN_TOUCH, usePalette, type Palette } from '@/theme/colors';
import appConfig from '../../../app.json';
import { defaultAppleCredentialSource, type AppleCredentialSource } from './appleCredential';
import { shareExportFile, type ExportSharer } from './exportShare';
import { clockToDate, dateToClock, DELETE_COPY, EMPTY_DROPPED_TEXT, TIMES_FOOTNOTE, type TimeKind } from './logic';
import { useSettings } from './useSettings';

interface Props {
  /** Called after the account is deleted and the session is cleared. */
  onAccountDeleted: () => void;
  /** Test seams; the app uses the defaults. */
  credentialSource?: AppleCredentialSource;
  shareExport?: ExportSharer;
}

const TIME_LABELS: Record<TimeKind, string> = {
  briefTime: 'Morning brief',
  checkinTime: 'Evening check-in',
};

export function SettingsScreen({
  onAccountDeleted,
  credentialSource = defaultAppleCredentialSource,
  shareExport = shareExportFile,
}: Props) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const s = useSettings({ credentialSource, shareExport, onAccountDeleted });
  const busy = s.working !== null;

  return (
    <View style={[styles.screen, { backgroundColor: p.background }]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
      >
        <Section palette={p} title="Times">
          <View style={[styles.card, { backgroundColor: p.card }]}>
            {s.profileState === 'loading' ? (
              <ActivityIndicator accessibilityLabel="Loading your times" color={p.accent} />
            ) : s.profileState === 'error' || !s.profile ? (
              <View style={styles.gap8}>
                <Text style={[styles.body, { color: p.text }]}>Couldn&apos;t load your times.</Text>
                <TextButton palette={p} label="Try again" onPress={() => void s.reloadProfile()} />
              </View>
            ) : (
              <>
                {(['briefTime', 'checkinTime'] as const).map((kind, i) => (
                  <TimeRow
                    key={kind}
                    palette={p}
                    label={TIME_LABELS[kind]}
                    value={s.profile![kind]}
                    first={i === 0}
                    onChange={(hhmm) => s.changeTime(kind, hhmm)}
                  />
                ))}
                {s.timeError ? (
                  <Text role="alert" aria-live="polite" style={[styles.message, { color: p.text }]}>
                    {s.timeError}
                  </Text>
                ) : null}
              </>
            )}
          </View>
          <Text style={[styles.footnote, { color: p.secondaryText }]}>{TIMES_FOOTNOTE}</Text>
        </Section>

        <Section palette={p} title="Recently dropped">
          <View style={[styles.card, styles.listCard, { backgroundColor: p.card }]}>
            {s.droppedState === 'loading' ? (
              <View style={styles.pad}>
                <ActivityIndicator accessibilityLabel="Loading recently dropped" color={p.accent} />
              </View>
            ) : s.droppedState === 'error' ? (
              <View style={[styles.pad, styles.gap8]}>
                <Text style={[styles.body, { color: p.text }]}>Couldn&apos;t load your dropped tasks.</Text>
                <TextButton palette={p} label="Try again" onPress={() => void s.reloadDropped()} />
              </View>
            ) : s.dropped.length === 0 ? (
              <Text style={[styles.body, styles.pad, { color: p.secondaryText }]}>{EMPTY_DROPPED_TEXT}</Text>
            ) : (
              <View role="list" aria-label="Recently dropped">
                {s.dropped.map((task, i) => (
                  <DroppedRow
                    key={task.id}
                    palette={p}
                    task={task}
                    first={i === 0}
                    disabled={s.restoring.has(task.id)}
                    onRestore={() => void s.restore(task.id)}
                  />
                ))}
              </View>
            )}
          </View>
        </Section>

        <Section palette={p} title="Your data">
          <View style={[styles.card, styles.gap12, { backgroundColor: p.card }]}>
            <Text style={[styles.body, { color: p.secondaryText }]}>
              Exporting or deleting needs a fresh Sign in with Apple first.
            </Text>
            <ActionButton
              palette={p}
              label="Export my data"
              kind="plain"
              disabled={busy}
              working={s.working === 'export'}
              onPress={() => void s.exportMyData()}
            />
            <ActionButton
              palette={p}
              label="Delete account"
              kind="destructive"
              disabled={busy}
              working={s.working === 'delete'}
              onPress={s.askDelete}
            />
            {s.dataError ? (
              <Text role="alert" aria-live="polite" style={[styles.message, { color: p.text }]}>
                {s.dataError}
              </Text>
            ) : null}
            {s.dataMessage ? (
              <Text role="status" aria-live="polite" style={[styles.message, { color: p.text }]}>
                {s.dataMessage}
              </Text>
            ) : null}
          </View>
        </Section>

        <Section palette={p} title="About">
          <View style={[styles.card, { backgroundColor: p.card }]} accessible aria-label={`Version ${appConfig.expo.version}`}>
            <Text style={[styles.body, { color: p.text }]}>Version {appConfig.expo.version}</Text>
          </View>
        </Section>
      </ScrollView>

      {s.toast ? <UndoToast toast={s.toast} bottom={insets.bottom + 16} onUndo={s.dismissToast} /> : null}

      <Modal
        visible={s.confirmingDelete}
        transparent
        animationType="slide"
        onRequestClose={s.cancelDelete}
        accessibilityViewIsModal
      >
        <View style={styles.scrim}>
          <View
            role="alertdialog"
            aria-label="Delete account"
            aria-modal
            style={[styles.sheet, { backgroundColor: p.card, paddingBottom: Math.max(insets.bottom, 16) + 8 }]}
          >
            <Text role="heading" style={[styles.sheetTitle, { color: p.text }]}>
              Delete your account?
            </Text>
            <Text style={[styles.body, { color: p.text }]}>{DELETE_COPY}</Text>
            <ActionButton palette={p} label="Delete account" kind="destructive" disabled={false} working={false} onPress={() => void s.confirmDelete()} />
            <ActionButton palette={p} label="Cancel" kind="plain" disabled={false} working={false} onPress={s.cancelDelete} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Section({ palette: p, title, children }: { palette: Palette; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.gap8}>
      <Text role="heading" style={[styles.sectionTitle, { color: p.secondaryText }]}>
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

function TimeRow({
  palette: p,
  label,
  value,
  first,
  onChange,
}: {
  palette: Palette;
  label: string;
  value: string;
  first: boolean;
  onChange: (hhmm: string) => void;
}) {
  return (
    <View style={[styles.timeRow, !first && { borderTopColor: p.separator, borderTopWidth: StyleSheet.hairlineWidth }]}>
      <Text style={[styles.body, styles.timeLabel, { color: p.text }]}>{label}</Text>
      <DateTimePicker
        mode="time"
        display="compact"
        value={clockToDate(value)}
        accessibilityLabel={`${label} time`}
        onChange={(event, date) => {
          if (event.type === 'set' && date) onChange(dateToClock(date));
        }}
      />
    </View>
  );
}

function DroppedRow({
  palette: p,
  task,
  first,
  disabled,
  onRestore,
}: {
  palette: Palette;
  task: Task;
  first: boolean;
  disabled: boolean;
  onRestore: () => void;
}) {
  return (
    <View
      role="listitem"
      style={[styles.droppedRow, !first && { borderTopColor: p.separator, borderTopWidth: StyleSheet.hairlineWidth }]}
    >
      <Text style={[styles.body, styles.droppedTitle, { color: p.text }]}>{task.title}</Text>
      <Pressable
        role="button"
        aria-label={`Restore ${task.title}`}
        aria-disabled={disabled}
        disabled={disabled}
        onPress={onRestore}
        style={[styles.textButton, { opacity: disabled ? 0.5 : 1 }]}
      >
        <Text style={[styles.textButtonLabel, { color: p.accent }]}>Restore</Text>
      </Pressable>
    </View>
  );
}

function TextButton({ palette: p, label, onPress }: { palette: Palette; label: string; onPress: () => void }) {
  return (
    <Pressable role="button" aria-label={label} onPress={onPress} style={styles.textButton}>
      <Text style={[styles.textButtonLabel, { color: p.accent }]}>{label}</Text>
    </Pressable>
  );
}

function ActionButton({
  palette: p,
  label,
  kind,
  disabled,
  working,
  onPress,
}: {
  palette: Palette;
  label: string;
  kind: 'plain' | 'destructive';
  disabled: boolean;
  working: boolean;
  onPress: () => void;
}) {
  // Destructive text sits on a filled button: white on dropAction passes contrast in both themes.
  const destructive = kind === 'destructive';
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-busy={working}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.actionButton,
        { backgroundColor: destructive ? p.dropAction : p.fill, opacity: disabled && !working ? 0.5 : 1 },
      ]}
    >
      {working ? (
        <ActivityIndicator color={destructive ? '#FFFFFF' : p.accent} accessibilityLabel={`${label}, working`} />
      ) : (
        <Text style={[styles.actionLabel, { color: destructive ? '#FFFFFF' : p.accent }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 24 },
  gap8: { gap: 8 },
  gap12: { gap: 12 },
  sectionTitle: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3, paddingHorizontal: 4 },
  card: { borderRadius: 14, padding: 16 },
  listCard: { padding: 0, overflow: 'hidden' },
  pad: { padding: 16 },
  body: { fontSize: 17, lineHeight: 23 },
  footnote: { fontSize: 13, paddingHorizontal: 4 },
  message: { fontSize: 15, paddingTop: 8 },
  timeRow: {
    minHeight: MIN_TOUCH + 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 12,
    paddingVertical: 6,
  },
  timeLabel: { flexShrink: 1 },
  droppedRow: {
    minHeight: MIN_TOUCH + 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  droppedTitle: { flexShrink: 1 },
  textButton: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: 'center', alignSelf: 'flex-start' },
  textButtonLabel: { fontSize: 17, fontWeight: '600' },
  actionButton: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  actionLabel: { fontSize: 17, fontWeight: '600' },
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.4)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 12 },
  sheetTitle: { fontSize: 22, fontWeight: '700' },
});
