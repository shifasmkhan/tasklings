// US-03: the task-extraction output contract.
//
// The model must return exactly this shape (PRD "Task extraction output"):
//   {"tasks":[{"title":string,"kind":"quick"|"errand"|"project","effort_min":int,"due_date":"YYYY-MM-DD"|null}]}
// Rules: 1-10 tasks; title <= 60 chars, imperative; effort_min 1-480; no extra fields.
//
// This file is dependency-free and uses only web-standard APIs so it can be
// imported unchanged by the process-capture edge function (Deno).

export const TASK_KINDS = ["quick", "errand", "project"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const LIMITS = {
  minTasks: 1,
  maxTasks: 10,
  maxTitleChars: 60,
  minEffortMin: 1,
  maxEffortMin: 480,
} as const;

export interface ExtractedTask {
  title: string;
  kind: TaskKind;
  effort_min: number;
  due_date: string | null;
}

export interface ExtractionOutput {
  tasks: ExtractedTask[];
}

/**
 * JSON Schema (draft 2020-12) for the extraction output. It documents the
 * contract and can be handed to tools that accept a schema; the authoritative
 * check is `validateExtraction` in validate.ts, which also enforces the rules
 * a JSON Schema can't express (calendar-valid dates, code-point title length,
 * no control characters, no URLs / emails / phone numbers in titles).
 */
export const EXTRACTION_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/shifasmkhan/tasklings/ai/extraction-output.schema.json",
  title: "Tasklings task extraction output (US-03)",
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      minItems: LIMITS.minTasks,
      maxItems: LIMITS.maxTasks,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "kind", "effort_min", "due_date"],
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: LIMITS.maxTitleChars,
            description: "Imperative, <= 60 characters, no URLs, emails or phone numbers.",
          },
          kind: { type: "string", enum: [...TASK_KINDS] },
          effort_min: {
            type: "integer",
            minimum: LIMITS.minEffortMin,
            maximum: LIMITS.maxEffortMin,
          },
          due_date: {
            anyOf: [
              { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", format: "date" },
              { type: "null" },
            ],
          },
        },
      },
    },
  },
} as const;
