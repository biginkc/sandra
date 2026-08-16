import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/lib/messages/triage.ts"), "utf8");

describe("unknown-sender tenant writes", () => {
  it("derives organization from the unknown messages before creating records", () => {
    expect(source).toContain("resolveUnknownSenderOrg(supabase, fromAddress)");
    expect(source).toMatch(/\.from\("messages"\)[\s\S]+\.select\("org_id"\)[\s\S]+\.eq\("from_address", fromAddress\)/);
    expect(source).toContain("code: \"AMBIGUOUS_SENDER_ORG\"");
  });

  it("writes the authoritative organization on contacts and role sidecars", () => {
    expect(source).toContain("org_id: orgId");
    expect(source).toContain("{ contact_id: contactId, org_id: orgId }");
    expect(source).toContain("{ contact_id: c.id, property_id: p.id }");
    expect(source).toContain('.eq("org_id", orgId)');
    expect(source).toContain('.eq("org_id", prop.org_id)');
  });
});
