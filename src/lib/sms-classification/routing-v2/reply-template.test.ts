import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { resolveV2Reply } from "./reply-template";
import { v2ReplyText } from "./reply-texts";
vi.mock("@/lib/sequences/template-vars", () => ({ loadTemplateVars: vi.fn(async () => ({ property_address: "12 Main St" })) }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
const propertyId = "11111111-1111-4111-8111-111111111111";
function fixture(options: { on?: boolean; approved?: boolean; edited?: boolean; custom?: boolean } = {}) {
  const source = options.custom ? "Unexpected but approved text" : v2ReplyText("where_property");
  const from = vi.fn((table: string) => {
    const data = table === "ai_responder_configs" ? { routing_v2_flags: { questions_live: true, replies: options.on !== false, canary_property_ids: [propertyId] } }
      : [{ id: "mapping", template_id: "template", reply_intent: null, priority: 0,
        sms_templates: { content: source, approved_for_auto_send: options.approved !== false,
          approved_content: options.edited ? "previous text" : source, deleted_at: null } }];
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve) };
    return q;
  });
  return { db: { from } as unknown as SupabaseClient<Database>, from };
}
const input = { orgId: "org", propertyId, contactId: "contact", key: "where_property" as const };
describe("v2 reply preparation", () => {
  it("renders the exact approved template while retaining source for send-time checks", async () => {
    const { db } = fixture();
    expect(await resolveV2Reply(db, input)).toEqual({ kind: "ready", body: "Sorry for the confusion, it's 12 Main St. Would you consider a cash offer on it?", source: v2ReplyText("where_property"), templateId: "template", fixed: false });
  });
  it.each([{ approved: false }, { edited: true }, { custom: true }])("refuses unapproved, changed or substituted text: %j", async (options) => {
    expect((await resolveV2Reply(fixture(options).db, input)).kind).toBe("none");
  });
  it("flag-off makes no mapping query, even for a fixed reply", async () => {
    const { db, from } = fixture({ on: false });
    expect(await resolveV2Reply(db, { ...input, key: "said_yes" })).toEqual({ kind: "none", reason: "flag_off" });
    expect(from).toHaveBeenCalledExactlyOnceWith("ai_responder_configs");
  });
  it("preserves the existing fixed yes reply", async () => {
    const { db } = fixture();
    expect(await resolveV2Reply(db, { ...input, key: "said_yes" })).toMatchObject({ kind: "ready", body: v2ReplyText("said_yes"), templateId: null, fixed: true });
  });
});
