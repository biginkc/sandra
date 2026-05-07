import { describe, expect, it } from "vitest";

import { bmhAgentOutreachPreset } from "./bmh-agent-outreach";

const HEADERS = [
  "Property Address", "First Name", "Last Name", "Phone", "Email",
  "Link", "Status", "Follow Up", "Lead Source", "Date Created", "County",
];

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Property Address": "123 Main St, Kansas City, MO 64108",
    "First Name": "Jane",
    "Last Name": "Smith",
    "Phone": "816-555-1001",
    "Email": "jane@example.com",
    "Link": "https://realtor.com/123",
    "Status": "Offer Sent",
    "Follow Up": "Follow up Needed",
    "Lead Source": "realtor.com",
    "Date Created": "February 8, 2026",
    "County": "Clay County",
    ...overrides,
  };
}

describe("bmhAgentOutreachPreset.detect", () => {
  it("returns ≥ 0.95 for all 11 headers", () => {
    const r = bmhAgentOutreachPreset.detect(HEADERS, []);
    expect(r?.id).toBe("bmh_outreach");
    expect(r?.confidence).toBeGreaterThanOrEqual(0.95);
  });
  it("8-of-11 signature → ≥ 0.7", () => {
    const partial = HEADERS.slice(0, 8);
    const r = bmhAgentOutreachPreset.detect(partial, []);
    expect(r?.confidence ?? 0).toBeGreaterThanOrEqual(0.7);
  });
  it("5-of-11 signature → < 0.7", () => {
    const partial = HEADERS.slice(0, 5);
    const r = bmhAgentOutreachPreset.detect(partial, []);
    expect(r?.confidence ?? 0).toBeLessThan(0.7);
  });
  it("accepts 'First Seen' as alternative to 'Lead Source'", () => {
    const old = HEADERS.filter((h) => h !== "Lead Source").concat("First Seen");
    const r = bmhAgentOutreachPreset.detect(old, []);
    expect(r?.confidence).toBeGreaterThanOrEqual(0.95);
  });
  it("empty headers → null", () => {
    expect(bmhAgentOutreachPreset.detect([], [])).toBeNull();
  });
});

describe("bmhAgentOutreachPreset.transform", () => {
  it("splits parseable Property Address into address/city/state/zip", () => {
    const r = bmhAgentOutreachPreset.transform([row()], HEADERS);
    expect(r.rows[0].address).toBe("123 Main St");
    expect(r.rows[0].city).toBe("Kansas City");
    expect(r.rows[0].state).toBe("MO");
    expect(r.rows[0].zip).toBe("64108");
    expect(r.rows[0]["Property Address"]).toBeUndefined();
  });
  it("keeps unparseable Property Address as address_full", () => {
    const r = bmhAgentOutreachPreset.transform(
      [row({ "Property Address": "Weston, MO 64098" })],
      HEADERS,
    );
    expect(r.rows[0].address_full).toBe("Weston, MO 64098");
    expect(r.rows[0].address).toBeUndefined();
  });
  it("maps First/Last/Phone/Email → agent_* fields", () => {
    const r = bmhAgentOutreachPreset.transform([row()], HEADERS);
    expect(r.rows[0].agent_first_name).toBe("Jane");
    expect(r.rows[0].agent_last_name).toBe("Smith");
    expect(r.rows[0].agent_phone).toBe("816-555-1001");
    expect(r.rows[0].agent_email).toBe("jane@example.com");
  });
  it("maps County → county_name and suggests '<County> outreach' list", () => {
    const r = bmhAgentOutreachPreset.transform(
      [row({ "County": "Buchanan County" })],
      HEADERS,
    );
    expect(r.rows[0].county_name).toBe("Buchanan County");
    expect(r.suggestions?.listNameSuggestion).toBe("Buchanan outreach");
  });
  it("carries Status / Follow Up / Lead Source as tags", () => {
    const r = bmhAgentOutreachPreset.transform([row()], HEADERS);
    expect(r.suggestions?.tags).toEqual(
      expect.arrayContaining(["Offer Sent", "Follow up Needed", "realtor.com"]),
    );
  });
  it("suggests source: agent_outreach", () => {
    const r = bmhAgentOutreachPreset.transform([row()], HEADERS);
    expect(r.suggestions?.sourceSuggestion).toBe("agent_outreach");
  });
});
