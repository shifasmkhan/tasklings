// Runtime smoke test of the extraction module under Deno (the edge-function
// runtime). Run: deno run --no-prompt deno/smoke.ts  (no permissions needed)
import { extractTasks, FALLBACK_TASK, parseAndValidate } from "../src/extraction/mod.ts";

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`deno smoke: ${msg}`);
}

const ok = JSON.stringify({ tasks: [{ title: "Buy milk", kind: "errand", effort_min: 45, due_date: "2026-11-05" }] });
check(parseAndValidate(ok).ok, "valid output accepted");
check(!parseAndValidate('{"tasks":[]}').ok, "empty list rejected");

const capturedAt = new Date("2026-11-04T18:00:00Z");
let seen = "";
const good = await extractTasks({ transcript: "milk tomorrow", capturedAt, timeZone: "America/Chicago" }, {
  complete: (req) => {
    seen = req.user;
    return Promise.resolve(ok);
  },
});
check(good.status === "ok", "ok path");
check(seen.includes("Wednesday, 2026-11-04"), "local date in prompt");

const bad = await extractTasks({ transcript: "x", capturedAt, timeZone: "America/Chicago" }, {
  complete: () => Promise.resolve("nope"),
});
check(bad.status === "fallback" && bad.tasks[0]?.title === FALLBACK_TASK.title, "fallback path");

console.log("deno smoke: ok");
