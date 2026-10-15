import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const read = source.slice(source.indexOf("let homeownerHouses"), source.indexOf("// Outcome bar"));

describe("lead page Owns N houses contract", () => {
  it("reads the homeowner's houses on the viewer's own client, scoped to the lead's org", () => {
    expect(read).toContain("loadHomeownerHouses(supabase as unknown as HousesClient");
    expect(read).toContain("orgId: lead.org_id");
    expect(read).toContain("contactIds: [lead.homeowner.id]");
    expect(read).not.toMatch(/service|admin/i);
  });
  it("shows no badge when the read fails instead of failing the page", () => {
    expect(read).toMatch(/try \{[\s\S]*\} catch \(error\)/);
  });
  it("puts the badge in the header next to the homeowner", () => {
    expect(source).toContain("<MultiHouseBadge houses={homeownerHouses} ownerName={homeownerName} currentPropertyId={lead.id}");
    const hero = source.indexOf("<LeadMediaHero");
    expect(source.slice(hero, source.indexOf("/>", hero))).toMatch(/homeownerName=\{homeownerName\}\s*ownerBadge=\{ownerBadge\}/);
  });
});
