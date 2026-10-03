import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NormaConnectedNotifier } from "./norma-connected-notifier";

const { toastSuccess, push, tables, filters, state } = vi.hoisted(() => ({
  state: { user: "user-me", emit: (_id: string) => undefined } as { user: string; emit: (id: string) => void; hold?: Promise<void> },
  toastSuccess: vi.fn(),
  push: vi.fn(),
  tables: {} as Record<string, unknown[]>,
  filters: [] as { table: string; method: string; args: unknown[] }[],
}));

vi.mock("sonner", () => ({ toast: { success: toastSuccess } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: state.user } } }),
      onAuthStateChange: (cb: (e: string, s: { user: { id: string } } | null) => void) => {
        state.emit = (id: string) => cb("SIGNED_IN", { user: { id } });
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "gte", "order"]) {
        chain[method] = (...args: unknown[]) => (filters.push({ table, method, args }), chain);
      }
      chain.limit = async () => {
        if (table === "norma_call_requests" && state.hold) await state.hold;
        return { data: tables[table] ?? [], error: null };
      };
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: tables[table] ?? [], error: null });
      return chain;
    },
  }),
}));

const recent = () => new Date(Date.now() - 1000).toISOString();

beforeEach(() => {
  filters.length = 0;
  for (const key of Object.keys(tables)) delete tables[key];
  window.sessionStorage.clear();
  tables.norma_call_requests = [
    { id: "r1", property_id: "p1", status: "completed", outcome: "callback_requested", completed_at: recent(), requested_by: "user-me" },
  ];
  tables.properties = [{ id: "p1", address: "12 Oak St", homeowner_contact_id: "c1" }];
  tables.contacts = [{ id: "c1", first_name: "Pat", last_name: "Seller" }];
});
afterEach(() => vi.clearAllMocks());

describe("<NormaConnectedNotifier />", () => {
  it("toasts once, plainly, with a link to the lead, and asks only for this user's connected completions", async () => {
    render(<NormaConnectedNotifier />);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    const [text, options] = toastSuccess.mock.calls[0]!;
    expect(text).toBe("Norma reached Pat Seller — 12 Oak St");
    options.action.onClick();
    expect(push).toHaveBeenCalledWith("/leads/p1");
    const requests = filters.filter((f) => f.table === "norma_call_requests");
    expect(requests).toContainEqual({ table: "norma_call_requests", method: "eq", args: ["requested_by", "user-me"] });
    expect(requests).toContainEqual({ table: "norma_call_requests", method: "eq", args: ["status", "completed"] });
    expect(requests.find((f) => f.method === "in")!.args[1]).toEqual(["reached_no_callback", "callback_requested", "not_interested", "wrong_number"]);
  });

  it("does not repeat across polls or after a reload in the same tab", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = render(<NormaConnectedNotifier />);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    first.unmount();
    render(<NormaConnectedNotifier />);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("shows nothing when another user's or a non-connected row comes back", async () => {
    tables.norma_call_requests = [
      { id: "r2", property_id: "p1", status: "completed", outcome: "callback_requested", completed_at: recent(), requested_by: "other" },
      { id: "r3", property_id: "p1", status: "completed", outcome: "no_answer", completed_at: recent(), requested_by: "user-me" },
    ];
    render(<NormaConnectedNotifier />);
    await new Promise((r) => setTimeout(r, 50));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("user A -> user B switching mid-poll: A's in-flight poll shows nothing, B sees only B's own", async () => {
    state.user = "user-a";
    tables.norma_call_requests = [
      { id: "ra", property_id: "p1", status: "completed", outcome: "callback_requested", completed_at: recent(), requested_by: "user-a" },
    ];
    let release!: () => void;
    state.hold = new Promise<void>((r) => (release = r));
    render(<NormaConnectedNotifier />);
    await waitFor(() => expect(filters.some((f) => f.table === "norma_call_requests")).toBe(true));
    // The session switches to B while A's poll is still waiting on its query.
    state.user = "user-b";
    state.emit("user-b");
    state.hold = undefined;
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(toastSuccess).not.toHaveBeenCalled();
    // B's own connected call does toast; A's row is never shown to B.
    tables.norma_call_requests = [
      { id: "ra", property_id: "p1", status: "completed", outcome: "callback_requested", completed_at: recent(), requested_by: "user-a" },
      { id: "rb", property_id: "p1", status: "completed", outcome: "reached_no_callback", completed_at: recent(), requested_by: "user-b" },
    ];
    document.dispatchEvent(new Event("visibilitychange")); // an immediate poll, as when the tab is shown again
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess.mock.calls[0]![1].id).toBe("norma-connected-rb");
    state.user = "user-me";
  });
});
