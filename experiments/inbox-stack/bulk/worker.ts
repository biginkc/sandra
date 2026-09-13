import http from "node:http";
import * as restate from "@restatedev/restate-sdk";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import { pool, assertFixtureDatabase } from "../shared/database.js";
import { mutateStep } from "./domain.js";
await assertFixtureDatabase();
const InboxOperation = restate.service({
  name: "InboxOperation",
  handlers: {
    run: async (
      ctx: restate.Context,
      { operationId }: { operationId: string },
    ) => {
      const info = await ctx.run("load-command", async () => {
        const o = (
          await pool.query(
            "SELECT command FROM inbox_t1.bulk_operations WHERE id=$1",
            [operationId],
          )
        ).rows[0];
        const t = await pool.query(
          "SELECT property_id FROM inbox_t1.bulk_targets WHERE operation_id=$1 ORDER BY property_id",
          [operationId],
        );
        if (!o) throw new restate.TerminalError("operation unavailable");
        return {
          command: o.command,
          targets: t.rows.map((r) => r.property_id as string),
        };
      });
      for (const property of info.targets) {
        await ctx.run("outcome:" + property, () =>
          mutateStep(operationId, property, "outcome"),
        );
        if (info.command.fault === "between_steps")
          await ctx.run("between-steps", async () => {
            const q = await pool.query(
              "UPDATE inbox_t1.bulk_operations SET fault_fired=true WHERE id=$1 AND NOT fault_fired RETURNING id",
              [operationId],
            );
            if (q.rowCount) throw Error("synthetic failure between steps");
            return true;
          });
        if (info.command.assignedUserId)
          await ctx.run("assignment:" + property, () =>
            mutateStep(operationId, property, "assignment"),
          );
      }
      return await ctx.run("finalize", async () => {
        await pool.query(
          "UPDATE inbox_t1.bulk_operations SET state=CASE WHEN EXISTS(SELECT 1 FROM inbox_t1.bulk_receipts WHERE operation_id=$1 AND state<>'completed') THEN 'partial' ELSE 'completed' END WHERE id=$1",
          [operationId],
        );
        return { operationId };
      });
    },
  },
});
http
  .createServer(createEndpointHandler({ services: [InboxOperation] }))
  .listen(58788, "127.0.0.1", () =>
    console.log("Fixture Restate worker 58788"),
  );
