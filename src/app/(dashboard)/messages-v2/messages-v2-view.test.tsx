import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeInstant } from "./chicago-time";
import { buildSnapshot } from "./hold-list";
import { MessagesV2View, type MessagesV2ViewProps } from "./messages-v2-view";
import type {
  OpenHold,
  PipelineCoverage,
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
      for (const m of ["select", "in", "eq", "order", "limit", "lt", "gt", "is", "not"]) q[m] = () => q;
      q.then = (resolve: (v: { data: never[] }) => unknown) => resolve({ data: [] });
      return q;
    }),
  };
  return { handlers, state, channel, client, refresh: vi.fn() };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: () => mocks.client }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const run = (id: string, over: Partial<RunWithSteps> = {}): RunWithSteps => ({
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

const openRules = async () => {
  await userEvent.click(screen.getByTestId("open-rules"));
  return screen.findByTestId("rules-panel");
};

describe("MessagesV2View rules panel", () => {
  const ruleBadges = [
    {
      label: "nurture",
      mode: "AUTO" as const,
      minConfidence: 0.95,
      rule: { minConfidence: 0.95, automationEnabled: true, version: 2 },
    },
    { label: "wrong_number", mode: "HELD" as const },
  ];

  it("replaces the header badges with one Sandra's rules button that opens a side panel", async () => {
    await mount({ ...props(), badges: ruleBadges });
    expect(screen.queryByText(/\[AUTO/)).not.toBeInTheDocument();
    expect(screen.getByTestId("open-rules")).toHaveTextContent("Sandra's rules");
    const panel = await openRules();
    expect(within(panel).getByRole("heading", { name: "Becomes a lead" })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Sandra handles alone" })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Waits for a person" })).toBeInTheDocument();
  });

  it("shows each switch in plain English with the cutoff as 'N% sure or more'", async () => {
    await mount({ ...props(), badges: ruleBadges });
    const panel = await openRules();
    expect(within(panel).getByText("On · 95% sure or more")).toBeInTheDocument();
    expect(within(panel).getByText("Off · waits for a person")).toBeInTheDocument();
    expect(panel).not.toHaveTextContent(/jev/i);
  });

  it("owners get a Change button on switches whose rule is known; others stay read-only", async () => {
    await mount({ ...props(), badges: ruleBadges });
    const panel = await openRules();
    expect(within(panel).getByRole("button", { name: "Edit rule for nurture" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Edit rule for wrong_number" })).not.toBeInTheDocument();
  });

  it("Acquisitions members see the switches read-only", async () => {
    await mount({ ...props(), isOwner: false, badges: ruleBadges });
    const panel = await openRules();
    expect(within(panel).getByText("On · 95% sure or more")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /Edit rule/ })).not.toBeInTheDocument();
  });
});

describe("MessagesV2View AI drafts control", () => {
  const setting = { configId: "cfg-1", replyGeneration: "off" as const };
  it("owner sees the toggle in the rules panel", async () => {
    await mount({ ...props(), replyGeneration: setting, setReplyGeneration: vi.fn() });
    await openRules();
    expect(screen.getByTestId("reply-generation-toggle")).toHaveTextContent("AI drafts: off");
  });
  it("acquisitions sees a read-only badge, no toggle", async () => {
    await mount({ ...props(), isOwner: false, replyGeneration: setting, setReplyGeneration: vi.fn() });
    await openRules();
    expect(screen.getByTestId("reply-generation-badge")).toHaveTextContent("AI drafts: off");
    expect(screen.queryByTestId("reply-generation-toggle")).toBeNull();
  });
  it("no control when the setting is unavailable", async () => {
    await mount(props());
    await openRules();
    expect(screen.queryByTestId("reply-generation-toggle")).toBeNull();
    expect(screen.queryByTestId("reply-generation-badge")).toBeNull();
  });
});

describe("MessagesV2View", () => {
  it("renders the header line, the tape and the waiting column with empty states", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Messages v2" })).toBeInTheDocument();
    expect(screen.getByTestId("header-status")).toHaveTextContent("Sandra is on");
    expect(screen.getByLabelText("Sandra's tape")).toBeInTheDocument();
    expect(screen.getByLabelText("Waiting for a person")).toBeInTheDocument();
    expect(screen.getByText(/no seller texts yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is waiting for you/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Shadow scorecard")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Legend")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/jev|luna/i);
  });

  it("shows 'N texts this week · right N% of the time' from the 7-day scorecard", async () => {
    const row = (outcome: string, runs: number, settled: number, agreed: number) => ({
      outcome,
      runs,
      auto_applied: 0,
      held: 0,
      auto_settled: settled,
      auto_agreed: agreed,
      held_decided: 0,
      held_agreed: 0,
      threshold: 0.9,
      automation_enabled: true,
      samples: [],
    });
    await mount({ ...props(), scorecardRows: [row("nurture", 7, 0, 0), row("not_interested", 196, 50, 47)] });
    expect(screen.getByTestId("header-status")).toHaveTextContent("203 texts this week · right 94% of the time");
  });

  it("omits the percentage when nothing has been confirmed yet", async () => {
    await mount({
      ...props(),
      scorecardRows: [
        { outcome: "nurture", runs: 7, auto_applied: 5, held: 2, auto_settled: 0, auto_agreed: 0, held_decided: 0, held_agreed: 0, threshold: 0.9, automation_enabled: true, samples: [] },
      ],
    });
    const text = screen.getByTestId("header-status").textContent ?? "";
    expect(text).toContain("7 texts this week");
    expect(text).not.toContain("right");
  });

  it("treats an empty rules list as unknown, not as 'Sandra is on'", async () => {
    await mount({ ...props(), badges: [] });
    const text = screen.getByTestId("header-status").textContent ?? "";
    expect(text).toContain("Rules not loaded");
    expect(text).not.toContain("Sandra is on");
  });

  const at = (minsAgo: number) => ({ since: new Date(NOW - minsAgo * 60_000).toISOString() });
  /** A server answering "Show older" with CURRENT details for the requested snapshot ids. */
  const byIdsServer = (current: () => OpenHold<RunWithSteps>[]) =>
    vi.fn(async (input: { ids: string[] }) => {
      const byId = new Map(current().map((h) => [h.id, h]));
      return {
        ok: true as const,
        data: {
          holds: input.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
          labels: [] as Array<[string, { name: string; address: null }]>,
          missing: input.ids.filter((id) => !byId.has(id)),
          unverified: 0,
          contextErrors: [] as string[],
        },
      };
    });

  it("'Show older' asks for the next snapshot ids and renders them in snapshot order", async () => {
    const all = [1, 2, 3, 4, 5].map((m) => ({ ...openHold(`h${m}`), ...at(m) }));
    const loadOlderHolds = byIdsServer(() => all);
    await mount({ ...props([], all.slice(0, 3)), holdsSnapshot: buildSnapshot(all), loadOlderHolds });
    expect(screen.getByTestId("waiting-count")).toHaveTextContent("5");
    expect(screen.getByTestId("not-loaded-count")).toHaveTextContent("2 more not shown yet");
    await userEvent.click(screen.getByTestId("show-older"));
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(5));
    expect(loadOlderHolds).toHaveBeenCalledWith({ ids: ["h4", "h5"] });
    expect(screen.queryByTestId("show-older")).toBeNull();
  });

  it("holds handled since the snapshot come back missing: not rendered, counted out, with a note", async () => {
    const all = [1, 2, 3, 4, 5].map((m) => ({ ...openHold(`h${m}`), ...at(m) }));
    const loadOlderHolds = byIdsServer(() => all.filter((h) => h.id !== "h5"));
    await mount({ ...props([], all.slice(0, 3)), holdsSnapshot: buildSnapshot(all), loadOlderHolds });
    await userEvent.click(screen.getByTestId("show-older"));
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(4));
    expect(screen.getByTestId("holds-missing")).toHaveTextContent("1 was handled or is no longer available since this list loaded.");
    expect(screen.getByTestId("waiting-count")).toHaveTextContent("4");
  });

  it("a hold arriving after the snapshot is not inserted; order stays the snapshot's", async () => {
    let server = [1, 2, 3, 4].map((m) => ({ ...openHold(`h${m}`), ...at(m) }));
    const snapshot = buildSnapshot(server);
    const loadOlderHolds = byIdsServer(() => server);
    await mount({ ...props([], server.slice(0, 2)), holdsSnapshot: snapshot, loadOlderHolds });
    server = [{ ...openHold("brand-new"), ...at(0.1) }, ...server];
    await userEvent.click(screen.getByTestId("show-older"));
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(4));
    expect(loadOlderHolds).toHaveBeenCalledWith({ ids: ["h3", "h4"] });
  });

  it("a failed 'Show older' keeps the position: the retry asks for the same ids", async () => {
    const all = [1, 2, 3].map((m) => ({ ...openHold(`h${m}`), ...at(m) }));
    const ok = byIdsServer(() => all);
    const loadOlderHolds = vi
      .fn<(i: { ids: string[] }) => ReturnType<typeof ok>>()
      .mockResolvedValueOnce({ ok: false, error: { code: "X", message: "Older waiting texts could not be loaded." } } as never)
      .mockImplementation(ok);
    await mount({ ...props([], all.slice(0, 1)), holdsSnapshot: buildSnapshot(all), loadOlderHolds });
    await userEvent.click(screen.getByTestId("show-older"));
    await waitFor(() => expect(screen.getByTestId("older-error")).toBeInTheDocument());
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(1);
    await userEvent.click(screen.getByTestId("show-older"));
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(3));
    expect(loadOlderHolds.mock.calls.map((c) => c[0].ids)).toEqual([["h2", "h3"], ["h2", "h3"]]);
  });

  it("R2: a reason changed after the snapshot renders the snapshot reason (card = tape tag) and locks the card's actions", async () => {
    const snapHold = { ...openHold("p45"), ...at(5), flag_reason: "hostile_needs_confirm", seen: { through: null, flagReason: "hostile_needs_confirm", flagAt: "2026-10-01T00:00:00.000000Z" } };
    const liveHold = { ...snapHold, flag_reason: "model:price_or_offer", seen: { through: null, flagReason: "model:price_or_offer", flagAt: "2026-10-02T00:00:00.000000Z" } };
    const others = [1, 2].map((m) => ({ ...openHold(`p${m}`), ...at(m) }));
    const loadOlderHolds = byIdsServer(() => [...others, liveHold]);
    const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
    await mount({ ...props([], others), holdsSnapshot: buildSnapshot([...others, snapHold]), loadOlderHolds, actions });
    await userEvent.click(screen.getByTestId("show-older"));
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(3));
    const card = screen.getAllByTestId("waiting-card")[2];
    expect(within(card).getByTestId("waiting-reason")).toHaveTextContent("Hostile text. Nothing sent.");
    expect(within(card).getByTestId("hold-changed")).toHaveTextContent("Changed since this list loaded. Refresh to act.");
    for (const b of within(card).getAllByRole("button").filter((el) => el.getAttribute("data-testid") !== "hold-refresh")) expect(b).toBeDisabled();
    expect(actions.dismiss).not.toHaveBeenCalled();
  });

  it("flag cleared while another source is still pending: actions locked; after a refresh they work and send the NEW version", async () => {
    const snapHold = { ...openHold("p9"), ...at(5), sources: ["needs_attention", "jev_decision"] as OpenHold["sources"], flag_reason: "model:unclear", seen: { through: "2026-10-01T00:00:00Z", flagReason: "model:unclear", flagAt: "2026-10-01T00:00:00.000000Z" } };
    const cleared = { ...snapHold, sources: ["jev_decision"] as OpenHold["sources"], flag_reason: null, seen: { through: "2026-10-01T00:00:00Z", flagReason: null, flagAt: null } };
    const dismiss = vi.fn(async () => ({ ok: true as const, data: null }));
    const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss, listAssignees: vi.fn() };
    const { rerender } = render(<MessagesV2View {...props([], [cleared])} holdsSnapshot={buildSnapshot([snapHold])} actions={actions} />);
    expect(screen.getByTestId("hold-changed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
    // Refresh: the server sends a new snapshot built from the live state.
    rerender(<MessagesV2View {...props([], [cleared])} holdsSnapshot={buildSnapshot([cleared])} actions={actions} />);
    expect(screen.queryByTestId("hold-changed")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await userEvent.type(screen.getByLabelText("Reason for dismissing"), "done");
    await userEvent.click(screen.getByRole("button", { name: "Confirm dismiss" }));
    expect(dismiss).toHaveBeenCalledWith(expect.objectContaining({ propertyId: "p9", seen: expect.objectContaining({ flagReason: null, flagAt: null }) }));
  });

  it("a pinned NULL snapshot reason is not overridden by a live reason from a loaded earlier day", async () => {
    const held = run("r-null", { status: "held", reason: "model:price_or_offer", started_at: new Date(NOW - 60_000).toISOString() });
    const loadTapeDay = vi.fn(async () => ({
      ok: true as const,
      data: { runs: [], labels: [], threads: [], failedRunIds: [], flagReasons: [["r-null", "model:opt_out"]] as Array<[string, string]> },
    }));
    await mount({ ...props([held]), flagReasons: [["r-null", null]], loadTapeDay });
    const tagBefore = within(screen.getByTestId("tape-card")).getByTestId("tape-tag").textContent;
    expect(tagBefore).toBe("Waits for a person");
    await userEvent.click(screen.getByTestId("show-earlier"));
    await waitFor(() => expect(loadTapeDay).toHaveBeenCalled());
    expect(within(screen.getByTestId("tape-card")).getByTestId("tape-tag")).toHaveTextContent("Waits for a person");
    expect(within(screen.getByTestId("tape-card")).getByTestId("tape-sentence")).toHaveTextContent("Needs a person to look at it. Nothing sent.");
  });

  it("card: a pinned NULL snapshot reason shows the neutral sentence even when the run carries an old reason, same as the tape", async () => {
    const r = run("rr", { property_id: "p7", status: "held", reason: "model:price_or_offer" });
    const hold = { ...openHold("p7", r), ...at(5), flag_reason: null };
    await mount({ ...props([r], [hold]), holdsSnapshot: buildSnapshot([hold]), flagReasons: [["rr", null]] });
    expect(screen.getByTestId("waiting-reason")).toHaveTextContent("Needs a person to look at it. Nothing sent.");
    expect(within(screen.getByTestId("tape-card")).getByTestId("tape-sentence")).toHaveTextContent("Needs a person to look at it. Nothing sent.");
  });

  it("same reason but a new flag time after the snapshot: marked Updated and actions locked", async () => {
    const snapHold = { ...openHold("p8"), ...at(5), flag_reason: "model:unclear", seen: { through: null, flagReason: "model:unclear", flagAt: "2026-10-01T00:00:00.000000Z" } };
    const reflagged = { ...snapHold, seen: { through: null, flagReason: "model:unclear", flagAt: "2026-10-05T00:00:00.000000Z" } };
    const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
    await mount({ ...props([], [reflagged]), holdsSnapshot: buildSnapshot([snapHold]), actions });
    expect(screen.getByTestId("hold-updated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  });

  it("within one poll, a locked hold is removed and a re-stamped hold is marked Updated with actions locked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const a = { ...openHold("aaaa"), ...at(1), flag_reason: "model:unclear", seen: { through: null, flagReason: "model:unclear", flagAt: "2026-10-01T00:00:00.000000Z" } };
      const b = { ...openHold("bbbb"), ...at(2), flag_reason: "model:unclear", seen: { through: null, flagReason: "model:unclear", flagAt: "2026-10-01T00:00:00.000000Z" } };
      const snapshot = buildSnapshot([a, b]);
      const revalidateHolds = vi.fn(async (input: { ids: string[] }) => ({
        ok: true as const,
        data: input.ids.map((id) =>
          id === "aaaa"
            ? { id, eligible: false, flagAt: null, flagReason: null, runId: null, activityAt: null, through: null, draftId: null, draftProperty: null, draftSendable: false }
            : { id, eligible: true, flagAt: "2026-10-09T00:00:00.000000Z", flagReason: "hostile_needs_confirm", runId: null, activityAt: snapshot.entries[1].at, through: null, draftId: null, draftProperty: null, draftSendable: false },
        ),
      }));
      const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
      await mount({ ...props([], [a, b]), holdsSnapshot: snapshot, revalidateHolds, actions });
      expect(screen.getAllByTestId("waiting-card")).toHaveLength(2);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(1));
      expect(screen.getByTestId("holds-missing")).toBeInTheDocument();
      expect(screen.getByTestId("hold-updated")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("thread text: an older fetch resolving after a newer one never overwrites the newer sent reply", async () => {
    const realFrom = mocks.client.from.getMockImplementation()!;
    let releaseOld: () => void = () => {};
    const oldGate = new Promise<void>((r) => (releaseOld = r));
    let phase: "old" | "new" = "old";
    mocks.client.from.mockImplementation(((table: string) => {
      const q = (realFrom as (t: string) => Record<string, unknown>)(table);
      if (table !== "messages") return q;
      const tag = phase;
      const then = q.then as (res: (v: unknown) => unknown) => unknown;
      q.then = (resolve: (v: unknown) => unknown) => {
        const data = tag === "new" ? [{ id: "o1", body: "Thanks, take care.", created_at: "2026-10-14T12:00:00Z" }] : [];
        const finish = () => resolve({ data, error: null });
        return tag === "old" ? oldGate.then(finish) : (void then, finish());
      };
      return q;
    }) as never);
    try {
      const r = run("v", { conversation_id: "c1", inbound_message_id: "", outbound_message_id: null, status: "running" });
      await mount({ ...props([r]), threads: [] });
      phase = "new";
      await fire("UPDATE", "pipeline_runs", run("v", { conversation_id: "c1", inbound_message_id: "", outbound_message_id: "o1", status: "replied", completed_at: new Date().toISOString() }));
      await waitFor(() => expect(screen.getByTestId("tape-reply")).toHaveTextContent("Thanks, take care."));
      await act(async () => {
        releaseOld();
        await oldGate;
      });
      expect(screen.getByTestId("tape-reply")).toHaveTextContent("Thanks, take care.");
    } finally {
      mocks.client.from.mockImplementation(realFrom as never);
    }
  });

  it("a failed re-check pauses every card's actions; the next successful check re-enables them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const a = { ...openHold("aaaa"), ...at(1) };
      const snapshot = buildSnapshot([a]);
      let fail = true;
      const revalidateHolds = vi.fn(async (input: { ids: string[] }) =>
        fail
          ? { ok: false as const, error: { code: "X", message: "x" } }
          : { ok: true as const, data: input.ids.map((id) => ({ id, eligible: true, flagAt: snapshot.entries[0].fa, flagReason: null, runId: null, activityAt: snapshot.entries[0].at, through: null, draftId: null, draftProperty: null, draftSendable: false })) },
      );
      const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
      await mount({ ...props([], [a]), holdsSnapshot: snapshot, revalidateHolds, actions });
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(screen.getByTestId("holds-recheck-failed")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
      fail = false;
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(screen.queryByTestId("holds-recheck-failed")).toBeNull());
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a displayed draft moved to another property between checks: card marked Updated and actions disabled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const a = { ...openHold("aaaa"), ...at(1), draft: { id: "d1", inbound_message_id: null, body: "hi" }, draft_held: true };
      const snapshot = buildSnapshot([a]);
      const revalidateHolds = vi.fn(async (input: { ids: string[] }) => ({
        ok: true as const,
        // Still eligible (an independent flag keeps it open) but the shown draft now belongs elsewhere.
        data: input.ids.map((id) => ({ id, eligible: true, flagAt: snapshot.entries[0].fa, flagReason: null, runId: null, activityAt: snapshot.entries[0].at, through: null, draftId: null, draftProperty: null, draftSendable: false })),
      }));
      const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
      await mount({ ...props([], [a]), holdsSnapshot: snapshot, revalidateHolds, actions });
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(screen.getByTestId("hold-updated")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("overlapping re-checks: the newer fails, the older succeeds later -> actions stay disabled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const a = { ...openHold("aaaa"), ...at(1) };
      const snapshot = buildSnapshot([a]);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let calls = 0;
      const revalidateHolds = vi.fn(async (input: { ids: string[] }) => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return { ok: true as const, data: input.ids.map((id) => ({ id, eligible: true, flagAt: snapshot.entries[0].fa, flagReason: null, runId: null, activityAt: snapshot.entries[0].at, through: null, draftId: null, draftProperty: null, draftSendable: false })) };
        }
        return { ok: false as const, error: { code: "X", message: "x" } };
      });
      const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
      await mount({ ...props([], [a]), holdsSnapshot: snapshot, revalidateHolds, actions });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(screen.getByTestId("holds-recheck-failed")).toBeInTheDocument());
      await act(async () => {
        release();
        await gate;
      });
      expect(screen.getByTestId("holds-recheck-failed")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the displayed draft moves while through/activity stay equal: card Updated and Send/Edit disabled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const a = { ...openHold("aaaa"), ...at(1), draft: { id: "d1", inbound_message_id: "m1", body: "hi", sendable: true }, draft_held: true };
      const snapshot = buildSnapshot([a]);
      const revalidateHolds = vi.fn(async (input: { ids: string[] }) => ({
        ok: true as const,
        data: input.ids.map((id) => ({ id, eligible: true, flagAt: snapshot.entries[0].fa, flagReason: null, runId: null, activityAt: snapshot.entries[0].at, through: null, draftId: "d2", draftProperty: "aaaa", draftSendable: true })),
      }));
      const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
      await mount({ ...props([], [a]), holdsSnapshot: snapshot, revalidateHolds, actions });
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(screen.getByTestId("hold-updated")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a re-check removes a card while an older request is in flight: the card stays removed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const all = [1, 2, 3, 4, 5].map((m) => ({ ...openHold(`h${m}`), ...at(m) }));
      const snapshot = buildSnapshot(all);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const server = byIdsServer(() => all);
      const loadOlderHolds = vi.fn(async (input: { ids: string[] }) => {
        await gate;
        return server(input);
      });
      const revalidateHolds = vi.fn(async (input: { ids: string[] }) => ({
        ok: true as const,
        data: input.ids.map((id) => {
          const e = snapshot.entries.find((x) => x.id === id)!;
          return id === "h1"
            ? { id, eligible: false, flagAt: null, flagReason: null, runId: null, activityAt: null, through: null, draftId: null, draftProperty: null, draftSendable: false }
            : { id, eligible: true, flagAt: e.fa, flagReason: null, runId: null, activityAt: e.at, through: null, draftId: null, draftProperty: null, draftSendable: false };
        }),
      }));
      await mount({ ...props([], all.slice(0, 3)), holdsSnapshot: snapshot, loadOlderHolds, revalidateHolds });
      await act(async () => {
        screen.getByTestId("show-older").click();
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(2));
      await act(async () => {
        release();
        await gate;
      });
      await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(4));
      expect(screen.queryByText(/h1/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a delayed earlier-day response carrying an older version of a run never overwrites the newer reply", async () => {
    const newer = run("v", { conversation_id: "c1", outbound_message_id: "o1", status: "replied" });
    const older = run("v", { conversation_id: "c1", outbound_message_id: null, status: "running" });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const loadTapeDay = vi.fn(async () => {
      await gate;
      return {
        ok: true as const,
        data: { runs: [older], labels: [] as Array<[string, { name: string; address: null }]>, threads: [["v", { lastOutbound: null, reply: "STALE reply" }]] as Array<[string, { lastOutbound: string | null; reply: string | null }]>, failedRunIds: [], flagReasons: [] },
      };
    });
    await mount({ ...props([newer]), threads: [["v", { lastOutbound: null, reply: "Thanks, take care." }]], loadTapeDay });
    await act(async () => {
      screen.getByTestId("show-earlier").click();
    });
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(loadTapeDay).toHaveBeenCalled());
    expect(screen.queryByText("STALE reply")).toBeNull();
    expect(screen.getAllByTestId("tape-reply")[0]).toHaveTextContent("Thanks, take care.");
  });

  it("a flagged hold with a reason but no flag time: Dismiss sends the snapshot reason (and a null time), not null", async () => {
    const h = { ...openHold("p5"), ...at(3), flag_reason: "model:unclear", seen: { through: null, flagReason: "model:unclear", flagAt: null } };
    const dismiss = vi.fn(async () => ({ ok: true as const, data: null }));
    const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss, listAssignees: vi.fn() };
    await mount({ ...props([], [h]), holdsSnapshot: buildSnapshot([h]), actions });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await userEvent.type(screen.getByLabelText("Reason for dismissing"), "done");
    await userEvent.click(screen.getByRole("button", { name: "Confirm dismiss" }));
    expect(dismiss).toHaveBeenCalledWith(expect.objectContaining({ seen: { through: null, flagReason: "model:unclear", flagAt: null } }));
  });

  it("a pending row that arrived after the snapshot (newer seen.through): card Updated, actions disabled; never sends the newer version", async () => {
    const snapHold = { ...openHold("p6"), ...at(3), seen: { through: "2026-10-01T00:00:00Z", flagReason: null, flagAt: null } };
    const enriched = { ...snapHold, seen: { through: "2026-10-02T00:00:00Z", flagReason: null, flagAt: null } };
    const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
    await mount({ ...props([], [enriched]), holdsSnapshot: buildSnapshot([snapHold]), actions });
    expect(screen.getByTestId("hold-updated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  });

  it("an unchanged card sends the snapshot's pending-row version with Dismiss", async () => {
    const h = { ...openHold("p7"), ...at(3), seen: { through: "2026-10-01T00:00:00Z", flagReason: null, flagAt: null } };
    const dismiss = vi.fn(async () => ({ ok: true as const, data: null }));
    const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss, listAssignees: vi.fn() };
    await mount({ ...props([], [h]), holdsSnapshot: buildSnapshot([h]), actions });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await userEvent.type(screen.getByLabelText("Reason for dismissing"), "done");
    await userEvent.click(screen.getByRole("button", { name: "Confirm dismiss" }));
    expect(dismiss).toHaveBeenCalledWith(expect.objectContaining({ seen: expect.objectContaining({ through: "2026-10-01T00:00:00Z" }) }));
  });

  it("a draft not tied directly to the lead and its seller text: Send and Edit disabled on the card", async () => {
    const h = { ...openHold("p8"), ...at(3), draft: { id: "d8", inbound_message_id: null, body: "hi", sendable: false }, draft_held: true };
    const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
    await mount({ ...props([], [h]), holdsSnapshot: buildSnapshot([h]), actions });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByTestId("draft-not-sendable")).toHaveTextContent("Can't send from here yet, open the thread.");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });

  it("renders the snapshot time, not the live time", async () => {
    const snapHold = { ...openHold("p1"), since: "2026-10-01T10:00:00.000Z" };
    const snapshot = buildSnapshot([snapHold]);
    await mount({ ...props([], [{ ...snapHold, last_activity: "2026-10-09T10:00:00.000Z" }]), holdsSnapshot: snapshot });
    expect(screen.getByTestId("waiting-time").querySelector("time")!.getAttribute("datetime")).toBe(normalizeInstant(snapHold.since));
    expect(screen.getByTestId("hold-updated")).toBeInTheDocument();
  });

  it("fails closed: when the waiting list could not be verified it shows the error and a retry, and no cards", async () => {
    await mount({ ...props([], []), holdsError: "Waiting list could not be loaded. Reload to retry." });
    expect(screen.getByTestId("holds-split-unavailable")).toHaveTextContent("Waiting list could not be loaded. Reload to retry.");
    expect(screen.queryAllByTestId("waiting-card")).toHaveLength(0);
    expect(screen.queryByText(/nothing is waiting for you/i)).toBeNull();
    await userEvent.click(screen.getByTestId("holds-retry"));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows times in America/Chicago and files a 7:30 PM Chicago run under the right day", async () => {
    // 00:30 UTC on Oct 15 is 7:30 PM CDT on Oct 14. In the browser's own zone (or UTC) it could read as Oct 15.
    const evening = run("late", { started_at: "2026-10-15T00:30:00.000Z", status: "closed" });
    await mount({ ...props([evening]), nowMs: Date.parse("2026-10-15T15:00:00Z") });
    const card = screen.getByTestId("tape-card");
    expect(within(card).getByText("7:30 PM")).toBeInTheDocument();
    expect(screen.getByTestId("tape-day")).toHaveTextContent("Yesterday");
  });

  it("waiting cards show their time in Chicago too", async () => {
    await mount(props([], [{ ...openHold("p1"), since: "2026-10-15T00:30:00.000Z" }]));
    expect(screen.getByTestId("waiting-time")).toHaveTextContent("Oct 14, 7:30 PM");
  });

  it("shows a failed alert and load warnings as short plain lines", async () => {
    const held = { ...openHold("p1"), alert: { status: "failed" as const, reason: "x" } };
    await mount({
      ...props([], [held]),
      holdsMeta: { total: 1, shown: 1, truncated: false, totalState: "exact", failed: [], contextErrors: ["step lookup"], deadLetterUnavailable: true },
    });
    expect(screen.getByTestId("hold-alert")).toHaveTextContent("Alert failed");
    expect(screen.getByTestId("holds-context-errors")).toHaveTextContent("Some details could not be loaded");
    expect(screen.getByTestId("dead-letter-unavailable")).toBeInTheDocument();
  });

  it("does not claim Sandra is on when the rule status could not be loaded", async () => {
    await mount({ ...props(), badgesError: "Mode badges unavailable — x" });
    const text = screen.getByTestId("header-status").textContent ?? "";
    expect(text).toContain("couldn't be checked");
    expect(text).not.toContain("Sandra is on");
  });

  it("Open thread is a plain link, separate from the Take over button that switches Sandra off", async () => {
    const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
    await mount({ ...props([], [openHold("p1")]), actions });
    const link = screen.getByRole("link", { name: "Open thread" });
    expect(link).toHaveAttribute("href", "/leads/p1");
    expect(screen.getByRole("button", { name: "Take over (Sandra stops)" })).toBeInTheDocument();
  });

  it("continues the same Chicago day from the oldest run returned when a day comes back full", async () => {
    const runs = Array.from({ length: 200 }, (_, i) => run(`y${i}`, { started_at: new Date(NOW - 3600_000 * 2 - i * 60_000).toISOString(), status: "closed" }));
    const loadTapeDay = vi.fn(async () => ({ ok: true as const, data: { runs, labels: [], threads: [], failedRunIds: [], flagReasons: [] } }));
    await mount({ ...props([run("today", { started_at: new Date(NOW).toISOString() })]), loadTapeDay });
    await userEvent.click(screen.getByTestId("show-earlier"));
    await waitFor(() => expect(screen.getByTestId("show-earlier")).not.toBeDisabled());
    await userEvent.click(screen.getByTestId("show-earlier"));
    await waitFor(() => expect(loadTapeDay).toHaveBeenCalledTimes(2));
    const calls = loadTapeDay.mock.calls as unknown as Array<[{ day: string; before: { at: string; id: string } | null }]>;
    expect(calls[1][0].day).toBe(calls[0][0].day);
    expect(calls[1][0].before).toEqual({ at: runs[199].started_at, id: "y199" }); // (started_at, id) cursor from the last row returned
  });

  it("skips empty days on its own so one click shows the next day with texts", async () => {
    const loadTapeDay = vi.fn(async (_input: { day: string }) => ({
      ok: true as const,
      data: { runs: loadTapeDay.mock.calls.length < 3 ? [] : [run("found", { started_at: new Date(NOW - 5 * 86_400_000).toISOString(), status: "closed" })], labels: [], threads: [], failedRunIds: [], flagReasons: [] },
    }));
    await mount({ ...props([run("today")]), loadTapeDay });
    await userEvent.click(screen.getByTestId("show-earlier"));
    await waitFor(() => expect(screen.getAllByTestId("tape-card")).toHaveLength(2));
    expect(loadTapeDay).toHaveBeenCalledTimes(3);
    const days = (loadTapeDay.mock.calls as unknown as Array<[{ day: string }]>).map((c) => c[0].day);
    expect(new Set(days).size).toBe(3);
  });

  it("says Sandra is watching, not on, when every rule is watch-only", async () => {
    await mount({ ...props(), badges: [{ label: "nurture", mode: "SHADOW" as const }] });
    expect(screen.getByTestId("header-status")).toHaveTextContent("watching");
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

  it("shows 'Sandra is reading…' for a streamed run, then the plain decision as steps arrive, without refreshing", async () => {
    await mount(props([run("old", { started_at: new Date(NOW - 60_000).toISOString() })]));
    await fire("INSERT", "pipeline_runs", run("new"));
    const cards = screen.getAllByTestId("tape-card");
    expect(cards[0]).toHaveTextContent("hello new");
    expect(within(cards[0]).getByTestId("tape-reading")).toHaveTextContent("Sandra is reading…");
    await fire("INSERT", "pipeline_run_steps", {
      id: "s1",
      run_id: "new",
      org_id: "o",
      seq: 1,
      kind: "jev",
      name: "classify",
      result: "pass",
      detail: { outcome: "not_interested" },
      created_at: "",
    } satisfies PipelineRunStep);
    const card = screen.getAllByTestId("tape-card")[0];
    expect(within(card).getByTestId("tape-tag")).toHaveTextContent("Not interested");
    expect(within(card).getByTestId("tape-sentence")).toHaveTextContent("Sandra: They said no.");
    expect(within(card).queryByTestId("tape-reading")).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("says 'Replying in a few minutes' while a reply is scheduled, then shows the sent reply", async () => {
    await mount(props([run("a", { outbound_message_id: null })]));
    await fire("INSERT", "pipeline_run_steps", {
      id: "s1", run_id: "a", org_id: "o", seq: 1, kind: "jev", name: "classify", result: "pass",
      detail: { outcome: "nurture" }, created_at: "",
    } satisfies PipelineRunStep);
    await fire("INSERT", "pipeline_run_steps", {
      id: "s2", run_id: "a", org_id: "o", seq: 2, kind: "action", name: "reply_delay_scheduled", result: "applied",
      detail: { delaySeconds: 240 }, created_at: "",
    } satisfies PipelineRunStep);
    expect(screen.getByTestId("tape-did")).toHaveTextContent("Replying in a few minutes");
    expect(screen.getByTestId("tape-card")).toHaveAttribute("data-stage", "replying");
    await fire("UPDATE", "pipeline_runs", run("a", { status: "replied", completed_at: new Date().toISOString() }));
    expect(screen.getByTestId("tape-card")).toHaveAttribute("data-stage", "sent");
    expect(screen.getByTestId("tape-did")).toHaveTextContent("Reply sent");
  });

  it("never shows engine step names on a card", async () => {
    const steps: PipelineRunStep[] = ["claim", "resolve_threshold", "reply_delay_scheduled", "needs_attention"].map((name, i) => ({
      id: `s${i}`, run_id: "a", org_id: "o", seq: i + 1, kind: i === 1 ? "threshold" : i === 3 ? "hold" : "action",
      name, result: "applied", detail: {}, created_at: "",
    }));
    await mount(props([run("a", { status: "held", reason: "model:price_or_offer", steps })]));
    const text = screen.getByTestId("tape-card").textContent ?? "";
    for (const word of ["claim", "resolve_threshold", "reply_delay_scheduled", "needs_attention", "luna_suggest", "gates passed"]) {
      expect(text).not.toContain(word);
    }
    expect(screen.getByTestId("tape-tag")).toHaveTextContent("Talked price");
  });

  it("turns an already_terminal skip into one quiet card with the seller's text", async () => {
    await mount(props([run("a", { status: "skipped", reason: "already_terminal", steps: [
      { id: "g", run_id: "a", org_id: "o", seq: 1, kind: "gate", name: "already_terminal", result: "block", detail: {}, created_at: "" },
    ] })]));
    const card = screen.getByTestId("tape-card");
    expect(card).toHaveAttribute("data-kind", "quiet");
    expect(card).toHaveTextContent("hello a");
    expect(screen.getByTestId("tape-quiet")).toHaveTextContent("Already a lead, left for the person who owns it");
    expect(within(card).queryByTestId("tape-tag")).toBeNull();
  });

  it("a held run alone does not open a waiting card", async () => {
    await mount(props([run("a")]));
    await fire("UPDATE", "pipeline_runs", run("a", { status: "held", completed_at: new Date().toISOString() }));
    expect(screen.queryByTestId("tape-reading")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("waiting-card")).toHaveLength(0);
  });

  it("orders tape runs within the same millisecond by microseconds, like the server", async () => {
    const a = run("micro-a", { started_at: "2026-10-14T12:00:00.123100+00:00", inbound_preview: "first" });
    const b = run("micro-b", { started_at: "2026-10-14T12:00:00.123900+00:00", inbound_preview: "second" });
    await mount(props([a, b]));
    const cards = screen.getAllByTestId("tape-card").map((c) => c.textContent ?? "");
    expect(cards[0]).toContain("second");
    expect(cards[1]).toContain("first");
  });

  it("a run or step arriving after the snapshot does not change a waiting card's run or time; it only marks it Updated", async () => {
    const shown = run("snap-run", { property_id: "p1", status: "held", started_at: new Date(NOW - 3600_000).toISOString() });
    const held = { ...openHold("p1", shown), since: new Date(NOW - 7200_000).toISOString() };
    await mount(props([shown], [held]));
    const before = screen.getByTestId("waiting-time").textContent;
    await fire("INSERT", "pipeline_runs", run("live-run", { property_id: "p1", started_at: new Date(NOW).toISOString() }));
    await fire("INSERT", "pipeline_run_steps", {
      id: "late", run_id: "snap-run", org_id: "o", seq: 9, kind: "action", name: "x", result: "applied", detail: {}, created_at: new Date(NOW).toISOString(),
    } satisfies PipelineRunStep);
    expect(screen.getByTestId("waiting-time").textContent).toBe(before);
    expect(screen.getByTestId("hold-updated")).toHaveTextContent("Updated · refresh to reorder");
  });

  it("keeps the waiting list in exactly the order the server sent (the server owns the order)", async () => {
    const hold = (id: string, minsAgo: number) => ({ ...openHold(id), since: new Date(NOW - minsAgo * 60_000).toISOString() });
    const sent = [hold("newest", 5), hold("middle", 120), hold("old", 600)];
    await mount(props([], sent));
    const times = screen.getAllByTestId("waiting-time").map((el) => el.querySelector("time")!.getAttribute("datetime")!);
    expect(times).toEqual(sent.map((h) => normalizeInstant(h.since)));
  });

  it("a run whose thread text failed on the server shows a retry note and is fetched again in the browser", async () => {
    const r = run("t1", { conversation_id: "c1" });
    await mount({ ...props([r]), threads: [], threadFailedRunIds: ["t1"] });
    expect(screen.getByTestId("threads-retrying")).toHaveTextContent("Some texts couldn't load. Retrying");
    await waitFor(() => expect(mocks.client.from).toHaveBeenCalledWith("messages"));
  });

  it("renders server-derived holds with a plain reason and relabelled actions, including a runless card", async () => {
    const actions = { send: vi.fn(), editAndSend: vi.fn(), takeOver: vi.fn(), assign: vi.fn(), dismiss: vi.fn(), listAssignees: vi.fn() };
    await mount({ ...props([run("a")], [openHold("p1", run("a", { status: "closed" })), openHold("p2")], null), actions });
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(2);
    expect(screen.getByTestId("waiting-count")).toHaveTextContent("2");
    expect(screen.getAllByRole("link", { name: "Open thread" })).toHaveLength(2);
    expect(actions.takeOver).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Take over (Sandra stops)" })).toHaveLength(2);
  });

  it("stays quiet while coverage is healthy and highlights a gap", async () => {
    const { unmount } = render(
      <MessagesV2View {...props([], [], { inboundMessages: 3, runs: 3 })} />,
    );
    expect(screen.queryByTestId("coverage")).toBeNull();
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
    expect(screen.getByTitle("Live")).toBeInTheDocument();
    await act(async () => mocks.state.status!("CHANNEL_ERROR"));
    expect(screen.getByTitle("Connecting")).toBeInTheDocument();
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

  it("shows a plain failure line, not an empty column, when a hold source failed", async () => {
    const m = { total: 0, shown: 0, truncated: false, totalState: "exact" as const, failed: ["needs_attention" as const], contextErrors: [] };
    await mount({ ...props(), holdsMeta: m });
    expect(screen.getByTestId("holds-unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/nothing is waiting for you/i)).toBeNull();
  });

  it("'Show older' reveals the loaded holds beyond the first 20 before asking the server", async () => {
    const holds = Array.from({ length: 22 }, (_, i) => ({ ...openHold(`h${i}`), since: new Date(NOW - (i + 1) * 60_000).toISOString() }));
    const ancient = { ...openHold("ancient"), since: new Date(NOW - 99 * 86_400_000).toISOString() };
    const loadOlderHolds = vi.fn(async () => ({
      ok: true as const,
      data: { holds: [ancient], labels: [], missing: [], unverified: 0, contextErrors: [] },
    }));
    await mount({ ...props([], holds), holdsSnapshot: buildSnapshot([...holds, ancient]), loadOlderHolds });
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(20);
    await userEvent.click(screen.getByTestId("show-older"));
    expect(screen.getAllByTestId("waiting-card")).toHaveLength(22);
    expect(loadOlderHolds).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("show-older"));
    await waitFor(() => expect(screen.getAllByTestId("waiting-card")).toHaveLength(23));
    expect(loadOlderHolds).toHaveBeenCalledTimes(1);
  });

  it("'Show yesterday's tape' loads the earlier day and shows it under its own day heading", async () => {
    const yesterdayRun = run("y1", { started_at: new Date(NOW - 20 * 3600_000).toISOString(), status: "closed" });
    const loadTapeDay = vi.fn(async () => ({
      ok: true as const,
      data: { runs: [yesterdayRun], labels: [["y1", { name: "Casey", address: null }]] as Array<[string, { name: string; address: null }]>, threads: [], failedRunIds: [], flagReasons: [] },
    }));
    await mount({ ...props([run("today")]), loadTapeDay });
    expect(screen.getAllByTestId("tape-card")).toHaveLength(1);
    await userEvent.click(screen.getByTestId("show-earlier"));
    await waitFor(() => expect(screen.getAllByTestId("tape-card")).toHaveLength(2));
    expect(loadTapeDay).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("show-earlier")).toHaveTextContent("Show the day before");
  });

  it("shows 'Feed unavailable' instead of the empty-feed message when the feed query failed", async () => {
    await mount({ ...props(), feedError: "Feed unavailable — timeout" });
    expect(screen.getByTestId("feed-unavailable")).toHaveTextContent(
      "Feed unavailable — timeout",
    );
    expect(screen.queryByText(/no seller texts yet/i)).toBeNull();
  });

  it("shows step and badge failures explicitly", async () => {
    await mount({
      ...props(),
      stepsUnavailable: true,
      badgesError: "Mode badges unavailable — x",
    });
    expect(screen.getByTestId("steps-unavailable")).toBeInTheDocument();
    await openRules();
    expect(screen.getByTestId("badges-unavailable")).toHaveTextContent("Mode badges unavailable");
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
