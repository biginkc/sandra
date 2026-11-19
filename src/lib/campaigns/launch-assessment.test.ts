import { describe, expect, it } from "vitest";
import { assessCampaignLaunch, type PreviewContact, type PreviewProperty } from "./launch-assessment";
const contact: PreviewContact = { phone_1: "4175550100", phone_1_type: "mobile", phone_2: null, phone_2_type: null, phone_3: null, phone_3_type: null, do_not_contact: false, sms_opted_out: false };
const property: PreviewProperty = { org_id: "org", outreach_dispo: null, is_dnc_locked: false, deleted_at: null };
function fixture() { return { rows: [{propertyId:"p", contactId:"c"}], contacts: new Map([["c", {...contact}]]), properties: new Map([["p", {...property}]]), optedOut: new Set<string>(), suppressedPhonesByOrg: new Map<string, Set<string>>(), priorSuccessful: new Set<string>(), skipIfContacted: true }; }
describe("campaign launch assessment", () => {
  it("does not promise messages for DNC contacts even without consent events", () => {
    const input = fixture(); input.contacts.get("c")!.do_not_contact = true;
    expect(assessCampaignLaunch(input)).toMatchObject({recipientCount:1, estimatedQueueableCount:0, dncCount:1});
  });
  it.each(["sms_opted_out", "consent_event", "phone_suppression", "nurture", "property_lock", "deleted", "prior_success"])("excludes %s before counting a send", (kind) => {
    const input = fixture();
    if (kind === "sms_opted_out") input.contacts.get("c")!.sms_opted_out = true;
    if (kind === "consent_event") input.optedOut.add("c");
    if (kind === "phone_suppression") input.suppressedPhonesByOrg.set("org", new Set(["+14175550100"]));
    if (kind === "nurture") input.properties.get("p")!.outreach_dispo = "nurture";
    if (kind === "property_lock") input.properties.get("p")!.is_dnc_locked = true;
    if (kind === "deleted") input.properties.get("p")!.deleted_at = "2026-01-01";
    if (kind === "prior_success") input.priorSuccessful.add("p");
    expect(assessCampaignLaunch(input).estimatedQueueableCount).toBe(0);
  });
  it("keeps relationships but counts one send per eligible destination", () => {
    const input = fixture(); input.rows.push({propertyId:"p2",contactId:"c2"});
    input.properties.set("p2", property); input.contacts.set("c2", {...contact,phone_1:"+14175550100"});
    expect(assessCampaignLaunch(input)).toMatchObject({recipientCount:2,estimatedQueueableCount:1,duplicateDestinationCount:1});
  });
  it("does not let a suppressed contact consume an eligible contact's destination", () => {
    const input = fixture(); input.contacts.get("c")!.do_not_contact = true;
    input.rows.push({propertyId:"p",contactId:"c2"}); input.contacts.set("c2",contact);
    expect(assessCampaignLaunch(input)).toMatchObject({estimatedQueueableCount:1,dncCount:1,duplicateDestinationCount:0});
  });
});
