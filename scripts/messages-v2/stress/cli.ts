#!/usr/bin/env tsx
/**
 * Messages v2 Stage 5: wording x repeat matrix, CLASSIFIER lane.
 *
 *   npm run stress:messages-v2 -- --classifier stub [--noise 0.05] [--repeats 3] [--seed 20261015]
 *   npm run stress:messages-v2 -- --classifier live --repeats 3 [--max-usd 1]
 *
 * Runs every (scenario, wording) `repeats` times through the nine questions and reports, per
 * scenario, the flip rate (same text, different answer) and the wrong-bucket rate (the bucket
 * predicted by the dispatch-precedence mirror in core.ts). The dispatch lane
 * (dispatch.stress.integration.test.ts) is the authoritative bucket check; this lane is the
 * cheap, DB-free one.
 *
 * Sends are impossible here by construction: there is no database, no SMS provider and the
 * only network target is api.typesafe.ai (POST, hard request ceiling; replay/nine-core
 * guardedFetch). `stub` makes no network call at all. The TypeSafe key is read with `op read`
 * at run time and never printed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { classifyNineQuestions, type NineAnswer } from "../../../src/lib/sms-classification/nine-questions";
import { guardedFetch } from "../replay/nine-core";
import { applyStubEnv, assertHarnessEnv } from "../replay/safety";
import { loadCorpus } from "./corpus";
import { estimateJevCost, mulberry32, predictBucket, predictOutcomeV1Bucket, renderReport, stubAnswer, summarize, type RunRow } from "./core";

const OP_REF = "op://BMH Secrets/TypeSafe - Jev API Key/credential";
const OUT_ROOT = path.resolve(process.cwd(), "tmp/stress");

function fail(msg: string): never {
  console.error(`stress: ${msg}`);
  process.exit(1);
}

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
      classifier: { type: "string", default: "stub" },
      noise: { type: "string", default: "0" },
      repeats: { type: "string", default: "3" },
      seed: { type: "string", default: "20261015" },
      "max-usd": { type: "string", default: "1" },
      concurrency: { type: "string", default: "6" },
      only: { type: "string" },
      out: { type: "string" },
    },
  });
  const classifier = values.classifier;
  if (classifier !== "stub" && classifier !== "live") fail("--classifier must be stub or live");
  const repeats = Number(values.repeats);
  if (!(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10)) fail("--repeats must be 1..10");
  const noise = Number(values.noise);
  if (!(noise >= 0 && noise <= 1)) fail("--noise must be 0..1");
  const maxUsd = Number(values["max-usd"]);

  // Same rails as the replay: stub flag on, no seller-SMS provider credential in this process.
  applyStubEnv(process.env);
  assertHarnessEnv(process.env);

  const all = loadCorpus();
  // outcome_v1 scenarios are stub-only here: the live lane calls the nine questions, which cannot
  // answer dnc / bad_number. Their classifier-lane rows only exercise the mirror; dispatch is authoritative.
  const laneSkip = (s: (typeof all)[number]) => s.db_only === true || (classifier === "live" && s.jev_engine === "outcome_v1");
  const scenarios = all.filter((s) => !laneSkip(s) && (!values.only || values.only.split(",").includes(s.id)));
  const skipped = all.filter(laneSkip).map((s) => s.id);
  const jobs = scenarios.flatMap((s) => s.wordings.flatMap((w, wordingIdx) => Array.from({ length: repeats }, (_, repeat) => ({ s, w, wordingIdx, repeat }))));
  const est = estimateJevCost(jobs.length);
  console.log(`stress: ${scenarios.length} scenarios x 10 wordings x ${repeats} repeats = ${jobs.length} runs; classifier=${classifier}; Jev estimate $${est.usd.toFixed(4)} (cap $${maxUsd})`);
  if (skipped.length) console.log(`stress: dispatch-lane-only scenarios skipped here: ${skipped.join(", ")}`);
  if (classifier === "live" && est.usd > maxUsd) fail(`estimate $${est.usd.toFixed(4)} exceeds --max-usd ${maxUsd}; stopping before any paid call`);

  const rnd = mulberry32(Number(values.seed));
  let made = 0;
  let classify: (s: (typeof jobs)[number]) => Promise<NineAnswer>;
  if (classifier === "stub") {
    classify = async (j) => stubAnswer(j.s.expected_answers, { noise, rnd }).answer;
  } else {
    const apiKey = readJevKey();
    const guard = guardedFetch(fetch, jobs.length);
    classify = async (j) => {
      const r = await classifyNineQuestions({ our_last_text_to_homeowner: j.s.our_last_text, homeowner_reply: j.w }, { fetch: guard.fetch, apiKey });
      made = guard.count();
      return r.answer;
    };
  }

  const rows: RunRow[] = new Array(jobs.length);
  const conc = classifier === "stub" ? 1 : Math.max(1, Math.min(8, Number(values.concurrency)));
  let next = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < jobs.length) {
        const i = next++;
        const j = jobs[i]!;
        try {
          if (j.s.jev_engine === "outcome_v1") {
            // Fixture outcome from the corpus (no Jev call); the up-front keyword gate still applies.
            rows[i] = { scenarioId: j.s.id, wordingIdx: j.wordingIdx, repeat: j.repeat, answer: null, bucket: predictOutcomeV1Bucket(j.s.stub_outcome!, j.w, j.s.org_escalation_keywords) };
            continue;
          }
          const answer = await classify(j);
          rows[i] = { scenarioId: j.s.id, wordingIdx: j.wordingIdx, repeat: j.repeat, answer, bucket: predictBucket(answer, j.w, j.s.org_escalation_keywords) };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/ceiling|auth|billing/i.test(msg)) throw e;
          rows[i] = { scenarioId: j.s.id, wordingIdx: j.wordingIdx, repeat: j.repeat, answer: null, bucket: "other:failed", failed: msg };
        }
        if (classifier === "live" && i % 100 === 0) console.log(`stress: ${i}/${jobs.length}`);
      }
    }),
  );

  const summary = summarize(scenarios, rows);
  const generatedAt = new Date().toISOString();
  const md = renderReport({ lane: "classifier", classifier, summary, repeats, requests: { made, estimateUsd: est.usd }, generatedAt });
  const outDir = values.out ? path.resolve(values.out) : path.join(OUT_ROOT, `classifier-${classifier}-${generatedAt.replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "report.md"), md);
  writeFileSync(path.join(outDir, "rows.json"), JSON.stringify({ classifier, repeats, noise, seed: values.seed, rows, summary }, null, 1));
  console.log(md);
  console.log(`stress: wrote ${outDir}/report.md and rows.json; Jev requests made: ${made}`);
  process.exitCode = summary.allGatesPass ? 0 : 2;
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
