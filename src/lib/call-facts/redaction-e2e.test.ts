import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createFactsExtractorFromEnv } from "./jev-facts";
import { FACT_QUESTIONS } from "./questions";
import { runCallFactsSweep, type ClaimedCall } from "./run";

// Every identity shape from the acceptance matrix in one claim.
const LEAD = ["Maria Gomez", "Tom Heir", "Sally", "José Núñez", "Smith Family Trust", "Seller-Jones"];
const REP = ["Rick Rep", "Ricky R", "Dana Q", "tom.baker", "Hugo Lane", "Richard Roe", "Rich", "Sam Old", "ops7"];
const NAME_WORDS = ["maria", "gomez", "heir", "sally", "jos", "núñez", "smith", "jones", "rick", "ricky", "dana", "baker", "hugo", "richard", "roe", "tom", "jarrad", "henry"];

const claim: ClaimedCall = {
  fact_id: "f1", claim_token: "t1", call_activity_id: "a1",
  summary: "Rick Rep spoke with Sally about Rick's offer; Maria Gomez owns half; Dana Q followed up.",
  transcript: [
    "Ricky R: hey this is Ricky, calling about the house",
    "Sally Seller-Jones: hi rick, I want $185,000 for the house, call me Friday at 816-555-0142",
    "Tom Heir: my sister Maria owns half, I am Tom",
    "Dana Q: ask for Dana or Hugo Lane or tom baker",
    "Jarrad Henry: Richard would call, Rich said so, Sam called last week",
    "José Núñez: the Smith Family Trust owns it, Seller Jones too",
  ].join("\n"),
  contact_names: LEAD, rep_names: REP,
  property_address: "12 Elm Dr", property_city: "Kansas City", property_zip: "64111",
  ended_at: "2026-10-07T15:00:00Z",
};

function recorder() {
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ answers: {} }), { status: 200 });
  });
  return { bodies, fetchImpl };
}

const wordsIn = (s: string) => new Set((s.toLowerCase().normalize("NFKC").match(/[\p{L}\p{M}]+/gu) ?? []));

describe("every outgoing Jev request is free of known names (real extractor, recorded fetch)", () => {
  it("covers the choice request and every per-turn yes/no request, across all identity shapes", async () => {
    const { bodies, fetchImpl } = recorder();
    const extractor = createFactsExtractorFromEnv({ TYPESAFE_API_KEY: "k" }, FACT_QUESTIONS, fetchImpl as never);
    expect(extractor).not.toBeNull();
    const complete = vi.fn(async () => undefined);
    const out = await runCallFactsSweep(1, { claim: async () => ({ claims: [claim], exhausted: [] }), complete, extractor, now: () => new Date("2026-10-07T15:00:00Z") });
    expect(out).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(bodies.length).toBeGreaterThan(2); // one choice request plus per-turn noul requests
    for (const body of bodies) {
      const seen = wordsIn(body);
      for (const name of NAME_WORDS) expect(seen.has(name), `"${name}" leaked into a Jev request`).toBe(false);
      expect(body).not.toMatch(/816-555-0142|12 Elm/);
    }
    // The text that does go out still carries the facts.
    expect(bodies.some((b) => b.includes("$185,000"))).toBe(true);
  });

  it("row 18 (end to end): a masking miss trips the leak scan; Jev is never called and the claim is not completed", async () => {
    const { bodies, fetchImpl } = recorder();
    const extractor = createFactsExtractorFromEnv({ TYPESAFE_API_KEY: "k" }, FACT_QUESTIONS, fetchImpl as never);
    const complete = vi.fn(async () => undefined);
    const report = vi.fn();
    const out = await runCallFactsSweep(1, {
      claim: async () => ({ claims: [claim], exhausted: [] }), complete, extractor, report,
      maskText: (input) => input, // a masker that misses everything
    });
    expect(out).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(bodies).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(String((report.mock.calls[0][0] as Error).message)).not.toMatch(/maria|rick|sally/i);
  });
});

describe("one TypeSafe path for call facts", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
    });
  it("askJev( is called only by jev-facts.ts (facts) and its own gateway (SMS classification)", () => {
    const hits = walk(join(process.cwd(), "src")).filter((f) => /\baskJev\(/.test(readFileSync(f, "utf8"))).map((f) => f.replace(process.cwd() + "/", ""));
    expect(hits.sort()).toEqual(["src/lib/call-facts/jev-facts.ts", "src/lib/sms-classification/providers/jev-gateway.ts"]);
  });
});
