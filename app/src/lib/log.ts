// The only logger in the app. Security rule: logs carry IDs and codes only,
// never transcripts, task titles or notes. The field type makes that hard to get wrong:
// values must be IDs, codes, counts or booleans, and field names are a fixed allowlist.

type LogField = 'task_id' | 'capture_id' | 'code' | 'status' | 'action' | 'count';
type LogValue = string | number | boolean | null;

export function logEvent(event: string, fields: Partial<Record<LogField, LogValue>> = {}): void {
  if (!__DEV__) return;
  // Constant format string: the event name is an argument, so it can't inject format specifiers.
  console.info('[tasklings] %s', event, fields);
}
