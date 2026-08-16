import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("Prospects durable suppression display contract", () => {
  it("matches phone suppressions by organization and SMS channel", () => {
    expect(source).toContain('"id, org_id, address');
    expect(source).toContain('.select("org_id, phone_e164")');
    expect(source).toContain('.eq("channel", "sms")');
    expect(source).toContain('suppressedPhones.has(`${p.org_id}:${phone}`)');
  });
});
