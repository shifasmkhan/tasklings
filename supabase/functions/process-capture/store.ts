import type {
  CaptureSource,
  CaptureStore,
  ExtractedTask,
  InsertCaptureResult,
  QuotaVerdict,
} from "./handler.ts";
import { userClient } from "../_shared/supabase.ts";

const UNIQUE_VIOLATION = "23505";

export function supabaseCaptureStore(token: string): CaptureStore {
  const db = userClient(token);
  return {
    async insertCapture(id, transcript, source: CaptureSource): Promise<InsertCaptureResult> {
      const { error } = await db.from("captures").insert({
        id,
        source,
        transcript,
        status: "parsing",
      });
      if (!error) return "created";
      if (error.code !== UNIQUE_VIOLATION) throw new Error(`insert capture failed: ${error.code}`);
      // Under RLS the caller only sees their own capture; someone else's id stays invisible.
      const { data, error: readError } = await db.from("captures").select("id,status").eq("id", id)
        .maybeSingle();
      if (readError) throw new Error(`read capture failed: ${readError.code}`);
      if (!data) return "conflict";
      if (data.status !== "failed") return "exists";
      // Retry of a failed capture: flip it back to parsing. The status filter makes this atomic,
      // so of two concurrent retries only one gets the row back and runs the pipeline.
      const { data: flipped, error: flipError } = await db.from("captures")
        .update({ status: "parsing", error: null, transcript })
        .eq("id", id).eq("status", "failed").select("id");
      if (flipError) throw new Error(`retry capture failed: ${flipError.code}`);
      return flipped && flipped.length > 0 ? "retry" : "exists";
    },
    async insertTasks(captureId, tasks: readonly ExtractedTask[], needsReview) {
      const rows = tasks.map((t, i) => ({
        capture_id: captureId,
        title: t.title,
        kind: t.kind,
        effort_min: t.effort_min,
        due_date: t.due_date,
        sort_order: i,
        needs_review: needsReview,
      }));
      const { error } = await db.from("tasks").insert(rows);
      if (error) throw new Error(`insert tasks failed: ${error.code}`);
      return rows.length;
    },
    async setCaptureStatus(id, status, errorCode) {
      const { error } = await db.from("captures").update({ status, error: errorCode ?? null }).eq("id", id);
      if (error) throw new Error(`update capture failed: ${error.code}`);
    },
    async hasTasks(captureId) {
      const { count, error } = await db.from("tasks").select("id", { count: "exact", head: true })
        .eq("capture_id", captureId);
      if (error) throw new Error(`read tasks failed: ${error.code}`);
      return (count ?? 0) > 0;
    },
    async reserveExtraction(): Promise<QuotaVerdict> {
      const { data, error } = await db.rpc("reserve_extraction");
      if (error) throw new Error(`reserve extraction failed: ${error.code}`);
      if (data !== "ok" && data !== "user_cap" && data !== "global_cap") {
        throw new Error("reserve extraction returned an unknown verdict");
      }
      return data;
    },
  };
}
