import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FACT_FIELDS, FACT_LABELS, FACT_SLOTS, MOTIVATION_THRESHOLD, OBJECTION_THRESHOLD } from "./catalog";
import { APPROVED_NUMBER_QUESTIONS, APPROVED_PAIN_QUESTIONS, CLOSER_LAB_FRAMING, CLOSER_LAB_QUESTIONS } from "./question-text";

const DIR = join(process.cwd(), "src/lib/call-facts");
const read = (name: string) => readFileSync(join(DIR, "approved", name), "utf8");
const sha = (name: string) => createHash("sha256").update(readFileSync(join(DIR, "approved", name))).digest("hex");

// Byte-for-byte copies of the approved sources. Any change needs new verbatim approval from Jarrad.
const PINS: Record<string, string> = {
  // Jarrad 2026-10-05, "All are approved."
  "jev-call-facts-questions-APPROVED.md": "44cd249ab012ad5f5befb3d225f8006addd2b3e24d439d0df919f7a77f2a1c1c",
  // Closer Lab closer-lab-jev-pr-e @ fd3c8618208f5a93a62aabdf5cbcdc7e0afc2c87 (owner/manifest.json pins)
  "closer-lab-jev-line-questions.json": "54082c78d9275d1d8cf4bbca815f91e41e70acccf4f753103e2110fe68722f7e",
  "closer-lab-OWNER-BINARY-QUESTIONS.md": "4b2526bfc3732ff91ddadb7e138e18723b9c21da33918269448ce0950b0cc558",
  "closer-lab-OWNER-ADDENDA-2026-09-25.md": "72075b5ba1c1a2396962dbc885ad6bcc4c00a58865716d99df22504f4b00b97c",
  "closer-lab-OWNER-APPROVED-QUESTIONS-2026-09-28.md": "fc3901ca039c94f95d903ca31013a2e760bfcf0560da098f25175ac0a33a90c0",
  "closer-lab-OWNER-APPROVED-QUESTIONS-2026-09-28-B.md": "d47c86b3b2a4ef81c0606b12c6cefd27907811b1d630a3c35d65fecfe79cde3f",
  "closer-lab-OWNER-APPROVED-QUESTIONS-2026-09-28-C.md": "59701f5cf0a4445a042c8a25b976367262a47d7d5741e5b3ac2e398e81e64511",
};

describe("approved sources", () => {
  it.each(Object.entries(PINS))("%s matches its sha256 pin", (name, pin) => {
    expect(sha(name)).toBe(pin);
  });
});

describe("Jarrad's approved numbers/dates and pains (character for character)", () => {
  const text = read("jev-call-facts-questions-APPROVED.md");
  const numbers = Object.fromEntries(
    text.split("## Pains")[0].split("\n").filter((l) => /^[a-z_]+: /.test(l)).map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)]),
  );
  const pains = [...text.matchAll(/^P(\d+) ([a-z_]+): (.*)$/gm)].map((m) => ({ n: Number(m[1]), id: m[2], text: m[3] }));

  it("has the 5 numbers/dates questions exactly", () => {
    expect(Object.keys(numbers)).toHaveLength(5);
    expect(APPROVED_NUMBER_QUESTIONS).toEqual(numbers);
  });
  it("has the 14 pains P1-P14 exactly, in order", () => {
    expect(pains).toHaveLength(14);
    expect([...APPROVED_PAIN_QUESTIONS]).toEqual(pains);
  });
  it("each question is wired to its slot unchanged", () => {
    for (const [id, q] of Object.entries(numbers)) expect(FACT_SLOTS.find((s) => s.id === id && !s.field.startsWith("pain_"))?.text).toBe(q);
    for (const p of pains) expect(FACT_SLOTS.find((s) => s.field === `pain_${p.id}`)?.text).toBe(p.text);
    // behind_on_payments exists twice: the numbers/dates question and its own pain key.
    expect(FACT_SLOTS.filter((s) => s.id === "behind_on_payments").map((s) => s.field)).toEqual(["behind_on_payments", "pain_behind_on_payments"]);
  });
});

describe("Closer Lab's approved questions (reused verbatim)", () => {
  const json = JSON.parse(read("closer-lab-jev-line-questions.json")) as { template: { prefix: string; suffix: string }; questions: { id: string; name: string; question: string }[] };
  const owner = readdirSync(join(DIR, "approved")).filter((f) => f.startsWith("closer-lab-OWNER-")).map((f) => read(f)).join("\n");

  it("copies all 32 (general motivation, not_rushed, bad_experience, 29 objections) exactly", () => {
    expect(json.questions).toHaveLength(32);
    expect(CLOSER_LAB_QUESTIONS.map((q) => ({ id: q.id, name: q.name, question: q.text }))).toEqual(json.questions);
    const objections = json.questions.filter((q) => !["motivation", "not_rushed", "bad_experience"].includes(q.id));
    expect(objections).toHaveLength(29);
  });
  it("every reused text appears verbatim in the sha-pinned owner files", () => {
    for (const q of CLOSER_LAB_QUESTIONS) expect(owner).toContain(q.text);
  });
  it("keeps Closer Lab's framing template", () => {
    expect(CLOSER_LAB_FRAMING).toEqual(json.template.prefix === CLOSER_LAB_FRAMING.prefix ? { prefix: json.template.prefix, suffix: json.template.suffix } : null);
  });
  it("wires each into a line_noul slot with the approved thresholds (motivation 0.8, objection set 0.9)", () => {
    for (const q of CLOSER_LAB_QUESTIONS) {
      const slot = FACT_SLOTS.find((s) => s.id === q.id && s.kind === "line_noul")!;
      expect(slot.text).toBe(q.text);
      expect(slot.label).toBe(q.name);
      expect(slot.threshold).toBe(q.id === "motivation" ? MOTIVATION_THRESHOLD : OBJECTION_THRESHOLD);
    }
    expect(MOTIVATION_THRESHOLD).toBe(0.8);
    expect(OBJECTION_THRESHOLD).toBe(0.9);
  });
});

describe("no wording outside the approved sources", () => {
  it("only question-text.ts (and tests) contain question sentences", () => {
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "question-text.ts")) {
      expect(readFileSync(join(DIR, f), "utf8"), f).not.toMatch(/Did the seller|Does the seller/);
    }
  });
});

describe("SQL allow-list and labels match the catalog", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261007190000_call_facts.sql"), "utf8");
  it("fn_complete_call_facts allow-list equals FACT_FIELDS", () => {
    const m = /v_allowed constant text\[\] := array\[([^\]]*)\]/.exec(sql)!;
    expect([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])).toEqual([...FACT_FIELDS]);
  });
  it("fn_accept_call_fact label CASE equals FACT_LABELS", () => {
    const body = sql.slice(sql.indexOf("v_label := case p_field"), sql.indexOf("else null end;"));
    const cases = Object.fromEntries([...body.matchAll(/when '([^']+)' then '((?:[^']|'')*)'/g)].map((x) => [x[1], x[2].replace(/''/g, "'")]));
    expect(cases).toEqual(FACT_LABELS);
  });
});
