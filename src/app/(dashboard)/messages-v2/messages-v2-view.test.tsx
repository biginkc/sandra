import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MessagesV2View, type MessagesV2ViewProps } from "./messages-v2-view";
import type {
  OpenHold,
  PipelineCoverage,
  PipelineRun,
  PipelineRunStep,
  RunWithSteps,
} from "./types";

const mocks = vi.hoisted(() => {
  const handlers: Array<{
    filter: Record<string, string>;
    cb: (p: { new: unknown }) => void;
  }> = [];
  const state: { status?: (s: string) => void } = {};
  const channel = {
    on: vi.fn(
      (
        _t: string,
        filter: Record<string, string>,
        cb: (p: { new: unknown }) => void,
      ) => {
        handlers.push({ filter, cb });
        return channel;
      },
    ),
    subscribe: vi.fn((cb: (s: string) => void) => {
      state.status = cb;
      return channel;
    }),
  };
  const client = {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "tok" } },
      })),
    },
    realtime: { setAuth: vi.fn() },
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    rpc: vi.fn(async () => ({ data: [], error: null })),
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const run = (id: string, over: Partial<PipelineRun> = {}): RunWithSteps => ({
  id,
  org_id: "o",
  inbound_message_id: `m-${id}`,
  property_id: null,
  contact_id: "c",
  conversation_id: `conv-${id}`,
  status: "running",
  mode: "automatic",
  final_outcome: null,
  reason: null,
  classification_run_id: null,
  claim_id: null,
  outbound_message_id: null,
  inbound_preview: `hello ${id}`,
  started_at: new Date().toISOString(),
  completed_at: null,
  steps: [],
  ...over,
});

const NOW = Date.now();
const openHold = (
  id: string,
  r: RunWithSteps | null = null,
): OpenHold<RunWithSteps> => ({
  id,
  property_id: id,
  conversation_id: null,
  sources: ["needs_attention"],
  since: new Date(NOW - 5 * 60_000).toISOString(),
  reason: "Needs attention",
  run: r,
});
const props = (
  runs: RunWithSteps[] = [],
  holds: OpenHold<RunWithSteps>[] = [],
  coverage?: PipelineCoverage | null,
): MessagesV2ViewProps => ({
  orgId: "org-1",
  isOwner: true,
  coverage,
  runs,
  holds,
  nowMs: NOW,
  badges: [
    { label: "not_interested", mode: "AUTO" as const, minConfidence: 0.95 },
    { label: "nurture", mode: "SHADOW" as const },
    { label: "paused", mode: "HELD" as const },
  ],
  labels: runs.map(
    (r) =>
      [r.id, { name: `Name ${r.id}`, address: null }] as [
        string,
        { name: string; address: null },
      ],
  ),
});

const fire = (event: string, table: string, row: unknown) =>
  act(async () => {
    mocks.handlers
      .find((h) => h.filter.event === event && h.filter.table === table)!
      .cb({ new: row });
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
    expect(
      screen.getByRole("heading", { name: "Messages v2" }),
    ).toBeInTheDocument();
    expect(screen.getByText("not_interested [AUTO ≥0.95]")).toBeInTheDocument();
    expect(screen.getByText("nurture [SHADOW]")).toBeInTheDocument();
    expect(screen.getByText("paused [HELD]")).toBeInTheDocument();
    expect(screen.getByLabelText("Live feed")).toBeInTheDocument();
    expect(screen.getByLabelText("Holds")).toBeInTheDocument();
    expect(screen.getByText(/no pipeline runs yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no open holds/i)).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Legend")).getAllByRole("listitem"),
    ).toHaveLength(6);
  });

  it("renders the shadow scorecard from server rows instead of the placeholder", async () => {
    await mount({
      ...props(),
      scorecardRows: [
        {
          outcome: "nurture",
          runs: 7,
          auto_applied: 5,
          held: 2,
          auto_settled: 0,
          auto_agreed: 0,
          held_decided: 0,
          held_agreed: 0,
          threshold: 0.9,
          automation_enabled: true,
          samples: [],
        },
      ],
    });
    const card = screen.getByLabelText("Shadow scorecard");
    expect(within(card).getByText(/7 runs/)).toBeInTheDocument();
    expect(screen.queryByText(/available after 2h/i)).not.toBeInTheDocument();
  });

  it("subscribes on messages-v2:feed with the session token, every subscription filtered to the org", async () => {
    await mount();
    expect(mocks.client.channel).toHaveBeenCalledWith("messages-v2:feed");
    await waitFor(() =>
      expect(mocks.client.realtime.setAuth).toHaveBeenCalledWith("tok"),
    );
    const seen = mocks.handlers
      .map((h) => `${h.filter.event}:${h.filter.table}`)
      .sort();
    expect(seen).toEqual([
      "*:ai_disposition_reviews",
      "INSERT:lead_events",
      "INSERT:pipeline_run_steps",
      "INSERT:pipeline_runs",
      "UPDATE:pipeline_runs",
    ]);
    for (const h of mocks.handlers)
      expect(h.filter.filter).toBe("org_id=eq.org-1");
  });

  it("refreshes (throttled) when a disposition review or lead event changes", async () => {
    await mount();
    await act(async () => {
      mocks.handlers
        .find((h) => h.filter.table === "ai_disposition_reviews")!
        .cb({ new: {} });
    });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("adds a streamed run on top and appends streamed steps without refreshing", async () => {
    await mount(
      props([run("old", { started_at: new Date(NOW - 60_000).toISOString() })]),
    );
    await fire("INSERT", "pipeline_runs", run("new"));
    const cards = screen.getAllByTestId("run-card");
    expect(cards[0]).toHaveTextContent("hello new");
    await fire("INSERT", "pipeline_run_steps", {
      id: "s1",
      run_id: "new",
      org_id: "o",
      seq: 1,
      kind: "action",
      name: "set_stage",
      result: "applied",
      detail: {},
      created_at: "",
    } satisfies PipelineRunStep);
    expect(
      within(screen.getAllByTestId("run-card")[0]).getByTestId("step-action"),
    ).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("applies run UPDATEs (pulse stops) but a held run alone does not open a hold", async () => {
    await mount(props([run("a")]));
    expect(screen.getByTestId("run-pulse")).toBeInTheDocument();
    await fire(
      "UPDATE",
      "pipeline_runs",
      run("a", { status: "held", completed_at: new Date().toISOString() }),
    );
    expect(screen.queryByTestId("run-pulse")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("hold-card")).toHaveLength(0);
  });

  it("renders server-derived holds, including a runless fallback card", async () => {
    await mount(
      props(
        [run("a")],
        [openHold("p1", run("a", { status: "closed" })), openHold("p2")],
      ),
    );
    expect(screen.getAllByTestId("hold-card")).toHaveLength(2);
    expect(screen.getByTestId("header-status")).toHaveTextContent("2 holds");
  });

  it("shows inbound/run coverage and highlights a gap", async () => {
    const { unmount } = render(
      <MessagesV2View {...props([], [], { inboundMessages: 3, runs: 3 })} />,
    );
    expect(screen.getByTestId("coverage")).toHaveTextContent(
      "3 inbound / 3 runs (last hour)",
    );
    expect(screen.getByTestId("coverage")).toHaveAttribute("data-gap", "false");
    unmount();
    render(
      <MessagesV2View {...props([], [], { inboundMessages: 5, runs: 2 })} />,
    );
    expect(screen.getByTestId("coverage")).toHaveTextContent(
      "5 inbound / 2 runs (last hour)",
    );
    expect(screen.getByTestId("coverage")).toHaveAttribute("data-gap", "true");
  });

  it("omits the coverage stat when unavailable", async () => {
    await mount(props([], [], null));
    expect(screen.queryByTestId("coverage")).not.toBeInTheDocument();
  });

  it("falls back to a refresh when a step arrives for an unknown run", async () => {
    await mount(props([run("a")]));
    await fire("INSERT", "pipeline_run_steps", {
      id: "sx",
      run_id: "ghost",
      org_id: "o",
      seq: 1,
      kind: "gate",
      name: "g",
      result: "pass",
      detail: {},
      created_at: "",
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

  it("shows a degraded 'coverage unavailable' indicator when the coverage query failed", async () => {
    await mount({ ...props(), coverageUnavailable: true });
    const el = screen.getByTestId("coverage");
    expect(el).toHaveTextContent("coverage unavailable");
    expect(el).toHaveAttribute("data-degraded", "true");
  });

  it("header says 'holds unavailable' on a failed source and 'N holds (M shown)' when truncated", async () => {
    const m = {
      total: 0,
      shown: 0,
      truncated: false,
      totalState: "exact" as const,
      failed: [] as never[],
      contextErrors: [],
    };
    const { unmount } = render(
      <MessagesV2View
        {...props()}
        holdsMeta={{ ...m, failed: ["needs_attention"] }}
      />,
    );
    expect(screen.getByTestId("header-status")).toHaveTextContent(
      "holds unavailable",
    );
    unmount();
    render(
      <MessagesV2View
        {...props([], [openHold("a")])}
        holdsMeta={{ ...m, total: 350, shown: 1, truncated: true }}
      />,
    );
    expect(screen.getByTestId("header-status")).toHaveTextContent(
      "350 holds (1 shown)",
    );
  });

  it("shows 'Feed unavailable' instead of the empty-feed message when the feed query failed", async () => {
    await mount({ ...props(), feedError: "Feed unavailable — timeout" });
    expect(screen.getByTestId("feed-unavailable")).toHaveTextContent(
      "Feed unavailable — timeout",
    );
    expect(screen.queryByText(/no pipeline runs yet/i)).toBeNull();
  });

  it("shows step and badge failures explicitly", async () => {
    await mount({
      ...props(),
      stepsUnavailable: true,
      badgesError: "Mode badges unavailable — x",
    });
    expect(screen.getByTestId("steps-unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("badges-unavailable")).toHaveTextContent(
      "Mode badges unavailable",
    );
  });

  it("header says '2,000+ holds (incomplete)' when capped and 'holds count unavailable' when counts failed", async () => {
    const m = {
      total: 2000,
      shown: 1,
      truncated: true,
      totalState: "capped" as const,
      failed: [] as never[],
      contextErrors: [],
    };
    const { unmount } = render(
      <MessagesV2View {...props([], [openHold("a")])} holdsMeta={m} />,
    );
    expect(screen.getByTestId("header-status")).toHaveTextContent(
      "2,000+ holds (incomplete)",
    );
    unmount();
    render(
      <MessagesV2View
        {...props([], [openHold("a")])}
        holdsMeta={{ ...m, totalState: "unavailable", truncated: false }}
      />,
    );
    expect(screen.getByTestId("header-status")).toHaveTextContent(
      "holds count unavailable",
    );
  });
  describe("replay batch badge", () => {
    it("shows for owner with a batch id", async () => {
      await mount({ ...props(), replayBatchId: "2026-10-07" });
      expect(screen.getByTestId("replay-batch-badge")).toHaveTextContent(
        "Replay batch 2026-10-07",
      );
    });
    it("hidden for non-owner even with an id", async () => {
      await mount({ ...props(), isOwner: false, replayBatchId: "2026-10-07" });
      expect(screen.queryByTestId("replay-batch-badge")).toBeNull();
    });
    it("hidden when id is null or undefined", async () => {
      const { unmount } = render(
        <MessagesV2View {...props()} replayBatchId={null} />,
      );
      expect(screen.queryByTestId("replay-batch-badge")).toBeNull();
      unmount();
      render(<MessagesV2View {...props()} />);
      expect(screen.queryByTestId("replay-batch-badge")).toBeNull();
    });
  });
});
