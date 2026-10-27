// Security rule: the service-role key is used only by delete-account (and scheduled jobs, which
// run in Postgres). This test fails if any other function source mentions it.
import { strict as assert } from "node:assert";

const ROOT = new URL("../", import.meta.url);

async function sourceFiles(dir: URL, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) {
      if (e.name === "tests") continue;
      out.push(...await sourceFiles(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`));
    } else if (e.name.endsWith(".ts")) {
      out.push(`${prefix}${e.name}`);
    }
  }
  return out;
}

Deno.test("only delete-account references the service-role key", async () => {
  const files = await sourceFiles(ROOT);
  assert.ok(files.length > 0);
  const offenders: string[] = [];
  for (const f of files) {
    const text = await Deno.readTextFile(new URL(f, ROOT));
    if (/SERVICE_ROLE|service_role|SECRET_KEY/.test(text) && !f.startsWith("delete-account/")) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, []);
});
