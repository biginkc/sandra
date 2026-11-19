import { beforeEach, expect, it, vi } from "vitest";
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/app/(dashboard)/properties/actions", () => ({ bulkQueueSms: vi.fn(), getAllMatchingProspectIds: vi.fn() }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
import { previewCampaignLaunch } from "./actions";
const selections: Record<string, string[]> = {};
let failedTable: string | null = null;
beforeEach(() => {
  failedTable = null;
  for (const key of Object.keys(selections)) delete selections[key];
  createClient.mockResolvedValue({ from(table: string) {
    const data: Record<string, unknown> = {
      campaigns: {id:"campaign",status:"active",skip_if_contacted:true},
      campaign_recipients: [{property_id:"property",contact_id:"contact"}],
      contacts: [{id:"contact",phone_1:"+14175550100",phone_1_type:"mobile",do_not_contact:true,sms_opted_out:false}],
      properties: [{id:"property",org_id:"org",outreach_dispo:null,is_dnc_locked:false,deleted_at:null}],
      messages: [], consent_events: [], sms_phone_suppressions: [],
    };
    const query = {
      select(columns: string) { (selections[table] ??= []).push(columns); return query; },
      eq() { return query; }, in() { return query; }, order() { return query; }, range() { return query; }, maybeSingle() { return query; },
      then(resolve: (result: unknown) => unknown) { return Promise.resolve(resolve({data:data[table],error:table === failedTable ? {message:"lookup failed"} : null})); },
    };
    return query;
  }});
});
it("loads DNC flags and reports them in the actual launch action", async () => {
  const result = await previewCampaignLaunch("campaign");
  expect(result).toMatchObject({ok:true,data:{recipientCount:1,estimatedQueueableCount:0,dncCount:1}});
  expect(selections.contacts[0]).toContain("do_not_contact");
  expect(selections.contacts[0]).toContain("sms_opted_out");
});
it("does not return a queueable estimate when suppression lookup fails", async () => {
  failedTable = "sms_phone_suppressions";
  expect(await previewCampaignLaunch("campaign")).toMatchObject({ok:false});
});
