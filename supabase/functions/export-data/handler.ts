// export-data (US-09). Request: POST, no body. Response: 200 JSON file (attachment).
// Needs a Sign in with Apple under 5 minutes old (amr timestamp, see _shared/auth.ts).
// Reads with the caller's JWT, so RLS limits the export to the caller's rows and column
// privileges keep service-only data (apple_credentials) out of it.

import { type GetUser, requireFreshSession, requireUser } from "../_shared/auth.ts";
import { json, requireEmptyBody, requirePost, withErrors } from "../_shared/http.ts";
import type { Logger } from "../_shared/log.ts";

export type ExportTable =
  | "profiles"
  | "captures"
  | "tasks"
  | "task_steps"
  | "task_enrichments"
  | "device_tokens";

/** Columns per table, listed explicitly so a future column is exported only by decision. */
export const EXPORT_COLUMNS: Record<ExportTable, string> = {
  profiles: "user_id,display_name,timezone,brief_time,checkin_time,created_at,last_rollover_on",
  captures: "id,source,transcript,status,error,created_at",
  tasks: "id,capture_id,title,notes,kind,effort_min,effort_min_initial,due_date,status,first_planned_for," +
    "planned_for,carry_count,completed_at,dropped_reason,script,sort_order,created_at,updated_at",
  task_steps: "id,task_id,title,done,sort_order",
  task_enrichments: "id,task_id,type,value,source_url,created_at",
  device_tokens: "id,created_at,last_seen_at",
};

export interface ExportStore {
  selectAll(table: ExportTable, columns: string): Promise<unknown[]>;
}

export interface Deps {
  getUser: GetUser;
  store: (token: string) => ExportStore;
  now: () => Date;
  log: Logger;
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return withErrors("export-data", async (req) => {
    requirePost(req);
    const user = await requireUser(req, deps.getUser);
    const now = deps.now();
    requireFreshSession(user.claims, now);
    await requireEmptyBody(req);

    const store = deps.store(user.token);
    const tables = Object.keys(EXPORT_COLUMNS) as ExportTable[];
    const results = await Promise.all(tables.map((t) => store.selectAll(t, EXPORT_COLUMNS[t])));
    const data: Record<string, unknown> = {};
    tables.forEach((t, i) => (data[t] = results[i]));

    const body = {
      format: "tasklings-export",
      version: 1,
      exported_at: now.toISOString(),
      user_id: user.id,
      profile: (data.profiles as unknown[])[0] ?? null,
      captures: data.captures,
      tasks: data.tasks,
      task_steps: data.task_steps,
      task_enrichments: data.task_enrichments,
      device_tokens: data.device_tokens,
    };
    deps.log("data_exported", {
      fn: "export-data",
      user_id: user.id,
      tasks: (data.tasks as unknown[]).length,
    });
    const day = now.toISOString().slice(0, 10);
    return json(200, body, { "Content-Disposition": `attachment; filename="tasklings-export-${day}.json"` });
  }, deps.log);
}
