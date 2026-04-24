#!/usr/bin/env tsx
/**
 * AI responder — local smoke against the real Anthropic API.
 *
 * Proves the parts the unit + integration tests skip:
 *   1. The Anthropic SDK actually loads + the API key works.
 *   2. Our tool-use schema in `generate.ts` parses against real Claude.
 *   3. The structured output we expect (action / body / confidence /
 *      sentiment / escalation_reason) actually comes back.
 *   4. Prompt caching is set up correctly (run twice, watch the
 *      `cache_read_input_tokens` jump on the second call).
 *
 * Cost: ~$0.001-0.002 per run (Haiku 4.5, ~800 token system prompt
 * cached after first run, ~50 token user message).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/smoke-ai-responder.ts
 *   (or put ANTHROPIC_API_KEY in .env.local and run without the prefix)
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

import { generateAiReply } from "../src/lib/ai-responder/generate";

function loadLocalEnv(file: string): Record<string, string> {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadLocalEnv(".env.local"), ...process.env };
if (!env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Add it to .env.local or pass it inline:\n" +
      "  ANTHROPIC_API_KEY=sk-... npx tsx scripts/smoke-ai-responder.ts",
  );
  process.exit(2);
}

const SYSTEM_PROMPT =
  "You are a real estate acquisition assistant for BMH Group, a wholesale " +
  "real-estate investor that buys distressed properties for cash. You text " +
  "with property owners who recently received our outreach.\n\n" +
  "Your job is FIRST-TOUCH only: acknowledge the seller's reply, gather " +
  "light qualifying info (motivation to sell, timeline, property condition), " +
  "and hand warm leads to a human teammate.\n\n" +
  "You MUST NOT:\n" +
  "- Quote any price, range, or offer. Ever. Not even a ballpark.\n" +
  "- Make any commitment about purchase, timeline, or process.\n" +
  "- Discuss legal, tax, or financial advice.\n" +
  "- Promise anything — no \"we will\", no \"we can\", no \"we'll definitely\".\n\n" +
  "If the seller asks for a price, mentions a lawyer / attorney / contract / " +
  "closing / probate / divorce / bankruptcy / foreclosure, or sounds " +
  "frustrated or upset, ESCALATE.\n\n" +
  "Keep replies under 160 characters. Sound like a friendly human, not a " +
  "corporate bot. No emojis.";

type Scenario = {
  label: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  expect: "send_reply" | "escalate";
};

const SCENARIOS: Scenario[] = [
  {
    label: "neutral first-touch",
    conversation: [{ role: "user", content: "Yeah, what's this about?" }],
    expect: "send_reply",
  },
  {
    label: "explicit handoff request → should escalate",
    conversation: [{ role: "user", content: "Just have a real person call me." }],
    expect: "escalate",
  },
  {
    label: "asks for price → should escalate",
    conversation: [{ role: "user", content: "What's your offer on the house?" }],
    expect: "escalate",
  },
];

async function main() {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = "claude-haiku-4-5-20251001";

  console.log(`\nAI responder smoke — model: ${model}\n${"=".repeat(60)}`);

  for (const s of SCENARIOS) {
    const t0 = Date.now();
    try {
      const out = await generateAiReply(
        {
          model,
          systemPrompt: SYSTEM_PROMPT,
          conversation: s.conversation,
        },
        { client },
      );
      const ms = Date.now() - t0;
      const matches = out.action === s.expect;
      console.log(`\n[${matches ? "OK " : "??"}] ${s.label}  (${ms}ms)`);
      console.log(`     inbound:    "${s.conversation[0].content}"`);
      console.log(`     action:     ${out.action} ${matches ? "" : `(expected ${s.expect})`}`);
      console.log(`     confidence: ${out.confidence}`);
      console.log(`     sentiment:  ${out.sentiment}`);
      if (out.action === "send_reply") {
        console.log(`     body:       "${out.body}"`);
        console.log(`     length:     ${out.body?.length ?? 0} chars (limit 160)`);
      } else {
        console.log(`     reason:     ${out.escalation_reason}`);
      }
    } catch (e) {
      console.error(`\n[FAIL] ${s.label}`);
      console.error(e);
      process.exitCode = 1;
    }
  }

  console.log(
    `\n${"=".repeat(60)}\nDone. Run twice in a row to confirm prompt cache:\n` +
      `the second run should be noticeably faster on each scenario.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
