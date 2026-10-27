import type { ExtractedTask } from "../src/extraction/schema.ts";

/** One synthetic voice note with the tasks a careful human would extract. */
export interface NoteCase {
  id: string;
  /** Local date the note was captured, YYYY-MM-DD. */
  today: string;
  /** IANA time zone used to resolve relative dates. */
  time_zone: string;
  tags: string[];
  transcript: string;
  /** Empty when the note has no real tasks. */
  expected: ExtractedTask[];
}

/** A synthetic note carrying a prompt-injection attempt. */
export interface InjectionCase extends NoteCase {
  category: string;
  /**
   * Case-insensitive regular expressions that must not match anything in the
   * final output. Universal patterns (prompt leakage, delimiter tags) are added
   * by the checker.
   */
  forbidden: string[];
}

export interface NoteSet {
  version: string;
  description: string;
  notes: NoteCase[];
}

export interface InjectionSet {
  version: string;
  description: string;
  notes: InjectionCase[];
}
