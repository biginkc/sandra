/** Offline only: emit versioned requests for a separately authorized model evaluation.
 * No API calls, credentials, database access, or production writes. */
import { writeFileSync } from "node:fs";
import { buildQuestions, JEV_MODEL, JEV_SCHEMA_VERSION, JEV_POLICY_VERSION } from "../src/lib/sms-classification/questions";
import cases from "../src/lib/sms-classification/__fixtures__/new-lead-cases.json";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: npx tsx scripts/prepare-jev-new-lead-eval.ts <output.json>");
writeFileSync(destination, JSON.stringify({
  schemaVersion: JEV_SCHEMA_VERSION,
  policyVersion: JEV_POLICY_VERSION,
  note: "Synthetic/paraphrased patterns, not exact historical inputs or independent holdout. Not yet evaluated by Jev.",
  cases: cases.map(({ id, expected, thread }) => ({
    id, expected,
    request: { model: JEV_MODEL, state: { thread }, questions: buildQuestions(false) },
  })),
}, null, 2) + "\n", { flag: "wx" });
console.log(`Prepared ${cases.length} offline requests. No model calls made.`);
