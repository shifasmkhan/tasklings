// Structured logs carry IDs, counts and codes only: never transcripts, titles, notes or tokens.
// The field type keeps callers to primitives; reviewers check that values are IDs or counts.

export type LogFields = Record<string, string | number | boolean>;
export type Logger = (event: string, fields: LogFields) => void;

export const logEvent: Logger = (event, fields) => {
  console.log(JSON.stringify({ event, ...fields }));
};
