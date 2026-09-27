import { describe, expect, it, vi } from "vitest";
import { closrOutbound123Bundle, closrOutbound123Digest } from "@biginkc/coach/fixtures";
import { requestCoachRecommendationsWithDeps, type CoachRecommendationServerDeps } from "./recommendation-server";

const input = { requestId: "request-1", callId: "call-1", activeSectionId: "introduction.opener", selectedSectionBranch: null, branchOverrides: {}, mode: "automatic" as const, transcript: [{ id: "seller-1", speaker: "seller" as const, text: "I need to move soon for work.", isFinal: true, ts: "2026-09-26T00:00:00Z" }] };
function deps(): CoachRecommendationServerDeps { return {
  auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
  calls: { findOwnedCall: vi.fn(async () => ({ data: { propertyId: "property-1", scriptDigest: closrOutbound123Digest }, error: null })) },
  scripts: { loadByDigest: vi.fn(async ({ digest }) => ({ data: digest === closrOutbound123Digest ? closrOutbound123Bundle : null, error: null })) },
  contexts: { load: vi.fn(async () => ({ data: { sellerName: null, propertyAddress: null, propertyCounty: null, yearBuilt: null, leadSource: null, occupancy: null }, error: null })) },
  limiter: { consume: vi.fn(async () => ({ allowed: true })) },
  anthropic: { messages: { create: vi.fn(async () => ({ content: [{ type: "tool_use", input: { recommendations: ["Ask what timeline works best."] } }] })) } } as never,
}; }
describe("recommendation server bound script", () => {
  it("loads only the exact call digest before building recommendation context", async () => {
    const d = deps(); await requestCoachRecommendationsWithDeps(input, d);
    expect(d.scripts.loadByDigest).toHaveBeenCalledWith({ digest: closrOutbound123Digest });
  });
  it("does not substitute a missing cached bundle", async () => {
    const d = deps(); d.scripts.loadByDigest = vi.fn(async () => ({ data: null, error: null }));
    await expect(requestCoachRecommendationsWithDeps(input, d)).resolves.toMatchObject({ ok: false, code: "invalid_request" });
  });
});
