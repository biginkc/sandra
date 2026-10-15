#!/usr/bin/env tsx
/**
 * npm run replay:nine -- --db-url <source-db-url> [--days 30] [--org <uuid>]
 *                        [--sample 30] [--repeats 3] [--dry-run] [--max-usd 30]
 *
 * Nine-question replay (Messages v2 PR 3). READ-ONLY on the source database
 * (begin transaction read only, always rolled back). Sends are impossible:
 * the only network target is api.typesafe.ai (POST), the harness env guards
 * (stub flag, no SMS-provider credentials) are enforced, and a hard request
 * ceiling is computed from the real inbound count before any paid call.
 * The TypeSafe key is read at run time with `op read` and never printed.
 * --dry-run extracts and prints the plan and estimate without any paid call.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Client } from "pg";

import { classifyNineQuestions, type NineQuestionResult } from "../../../src/lib/sms-classification/nine-questions";
import { fail, loadMaskSalt, redactDbUrl, REPLAY_DIR } from "./cli";
import { withReadOnlyTransaction } from "./db";
import { PhoneMasker } from "./mask";
import {
  COST_CAP_USD,
  estimateCost,
  flipRate,
  guardedFetch,
  renderReport,
  requestPlan,
  sampleIndices,
  scoreRow,
  sanitizeText,
  summarizeScores,
  type DisagreementRow,
  type NineSample,
} from "./nine-core";
import { applyStubEnv, assertHarnessEnv, readProdRefs } from "./safety";

const OP_REF = "op://BMH Secrets/TypeSafe - Jev API Key/credential";

const SQL = `
  with inb as (
    select m.id, m.org_id, m.body, m.created_at, m.property_id, m.conversation_id, m.contact_id,
           row_number() over (partition by m.property_id order by m.created_at desc, m.id desc) as rn_desc
      from public.messages m
     where m.channel = 'sms' and m.direction = 'inbound'
       and m.created_at >= $1 and m.created_at < $2
       and ($3::uuid is null or m.org_id = $3::uuid)
  )
  select i.id, i.body, i.created_at, (i.rn_desc = 1 and i.property_id is not null) as is_last,
         p.outreach_dispo, p.status, c.first_name, c.last_name,
         (select o.body from public.messages o
           where o.org_id = i.org_id and o.channel = 'sms' and o.direction = 'outbound'
             and o.conversation_id = i.conversation_id and o.created_at < i.created_at
           order by o.created_at desc, o.id desc limit 1) as prev_outbound
    from inb i
    left join public.properties p on p.id = i.property_id and p.org_id = i.org_id
    left join public.contacts c on c.id = i.contact_id and c.org_id = i.org_id
   order by i.created_at asc, i.id asc`;

function readJevKey(): string {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) fail("OP_SERVICE_ACCOUNT_TOKEN is not set; run from a login shell");
  try {
    return execFileSync("op", ["read", OP_REF], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return fail("could not read the TypeSafe key with op read");
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "db-url": { type: "string" },
      days: { type: "string", default: "30" },
      org: { type: "string" },
      sample: { type: "string", default: "30" },
      repeats: { type: "string", default: "3" },
      "max-usd": { type: "string", default: String(COST_CAP_USD) },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string", default: ".planning/messages-v2/REPLAY-NINE-QUESTIONS.md" },
    },
  });
  const dbUrl = values["db-url"] ?? process.env.REPLAY_SOURCE_DB_URL;
  if (!dbUrl) fail("--db-url (or REPLAY_SOURCE_DB_URL) is required");
  const days = Number(values.days);
  const sampleN = Number(values.sample);
  const repeats = Number(values.repeats);
  const maxUsd = Math.min(Number(values["max-usd"]), COST_CAP_USD);
  if (!(days >= 1 && days <= 120)) fail("--days must be 1..120");

  applyStubEnv(process.env);
  assertHarnessEnv(process.env);
  void readProdRefs(process.cwd());

  const now = new Date();
  const start = new Date(now.getTime() - days * 86_400_000);
  console.log(`nine: source ${redactDbUrl(dbUrl)} (read-only transaction)`);
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  let rows: Record<string, unknown>[];
  try {
    rows = await withReadOnlyTransaction(
      client,
      async (query) => (await query(SQL, [start.toISOString(), now.toISOString(), values.org ?? null])).rows,
      { statementTimeoutMs: 120_000 },
    );
  } finally {
    await client.end();
  }

  const masker = new PhoneMasker(loadMaskSalt(), [], true);
  const samples: NineSample[] = rows.map((r, idx) => {
    const names = [r.first_name as string | null, r.last_name as string | null];
    const clean = (t: string) => sanitizeText(masker, t, names);
    return {
      idx,
      reply: clean(String(r.body ?? "")),
      ourLastText: r.prev_outbound == null ? null : clean(String(r.prev_outbound)),
      humanDispo: (r.outreach_dispo as string | null) ?? null,
      humanStatus: (r.status as string | null) ?? null,
      isLastForProperty: r.is_last === true,
    };
  });

  const plan = requestPlan(samples.length, sampleN, repeats);
  const est = estimateCost(plan.ceiling);
  console.log(`nine: ${samples.length} inbound texts; plan main=${plan.main} flip=${plan.flip} ceiling=${plan.ceiling}; estimate $${est.usd.toFixed(4)} (cap $${maxUsd})`);
  if (est.usd > maxUsd) fail(`estimate $${est.usd.toFixed(2)} exceeds cap $${maxUsd}; stopping before any paid call`);
  if (values["dry-run"]) return;

  const apiKey = readJevKey();
  const guard = guardedFetch(fetch, plan.ceiling);
  const deps = { fetch: guard.fetch, apiKey };
  const classify = (s: NineSample) =>
    classifyNineQuestions({ our_last_text_to_homeowner: s.ourLastText, homeowner_reply: s.reply }, deps);

  const results: NineQuestionResult[] = [];
  const failures: number[] = [];
  const CONC = 8;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (next < samples.length) {
        const i = next++;
        try {
          results[i] = await classify(samples[i]);
        } catch (e) {
          failures.push(i);
          if (e instanceof Error && /ceiling|auth|billing/i.test(e.message)) throw e;
        }
        if (i % 200 === 0) console.log(`nine: ${i}/${samples.length}`);
      }
    }),
  );
  if (failures.length) console.log(`nine: ${failures.length} requests failed and are excluded`);

  const scored = samples.flatMap((s, i) => (results[i] ? [{ s, r: results[i], row: scoreRow(s, results[i].answer) }] : []));
  const stats = summarizeScores(scored.map((x) => x.row));
  const disagreements: DisagreementRow[] = scored
    .filter((x) => x.row.agrees === false)
    .map((x) => ({
      idx: x.s.idx,
      reply: x.s.reply,
      ourLastText: x.s.ourLastText,
      answer: x.r.answer,
      group: x.row.group!,
      probs: x.r.probabilities,
    }));

  // Flip rate: sampled texts, N fresh runs.
  const picked = sampleIndices(samples.length, sampleN);
  const runs: string[][] = [];
  for (let k = 0; k < repeats; k++) {
    const run: string[] = [];
    for (const i of picked) run.push((await classify(samples[i])).answer);
    runs.push(run);
  }
  const flip = { ...flipRate(runs), runs: repeats };

  const md = renderReport({
    stats,
    dateRange: { start: start.toISOString(), end: now.toISOString() },
    estimate: { requests: plan.ceiling, usd: est.usd, inputTokens: est.inputTokens, ceiling: plan.ceiling },
    actualRequests: guard.count(),
    flip,
    disagreements,
    generatedAt: now.toISOString(),
  });
  const out = path.resolve(values.out!);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, md);
  mkdirSync(REPLAY_DIR, { recursive: true });
  // Per-text probabilities (masked texts) go to gitignored tmp/, never committed.
  const probsFile = path.join(REPLAY_DIR, "nine-probabilities.json");
  writeFileSync(
    probsFile,
    JSON.stringify(scored.map((x) => ({ idx: x.s.idx, reply: x.s.reply, ourLastText: x.s.ourLastText, human: x.row.group, answer: x.r.answer, probabilities: x.r.probabilities })), null, 1),
    { mode: 0o600 },
  );
  console.log(`nine: probabilities ${probsFile}`);
  console.log(`nine: wrote ${out}; requests ${guard.count()}; agreement ${stats.agree}/${stats.labeled}; flip ${flip.flipped}/${flip.samples}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
