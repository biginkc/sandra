import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("lead detail loading orchestration contract", () => {
  it("keeps the record gates ahead of operational work", () => {
    const dncGate = source.indexOf("if (lead.is_dnc_locked)");
    const coreReads = source.indexOf("const coreReadsPromise = Promise.all([");
    const messageAck = source.indexOf("markMessagesReadForProperty(lead.id)");
    const messageRead = source.indexOf('.from("messages")');

    expect(dncGate).toBeGreaterThan(-1);
    expect(coreReads).toBeGreaterThan(dncGate);
    expect(messageAck).toBeGreaterThan(coreReads);
    expect(messageRead).toBeGreaterThan(messageAck);
  });

  it("observes independent reads as one batch and keeps the message snapshot behind its ack", () => {
    expect(source).toContain("const coreReadsPromise = Promise.all([");
    expect(source).toContain("await loadAfterReadAcknowledgement(");
    expect(source).toContain("return Promise.all([threadPromise, latestInboundSenderPromise]);");
    expect(
      source.indexOf("const coreReadsPromise = Promise.all([")
    ).toBeLessThan(source.indexOf("await loadAfterReadAcknowledgement("));
  });

  it("preserves the training e-sign bypass and fail-soft outcome path", () => {
    expect(source).toMatch(/training\s*\?\s*Promise\.resolve\(\{ blockers: \["sending_disabled"\]/);
    expect(source).toMatch(/try \{\s*const \[progress\] = await listDripProgress/);
    expect(source).toContain("outcomeDripUnknown = true");
    expect(source).toContain("allowMissingIdentityLabels: true");
    expect(source).toContain(".catch(() => null)");
  });
});
