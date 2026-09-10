import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  context: vi.fn(),
  inspectLead: vi.fn(),
  inspectManual: vi.fn(),
  prepareLead: vi.fn(),
  prepareManual: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: m.auth } }),
}));
vi.mock("./coach-context-actions", () => ({ loadCoachCallContext: m.context }));
vi.mock("@/lib/dialer/actions", () => ({
  inspectLeadCall: m.inspectLead,
  inspectManualCall: m.inspectManual,
  prepareLeadCall: m.prepareLead,
  prepareManualCall: m.prepareManual,
}));
import {
  loadPrecallContext,
  prepareSetupCall,
} from "./precall-context-actions";
const input = {
  operatorId: "rep1",
  propertyId: "lead1",
  phoneE164: "+18165550101",
};
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({
    data: {
      user: {
        id: "rep1",
        email: "alex.rep@example.test",
        user_metadata: { display_name: "Alex Rep" },
      },
    },
    error: null,
  });
  m.context.mockResolvedValue({ leadId: "lead1" });
  m.inspectLead.mockResolvedValue({
    ok: true,
    data: { propertyId: "lead1", phoneE164: input.phoneE164 },
  });
  m.inspectManual.mockResolvedValue({
    ok: true,
    data: { propertyId: null, phoneE164: input.phoneE164 },
  });
  m.prepareLead.mockResolvedValue({ ok: true, data: {} });
  m.prepareManual.mockResolvedValue({ ok: true, data: {} });
});
describe("precall authorization and start boundary", () => {
  it("requires an authenticated read and never starts while reading", async () => {
    await loadPrecallContext({
      propertyId: "lead1",
      sellerPhoneE164: input.phoneE164,
      repPhoneE164: null,
    });
    expect(m.context).toHaveBeenCalledOnce();
    expect(m.prepareLead).not.toHaveBeenCalled();
    m.auth.mockResolvedValue({ data: { user: null }, error: null });
    await expect(
      loadPrecallContext({
        propertyId: "lead1",
        sellerPhoneE164: null,
        repPhoneE164: null,
      }),
    ).rejects.toThrow("Sign in");
    expect(m.context).toHaveBeenCalledOnce();
  });
  it("keeps the selected property identity on context failure without fabricating a suffix", async () => {
    m.context.mockRejectedValue(Error("offline"));
    const result = await loadPrecallContext({
      propertyId: "lead1",
      sellerPhoneE164: input.phoneE164,
      repPhoneE164: null,
    });
    expect(result.context).toMatchObject({
      leadId: "lead1",
      authenticatedRepName: "Alex Rep",
    });
    expect(result.error).toContain("still call");
  });
  it("rejects changed rep before any eligibility or start effects", async () => {
    await expect(
      prepareSetupCall({ ...input, operatorId: "rep2" }),
    ).resolves.toMatchObject({ ok: false });
    expect(m.inspectLead).not.toHaveBeenCalled();
    expect(m.prepareLead).not.toHaveBeenCalled();
  });
  it("rechecks target identity and rejects a changed phone before start effects", async () => {
    m.inspectLead.mockResolvedValue({
      ok: true,
      data: { propertyId: "lead1", phoneE164: "+18165550102" },
    });
    await expect(prepareSetupCall(input)).resolves.toMatchObject({ ok: false });
    expect(m.prepareLead).not.toHaveBeenCalled();
  });
  it("preserves eligibility failures and starts exactly once after successful recheck", async () => {
    m.inspectLead.mockResolvedValueOnce({ ok: false, error: "quiet hours" });
    await expect(prepareSetupCall(input)).resolves.toEqual({
      ok: false,
      error: "quiet hours",
    });
    expect(m.prepareLead).not.toHaveBeenCalled();
    await prepareSetupCall(input);
    expect(m.prepareLead).toHaveBeenCalledExactlyOnceWith("lead1");
  });
  it("allows an authenticated unmatched number with incomplete setup without making a lead", async () => {
    await prepareSetupCall({ ...input, operatorId: null, propertyId: null });
    expect(m.prepareManual).toHaveBeenCalledExactlyOnceWith(input.phoneE164);
    expect(m.prepareLead).not.toHaveBeenCalled();
  });
});
