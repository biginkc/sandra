import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const detailPage = readFileSync(
  new URL("./[id]/page.tsx", import.meta.url),
  "utf8",
);
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

describe("lead contact detail relationship selection", () => {
  it.each([
    ["detail page", detailPage],
    ["server actions", actions],
  ])("names the tenant-safe sidecar relationships in %s", (_name, source) => {
    expect(source).toContain(
      "homeowner_details!homeowner_details_contact_org_fkey(*)",
    );
    expect(source).toContain("agent_details!agent_details_contact_org_fkey(*)");
    expect(source).not.toMatch(/\n\s+homeowner_details\(\*\)/);
    expect(source).not.toMatch(/\n\s+agent_details\(\*\)/);
  });
});
