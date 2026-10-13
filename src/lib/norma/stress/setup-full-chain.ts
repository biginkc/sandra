import { execFileSync } from "node:child_process";

import { Client } from "pg";
import { vi } from "vitest";

/**
 * Full-chain stress source. The stress database clones the SOURCE schema with `pg_dump --schema-only` and then replays every
 * *_norma_*.sql by name. When the source is a run-owned stack that already has the whole chain (including the queue migrations),
 * the replay is skipped through NORMA_STRESS_EXCLUDE_MIGRATIONS, which also loses the rows those migrations seed (a schema-only
 * dump carries none). This wrapper copies exactly those seed tables from the source (data-only) and then does what db.ts does after
 * the replay: opens the separately activated retry admission. Test-only; nothing in src/** runtime changes.
 */
const SEED_TABLES = [
  "norma_state_timezones",
  "norma_queue_control",
  "norma_retry_admission",
  "norma_recording_lookup_control",
  "norma_inbound_lookup_control",
];

vi.mock("@/lib/norma/stress/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("./db")>();
  return {
    ...original,
    createScratchDb: async () => {
      const scratch = await original.createScratchDb();
      const source = process.env.NORMA_STRESS_SOURCE_DB_URL!;
      const dump = execFileSync("pg_dump", ["--data-only", "--no-owner", ...SEED_TABLES.flatMap((t) => ["-t", `public.${t}`]), source], { maxBuffer: 64 * 1024 * 1024 });
      execFileSync("psql", ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-d", scratch.url], { input: dump, maxBuffer: 64 * 1024 * 1024 });
      const c = new Client({ connectionString: scratch.url });
      await c.connect();
      try {
        await c.query("update public.norma_retry_admission set enabled=true where singleton=true");
      } finally {
        await c.end();
      }
      return scratch;
    },
  };
});
