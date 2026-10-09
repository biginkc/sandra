import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  flags: vi.fn(),
  schemaReady: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/my-leads/queries", () => ({ myLeadsViewer: mocks.viewer }));
vi.mock("@/lib/my-leads/flags", () => ({ getMyLeadsFlags: mocks.flags }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: mocks.schemaReady }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { pollMyLeadsCallStateAction } from "./call-state-actions";

const off = { click_to_dial: false, auto_prompt: false, callback_alert: false, native_matcher: false };
const PROMPTS = { items: [{ attemptId: "a1", propertyId: "p1", callActivityId: "c1", endedAt: "2026-10-04T10:00:00Z", durationSeconds: 5, talkDurationSeconds: 0, origin: "sandra", outcomeGuess: null, voicemail: false }], nextCursor: null };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.viewer.mockResolvedValue({ orgId: "org-1", client: { rpc: mocks.rpc } });
  mocks.schemaReady.mockResolvedValue(true);
});

describe("pollMyLeadsCallStateAction", () => {
  it("reads the flags once and goes idle, with no RPC, when none of the four is on", async () => {
    mocks.flags.mockResolvedValue(off);
    const res = await pollMyLeadsCallStateAction();
    expect(mocks.flags).toHaveBeenCalledTimes(1);
    expect(mocks.flags).toHaveBeenCalledWith("org-1", ["click_to_dial", "auto_prompt", "callback_alert", "native_matcher"]);
    expect(res).toMatchObject({ ok: true, state: { idle: true, prompts: [] } });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.schemaReady).not.toHaveBeenCalled();
  });

  it("is not idle when only click_to_dial is on", async () => {
    mocks.flags.mockResolvedValue({ ...off, click_to_dial: true });
    const res = await pollMyLeadsCallStateAction();
    expect(res).toMatchObject({ ok: true });
    expect((res as { state: { idle?: boolean } }).state.idle).toBeUndefined();
  });

  it("returns the reads that worked and marks only the failed part", async () => {
    mocks.flags.mockResolvedValue({ ...off, auto_prompt: true, callback_alert: true });
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "fn_list_unacknowledged_call_prompts" ? { data: PROMPTS, error: null } : { data: null, error: { message: "boom" } });
    const res = await pollMyLeadsCallStateAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.prompts.map((p) => p.attemptId)).toEqual(["a1"]);
    expect(res.state.callbacksDue).toEqual([]);
    expect(res.state.failedSurfaces).toEqual(["callbacks"]);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("is an error only when every attempted read failed", async () => {
    mocks.flags.mockResolvedValue({ ...off, auto_prompt: true, callback_alert: true });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await pollMyLeadsCallStateAction()).toEqual({ ok: false, message: "Could not refresh call state." });
  });

  it("does not report a failure on a clean poll", async () => {
    mocks.flags.mockResolvedValue({ ...off, auto_prompt: true });
    mocks.rpc.mockResolvedValue({ data: PROMPTS, error: null });
    const res = await pollMyLeadsCallStateAction();
    expect(res).toMatchObject({ ok: true });
    expect((res as { state: { failedSurfaces?: unknown } }).state.failedSurfaces).toBeUndefined();
  });
});
