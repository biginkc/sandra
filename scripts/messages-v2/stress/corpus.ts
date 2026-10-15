import { readFileSync } from "node:fs";
import path from "node:path";

import { NINE_QUESTION_IDS } from "../../../src/lib/sms-classification/nine-questions";
import { BUCKETS, type Scenario } from "./core";

export const CORPUS_PATH = path.resolve(__dirname, "corpus.json");

type RawScenario = Omit<Scenario, "our_last_text"> & { opener: string };
type RawCorpus = { openers: Record<string, string>; scenarios: RawScenario[] };

const ANSWERS = new Set<string>([...NINE_QUESTION_IDS, "needs_person"]);
const BUCKET_SET = new Set<string>(BUCKETS);

/** Load and validate corpus.json. Throws on any shape problem: a bad corpus must never run. */
export function loadCorpus(file: string = CORPUS_PATH): Scenario[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as RawCorpus;
  if (!raw.openers || !Array.isArray(raw.scenarios)) throw new Error("corpus: openers/scenarios missing");
  const ids = new Set<string>();
  return raw.scenarios.map((s) => {
    if (!/^[a-z0-9_]+$/.test(s.id)) throw new Error(`corpus: bad id ${s.id}`);
    if (ids.has(s.id)) throw new Error(`corpus: duplicate id ${s.id}`);
    ids.add(s.id);
    const our_last_text = raw.openers[s.opener];
    if (!our_last_text) throw new Error(`corpus ${s.id}: unknown opener ${s.opener}`);
    if (!Array.isArray(s.wordings) || s.wordings.length !== 10) throw new Error(`corpus ${s.id}: exactly 10 wordings required`);
    if (new Set(s.wordings).size !== 10) throw new Error(`corpus ${s.id}: wordings must be distinct`);
    for (const w of s.wordings) if (typeof w !== "string" || w.trim() === "") throw new Error(`corpus ${s.id}: empty wording`);
    if (s.expected_answers !== null) {
      if (!Array.isArray(s.expected_answers) || s.expected_answers.length === 0) throw new Error(`corpus ${s.id}: expected_answers`);
      for (const a of s.expected_answers) if (!ANSWERS.has(a)) throw new Error(`corpus ${s.id}: unknown answer ${a}`);
    }
    if (!Array.isArray(s.expected_buckets) || s.expected_buckets.length === 0) throw new Error(`corpus ${s.id}: expected_buckets`);
    for (const b of s.expected_buckets) if (!BUCKET_SET.has(b)) throw new Error(`corpus ${s.id}: unknown bucket ${b}`);
    if (s.expected_buckets.length > 1 && !s.review && !s.known_gap) {
      throw new Error(`corpus ${s.id}: more than one accepted bucket needs a review or known_gap note`);
    }
    const { opener, ...rest } = s;
    void opener;
    return { ...rest, our_last_text };
  });
}
