import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachCallContext } from "@/lib/coach/types";
import type { SoftphoneTarget } from "@/lib/dialer/actions";
const { load, onAuth } = vi.hoisted(() => ({ load: vi.fn(), onAuth: vi.fn() }));
vi.mock("@/lib/coach/precall-context-actions", () => ({
  loadPrecallContext: load,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { onAuthStateChange: onAuth } }),
}));
import { usePrecallSetup } from "./use-precall-setup";
const context: CoachCallContext = {
  sellerName: "First",
  repName: "Alex Rep",
  authenticatedRepName: "Alex Rep",
  propertyAddress: "1 Fictional Lane",
  propertyCounty: null,
  repPhoneE164: "+18165550100",
  sellerPhoneE164: "+18165550101",
  leadId: "lead-ABC123",
  motivation: null,
  coldCallerName: null,
  yearBuilt: "1962",
  leadSource: "sms",
  occupancy: "owner_occupied",
};
const target = (id: string): SoftphoneTarget => ({
  propertyId: id,
  contactId: id,
  phoneE164: "+18165550101",
  maskedPhone: "masked",
  name: id,
  address: id,
  state: "MO",
  startedAt: "2026-09-10T12:00:00Z",
});
beforeEach(() => {
  localStorage.clear();
  load
    .mockReset()
    .mockResolvedValue({ operatorId: "rep1", context, error: null });
  onAuth
    .mockReset()
    .mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
});
describe("precall draft isolation and races", () => {
  it("keeps edits for each homeowner and restores after remount without persisting authority", async () => {
    const a = renderHook(() => usePrecallSetup(false, "+18165550100"));
    await act(() => a.result.current.load(target("A")));
    act(() => a.result.current.onField("seller_name", "Edited A"));
    act(() => a.result.current.onBranch("Opener", "fsbo"));
    await act(() => a.result.current.load(target("B")));
    expect(a.result.current.draft.edits.seller_name).toBeUndefined();
    act(() => a.result.current.onField("seller_name", "Edited B"));
    await act(() => a.result.current.load(target("A")));
    expect(a.result.current.draft.edits.seller_name).toBe("Edited A");
    expect(a.result.current.draft.branches.Opener).toBe("fsbo");
    expect(Object.values(localStorage).join("")).not.toContain(
      "authenticatedRepName",
    );
    a.unmount();
    const b = renderHook(() => usePrecallSetup(false, "+18165550100"));
    await act(() => b.result.current.load(target("A")));
    expect(b.result.current.draft.edits.seller_name).toBe("Edited A");
  });
  it("latest A-B-A response wins while edits during loading survive", async () => {
    const pending: ((value: unknown) => void)[] = [];
    load.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const { result } = renderHook(() => usePrecallSetup(false, null));
    act(() => {
      void result.current.load(target("A"));
    });
    act(() => {
      void result.current.load(target("B"));
    });
    act(() => {
      void result.current.load(target("A"));
    });
    act(() => result.current.onField("seller_name", "Newest A"));
    await act(async () =>
      pending[2]({
        operatorId: "rep1",
        context: { ...context, sellerName: "Third" },
        error: null,
      }),
    );
    await act(async () =>
      pending[0]({
        operatorId: "rep1",
        context: { ...context, sellerName: "First" },
        error: null,
      }),
    );
    await act(async () =>
      pending[1]({
        operatorId: "rep1",
        context: { ...context, sellerName: "Second" },
        error: null,
      }),
    );
    expect(result.current.context?.sellerName).toBe("Third");
    expect(result.current.draft.edits.seller_name).toBe("Newest A");
  });
  it("keeps an explicit clear through retry and an optional-storage failure", async () => {
    const { result } = renderHook(() => usePrecallSetup(false, null));
    await act(() => result.current.load(target("A")));
    const failure = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw Error("blocked");
      });
    act(() => result.current.onField("seller_name", ""));
    await act(() => result.current.load(target("A"), true));
    expect(result.current.draft.edits.seller_name).toBe("");
    failure.mockRestore();
  });
  it("signout clears only the current rep draft and invalidates pending state", async () => {
    const { result } = renderHook(() => usePrecallSetup(false, null));
    await act(() => result.current.load(target("A")));
    act(() => result.current.onField("seller_name", "Private"));
    localStorage.setItem("sandra.coach.setup.v1:rep2:lead:B", "other");
    act(() => onAuth.mock.calls[0][0]("SIGNED_OUT", null));
    expect(result.current.target).toBeNull();
    expect(
      localStorage.getItem("sandra.coach.setup.v1:rep1:lead:A"),
    ).toBeNull();
    expect(localStorage.getItem("sandra.coach.setup.v1:rep2:lead:B")).toBe(
      "other",
    );
  });
  it("a completed disposition clears the exact snapshotted target, not another homeowner", async () => {
    const { result } = renderHook(() => usePrecallSetup(false, null));
    await act(() => result.current.load(target("A")));
    act(() => result.current.onField("seller_name", "A"));
    const snapshot = result.current.snapshot();
    await act(() => result.current.load(target("B")));
    act(() => result.current.onField("seller_name", "B"));
    act(() => result.current.clear(snapshot));
    expect(result.current.draft.edits.seller_name).toBe("B");
    await act(() => result.current.load(target("A")));
    expect(result.current.draft.edits.seller_name).toBeUndefined();
  });
});

it("freezes explicit edits and branches even if the initial context never resolves", async () => {
  load.mockReturnValue(new Promise(() => undefined));
  const { result } = renderHook(() => usePrecallSetup(false, "+18165550100"));
  act(() => {
    void result.current.load(target("A"));
  });
  act(() => result.current.onField("seller_name", "Early edit"));
  act(() => result.current.onBranch("Opener", "fsbo"));
  const snapshot = result.current.snapshot();
  expect(snapshot).toMatchObject({
    operatorId: null,
    propertyId: "A",
    edits: { seller_name: "Early edit" },
    branches: { Opener: "fsbo" },
    context: { leadId: null, authenticatedRepName: null },
  });
  act(() => result.current.onField("seller_name", "Later edit"));
  expect(snapshot?.edits.seller_name).toBe("Early edit");
});
it("persists early edits and branch picks when delayed authenticated context arrives", async () => {
  let finish: (value: unknown) => void = () => undefined;
  load.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = renderHook(() => usePrecallSetup(false, null));
  act(() => {
    void first.result.current.load(target("A"));
  });
  act(() => first.result.current.onField("seller_name", "Early saved"));
  act(() => first.result.current.onBranch("Opener", "d4d"));
  await act(async () => finish({ operatorId: "rep1", context, error: null }));
  first.unmount();
  load.mockResolvedValue({ operatorId: "rep1", context, error: null });
  const second = renderHook(() => usePrecallSetup(false, null));
  await act(() => second.result.current.load(target("A")));
  expect(second.result.current.draft).toMatchObject({
    edits: { seller_name: "Early saved" },
    branches: { Opener: "d4d" },
  });
});
it("context failure retains call eligibility, draft and the selected identity", async () => {
  const { result } = renderHook(() => usePrecallSetup(false, null));
  await act(() => result.current.load(target("A")));
  act(() => result.current.onField("motivation", ""));
  load.mockRejectedValue(Error("offline"));
  await act(() => result.current.load(target("A"), true));
  expect(result.current.error).toContain("still call");
  expect(result.current.snapshot()).toMatchObject({
    propertyId: "A",
    edits: { motivation: "" },
  });
});
it("successful disposition invalidates a pending retry so it cannot resurrect the saved draft", async () => {
  const { result } = renderHook(() => usePrecallSetup(false, null));
  await act(() => result.current.load(target("A")));
  act(() => result.current.onField("seller_name", "Saved"));
  const snapshot = result.current.snapshot();
  let finish: (value: unknown) => void = () => undefined;
  load.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    void result.current.load(target("A"), true);
  });
  act(() => result.current.clear(snapshot));
  await act(async () => finish({ operatorId: "rep1", context, error: null }));
  expect(result.current.target).toBeNull();
  expect(localStorage.getItem("sandra.coach.setup.v1:rep1:lead:A")).toBeNull();
});
