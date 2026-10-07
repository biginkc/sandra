import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MessagesV2View } from "./messages-v2-view";
import type { PipelineRun, PipelineRunStep, RunWithSteps } from "./types";

const mocks = vi.hoisted(() => {
  const handlers: Array<{ filter: Record<string, string>; cb: (p: { new: unknown }) => void }> = [];
  const state: { status?: (s: string) => void } = {};
  const channel = {
    on: vi.fn((_t: string, filter: Record<string, string>, cb: (p: { new: unknown }) => void) => {
      handlers.push({ filter, cb });
      return channel;
    }),
    subscribe: vi.fn((cb: (s: string) => void) => {
      state.status = cb;
      return channel;
    }),
  };
  const client = {
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "tok" } } })) },
    realtime: { setAuth: vi.fn() },
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    from: vi.fn(() => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.in = async () => ({ data: [] });
      return q;
    }),
  };
  return { handlers, state, channel, client, refresh: vi.fn() };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => mocks.client }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

const run = (id: string, over: Partial<PipelineRun> = {}): RunWithSteps => ({
  id, org_id: "o", inbound_message_id: `m-${id}`, property_id: null, contact_id: "c",
  conversation_id: `conv-${id}`, status: "running", mode: "automatic", final_outcome: null,
  reason: null, classification_run_id: null, claim_id: null, outbound_message_id: null,
  inbound_preview: `hello ${id}`, started_at: new Date().toISOString(), completed_at: null,
  steps: [], ...over,
});

const NOW = Date.now();
const props = (runs: RunWithSteps[] = [], holds: RunWithSteps[] = []) => ({
  runs, holds, nowMs: NOW,
  badges: [{ label: "not_interested", mode: "AUTO" as const }, { label: "nurture", mode: "SHADOW" as const }],
  labels: runs.map((r) => [r.id, { name: `Name ${r.id}`, address: null }] as [string, { name: string; address: null }]),
});

const fire = (event: string, table: string, row: unknown) =>
  act(async () => {
    mocks.handlers.find((h) => h.filter.event === event && h.filter.table === table)!.cb({ new: row });
  });

async function mount(p = props()) {
  render(<MessagesV2View {...p} />);
  await waitFor(() => expect(mocks.handlers.length).toBeGreaterThan(0));
}

beforeEach(() => {
  mocks.handlers.length = 0;
  mocks.refresh.mockClear();
  mocks.client.realtime.setAuth.mockClear();
});

describe("MessagesV2View", () => {
  it("renders header, mode badges, columns, empty states and legend", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Messages v2" })).toBeInTheDocument();
    expect(screen.getByText("not_interested [AUTO]")).toBeInTheDocument();
    expect(screen.getByText("nurture [SHADOW]")).toBeInTheDocument();
    expect(screen.getByLabelText("Live feed")).toBeInTheDocument();
    expect(screen.getByLabelText("Holds")).toBeInTheDocument();
    expect(screen.getByText(/no pipeline runs yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no open holds/i)).toBeInTheDocument();
    expect(within(screen.getByLabelText("Legend")).getAllByRole("listitem")).toHaveLength(6);
  });

  it("subscribes to runs INSERT/UPDATE and steps INSERT on messages-v2:feed with the session token", async () => {
    await mount();
    expect(mocks.client.channel).toHaveBeenCalledWith("messages-v2:feed");
    await waitFor(() => expect(mocks.client.realtime.setAuth).toHaveBeenCalledWith("tok"));
    const seen = mocks.handlers.map((h) => `${h.filter.event}:${h.filter.table}`).sort();
    expect(seen).toEqual([
      "INSERT:pipeline_run_steps",
      "INSERT:pipeline_runs",
      "UPDATE:pipeline_runs",
    ]);
  });

  it("adds a streamed run on top and appends streamed steps without refreshing", async () => {
    await mount(props([run("old", { started_at: new Date(NOW - 60_000).toISOString() })]));
    await fire("INSERT", "pipeline_runs", run("new"));
    const cards = screen.getAllByTestId("run-card");
    expect(cards[0]).toHaveTextContent("hello new");
    await fire("INSERT", "pipeline_run_steps", {
      id: "s1", run_id: "new", org_id: "o", seq: 1, kind: "action", name: "set_stage", result: "applied",
      detail: {}, created_at: "",
    } satisfies PipelineRunStep);
    expect(within(screen.getAllByTestId("run-card")[0]).getByTestId("step-action")).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("applies run UPDATEs (pulse stops, hold appears in the rail)", async () => {
    await mount(props([run("a")]));
    expect(screen.getByTestId("run-pulse")).toBeInTheDocument();
    await fire("UPDATE", "pipeline_runs", run("a", { status: "held", completed_at: new Date().toISOString() }));
    expect(screen.queryByTestId("run-pulse")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("hold-card")).toHaveLength(1);
    expect(screen.getByTestId("header-status")).toHaveTextContent("1 holds");
  });

  it("falls back to a refresh when a step arrives for an unknown run", async () => {
    await mount(props([run("a")]));
    await fire("INSERT", "pipeline_run_steps", {
      id: "sx", run_id: "ghost", org_id: "o", seq: 1, kind: "gate", name: "g", result: "pass", detail: {}, created_at: "",
    });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("backfills via refresh after the channel drops and reconnects", async () => {
    await mount();
    await act(async () => mocks.state.status!("SUBSCRIBED"));
    expect(screen.getByTestId("header-status")).toHaveTextContent("live");
    await act(async () => mocks.state.status!("CHANNEL_ERROR"));
    expect(screen.getByTestId("header-status")).toHaveTextContent("connecting");
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => mocks.state.status!("SUBSCRIBED"));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });
});
