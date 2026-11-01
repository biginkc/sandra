/** Which pack/replay replies the LIVE webhook keyword gate handles before v2 ever runs (inbound.ts:401-500).
 *  Env: GATE_ITEMS=<comma list of json packs or data.json>, GATE_OUT=<json>. Skipped unless set. */
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";

import { isHostileInbound } from "@/lib/ai-responder/hostile";
import { DNC_KEYWORDS, isCarrierStopKeyword, matchesStopKeyword } from "@/lib/messaging/stop-signals";

it.skipIf(!process.env.GATE_ITEMS)("webhook gate verdicts", () => {
  const out: Record<string, string> = {};
  for (const p of process.env.GATE_ITEMS!.split(",")) {
    for (const it of JSON.parse(readFileSync(p, "utf8")) as Array<{ id?: string; run_id?: string; reply: string }>) {
      const body = it.reply; const t = body.trim();
      out[it.id ?? it.run_id!] = isCarrierStopKeyword(t) ? "carrier_stop_suppress"
        : DNC_KEYWORDS.test(body) || matchesStopKeyword(t) ? "phrase_optout_hold"
        : isHostileInbound(body) ? "hostile_hold" : "to_v2";
    }
  }
  writeFileSync(process.env.GATE_OUT!, JSON.stringify(out));
});
