import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limiter = { consume: vi.fn() };
  return {
    createClient: vi.fn(),
    createAdminClient: vi.fn(),
    loadCoachCallContext: vi.fn(),
    requestWithDeps: vi.fn(),
    Anthropic: vi.fn(),
    createLimiter: vi.fn(() => limiter),
    limiter,
    reportError: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("./coach-context-actions", () => ({ loadCoachCallContext: mocks.loadCoachCallContext }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));
vi.mock("@anthropic-ai/sdk", () => ({ default: mocks.Anthropic }));
vi.mock("./recommendation-runtime-limiter", () => ({
  createRuntimeCacheCoachRecommendationLimiter: mocks.createLimiter,
}));
vi.mock("./recommendation-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./recommendation-server")>();
  return { ...actual, requestCoachRecommendationsWithDeps: mocks.requestWithDeps };
});

import { requestCoachRecommendations } from "./recommendation-action";
import type { CoachRecommendationRequest, CoachRecommendationResult } from "./recommendation-types";

const input: CoachRecommendationRequest = {
  requestId: "recommendation-request-1",
  callId: "call-1",
  activeSectionId: "introduction.opener",
  selectedSectionBranch: null,
  branchOverrides: {},
  mode: "automatic",
  transcript: [{ speaker: "seller", text: "The repair costs are becoming unmanageable.", isFinal: true }],
};

describe("requestCoachRecommendations", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults off and returns an unavailable envelope before auth, database, provider, or error reporting work", async () => {
    const result = await requestCoachRecommendations(input);

    expect(result).toEqual({
      ok: false,
      requestId: input.requestId,
      callId: input.callId,
      activeSectionId: input.activeSectionId,
      mode: input.mode,
      code: "provider_error",
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.loadCoachCallContext).not.toHaveBeenCalled();
    expect(mocks.Anthropic).not.toHaveBeenCalled();
    expect(mocks.requestWithDeps).not.toHaveBeenCalled();
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("keeps the enabled path's dependency wiring and result passthrough unchanged", async () => {
    vi.stubEnv("COACH_RECOMMENDATIONS_ENABLED", "1");
    const supabase = { auth: { getUser: vi.fn() } };
    const anthropic = { messages: { create: vi.fn() } };
    const expected: CoachRecommendationResult = {
      ok: true,
      requestId: input.requestId,
      callId: input.callId,
      activeSectionId: input.activeSectionId,
      mode: input.mode,
      recommendations: ["Ask how the repair burden has affected their plans."],
      followUpQuestions: [],
    };
    mocks.createClient.mockResolvedValue(supabase);
    mocks.Anthropic.mockImplementation((class {
      constructor() {
        return anthropic;
      }
    }) as unknown as (...args: unknown[]) => unknown);
    mocks.requestWithDeps.mockResolvedValue(expected);

    await expect(requestCoachRecommendations(input)).resolves.toEqual(expected);

    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(mocks.Anthropic).toHaveBeenCalledOnce();
    expect(mocks.requestWithDeps).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        anthropic,
        limiter: mocks.limiter,
      }),
    );
    const [, dependencies] = mocks.requestWithDeps.mock.calls[0];
    await dependencies.auth.getUser();
    expect(supabase.auth.getUser).toHaveBeenCalledOnce();
  });
});
