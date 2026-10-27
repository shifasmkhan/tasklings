import { createHandler, type ExportStore } from "./handler.ts";
import { getUserFromAuth, userClient } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";

const PAGE = 1000;

function supabaseExportStore(token: string): ExportStore {
  const db = userClient(token);
  return {
    async selectAll(table, columns) {
      const rows: unknown[] = [];
      for (let from = 0;; from += PAGE) {
        // Stable order for paging: the first column is each table's primary key.
        const { data, error } = await db.from(table).select(columns).order(columns.split(",")[0])
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`export ${table} failed: ${error.code}`);
        rows.push(...(data ?? []));
        if (!data || data.length < PAGE) return rows;
      }
    },
  };
}

Deno.serve(createHandler({
  getUser: getUserFromAuth,
  store: supabaseExportStore,
  now: () => new Date(),
  log: logEvent,
}));
