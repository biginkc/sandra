/** Diagnostic: capture raw Haiku text for replies that produced haiku_invalid:parser. Opt-in HAIKU_RAW=<json list of {reply,thread}>. */
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";

import { buildHaikuRequest, formatHaikuThread, HAIKU_URL, parseHaikuText } from "@/lib/sms-classification/routing-v2/haiku";

it.skipIf(!process.env.HAIKU_RAW)("raw haiku", async () => {
  const key = readFileSync(process.env.ANTHROPIC_KEY_FILE!, "utf8").trim();
  const cases = JSON.parse(readFileSync(process.env.HAIKU_RAW!, "utf8")) as Array<{ reply: string; thread: string[] }>;
  const out: unknown[] = [];
  for (const c of cases) for (let k = 0; k < 4; k++) {
    const msgs = c.thread.slice(0, -1).map((l) => l.startsWith("SELLER:") ? { direction: "inbound" as const, body: l.slice(7).trim() } : { direction: "outbound" as const, body: l.replace(/^US:\s*/, "") });
    const lines = formatHaikuThread([...msgs, { direction: "inbound", body: c.reply }]);
    const res = await fetch(HAIKU_URL, { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(buildHaikuRequest(lines)) });
    const j = (await res.json()) as { content?: Array<{ text?: string }>; stop_reason?: string };
    const text = (j.content ?? []).map((b) => b.text ?? "").join("");
    out.push({ reply: c.reply.slice(0, 50), stop: j.stop_reason, ok: parseHaikuText(text).ok, text: text.slice(0, 300) });
  }
  writeFileSync(process.env.HAIKU_RAW_OUT!, JSON.stringify(out, null, 1));
}, 300_000);
