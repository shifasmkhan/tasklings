import type { CaptureStore, ExtractedTask, InsertCaptureResult } from "./handler.ts";
import { userClient } from "../_shared/supabase.ts";

const UNIQUE_VIOLATION = "23505";

export function supabaseCaptureStore(token: string): CaptureStore {
  const db = userClient(token);
  return {
    async insertCapture(id, transcript): Promise<InsertCaptureResult> {
      // source is not in the process-capture contract yet; voice is the only Phase 0 entry point.
      const { error } = await db.from("captures").insert({
        id,
        source: "voice",
        transcript,
        status: "parsing",
      });
      if (!error) return "created";
      if (error.code !== UNIQUE_VIOLATION) throw new Error(`insert capture failed: ${error.code}`);
      // Under RLS the caller only sees their own capture; someone else's id stays invisible.
      const { data, error: readError } = await db.from("captures").select("id").eq("id", id).maybeSingle();
      if (readError) throw new Error(`read capture failed: ${readError.code}`);
      return data ? "exists" : "conflict";
    },
    async insertTasks(captureId, tasks: readonly ExtractedTask[]) {
      const rows = tasks.map((t, i) => ({
        capture_id: captureId,
        title: t.title,
        kind: t.kind,
        effort_min: t.effort_min,
        due_date: t.due_date,
        sort_order: i,
      }));
      const { error } = await db.from("tasks").insert(rows);
      if (error) throw new Error(`insert tasks failed: ${error.code}`);
      return rows.length;
    },
    async setCaptureStatus(id, status, errorCode) {
      const { error } = await db.from("captures").update({ status, error: errorCode ?? null }).eq("id", id);
      if (error) throw new Error(`update capture failed: ${error.code}`);
    },
  };
}
