import { describe, expect, it } from "vitest";

import { runRandomRun } from "./driver";
import { Harness } from "./harness";
import { checkInvariants, startHoldPoller } from "./invariants";
import { rng } from "./trace";

/**
 * Randomised stress run (PLAN.md section 9). Replay a failure with
 *   NORMA_STRESS_SEED=<seed> npm run test:norma-stress
 * NORMA_STRESS_LIFECYCLES sets lifecycles per seed. A seed reproduces the
 * inputs; database scheduling is real and can differ, so a replay may need a
 * few attempts, and the barrier tests in races.integration.test.ts cover the
 * named interleavings deterministically.
 */
const seeds = process.env.NORMA_STRESS_SEED
  ? process.env.NORMA_STRESS_SEED.split(",").map((s) => Number(s.trim()))
  : [101, 202, 303, 404, 505];
const perSeed = Number(process.env.NORMA_STRESS_LIFECYCLES ?? 80);

describe("norma stress gate: randomised lifecycles", () => {
  for (const seed of seeds) {
    it(`seed ${seed}: ${perSeed} lifecycles, zero invariant violations`, async () => {
      const h = await Harness.create(rng(seed));
      const poller = startHoldPoller(h);
      try {
        const run = await runRandomRun(h, seed, perSeed);
        await poller.stop();
        const { violations, stats } = await checkInvariants(h, { settled: true });
        const all = [...violations, ...poller.violations];
        // eslint-disable-next-line no-console
        console.log(`[norma-stress] seed=${seed} lifecycles=${run.lifecycles} ${JSON.stringify(stats)}`);
        if (all.length) {
          const detailIds = [...new Set(all.flatMap((v) => [...v.matchAll(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi)].map((m) => m[0])))].slice(0, 25);
          const diagnostics = await Promise.all(detailIds.map(async (id) => {
            const request = (await h.scratch.pool.query("select * from public.norma_call_requests where id = $1", [id])).rows[0];
            const audit = (await h.scratch.pool.query("select seq, txid, old_row, new_row from stress.audit where tbl = 'norma_call_requests' and row_id = $1 order by seq", [id])).rows;
            const reviews = h.reviews.filter((r) => r.requestId === id);
            const sends = h.bland.sendsFor(id);
            const trace = h.trace.events.filter((e) => {
              const args = e.detail?.args as { p_request_id?: unknown } | undefined;
              return args?.p_request_id === id || e.detail?.requestId === id || e.detail?.request_id === id;
            });
            return `request ${id}\n  row=${JSON.stringify(request)}\n  reviews=${JSON.stringify(reviews)}\n  sends=${JSON.stringify(sends)}\n  audit=${JSON.stringify(audit)}\n  trace=${JSON.stringify(trace)}`;
          }));
          const detail = [
            `FAILING SEED ${seed} (replay: NORMA_STRESS_SEED=${seed} NORMA_STRESS_LIFECYCLES=${perSeed} npm run test:norma-stress)`,
            ...[...new Set(all)].slice(0, 25),
            "--- request diagnostics ---",
            ...diagnostics,
            "--- trace tail ---",
            ...h.trace.tail(40),
          ].join("\n");
          expect.fail(detail);
        }
        expect(stats.requests).toBeGreaterThan(perSeed * 0.5);
      } finally {
        await poller.stop().catch(() => undefined);
        await h.close();
      }
    });
  }
});
