import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callbacks, channelOn, eq, maybeSingle, removeChannel, setAuth } =
  vi.hoisted(() => ({
    callbacks: {} as Record<string, (payload: { new: unknown }) => void>,
    channelOn: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
    removeChannel: vi.fn(),
    setAuth: vi.fn(),
  }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const query = {
      select: vi.fn(() => query),
      eq: eq.mockImplementation(() => query),
      maybeSingle,
    };
    const channel = {
      on: channelOn.mockImplementation(
        (
          _kind: string,
          config: { event: "INSERT" | "UPDATE" },
          callback: (payload: { new: unknown }) => void,
        ) => {
          callbacks[config.event] = callback;
          return channel;
        },
      ),
      subscribe: vi.fn(() => channel),
    };
    return {
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "test-token" } },
        })),
      },
      channel: vi.fn(() => channel),
      from: vi.fn(() => query),
      realtime: { setAuth },
      removeChannel,
    };
  },
}));

import {
  LeadCallSummary,
  type CallActivityRollupRow,
} from "./lead-call-summary";

const timestamp = "2026-05-06T15:00:00.000Z";

function recording(overrides: Record<string, unknown> = {}) {
  return {
    id: "recording-1",
    call_activity_id: "call-1",
    status: "available",
    storage_path: "calls/session/call-1.wav",
    duration_seconds: 42,
    error_code: null,
    error_message: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function transcript(overrides: Record<string, unknown> = {}) {
  return {
    id: "transcript-1",
    call_activity_id: "call-1",
    status: "available",
    text: "The homeowner wants an offer next week.",
    language: "en",
    error_code: null,
    error_message: null,
    summary: "Motivated seller; follow up next week.",
    summary_status: "available",
    summary_error_code: null,
    summary_error_message: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function row(
  overrides: Partial<CallActivityRollupRow> & { id: string },
): CallActivityRollupRow {
  return {
    id: overrides.id,
    created_at: overrides.created_at ?? timestamp,
    started_at: overrides.started_at ?? timestamp,
    outcome: overrides.outcome ?? "connected_human",
    disposition: overrides.disposition ?? null,
    recording_status: overrides.recording_status ?? "none",
    transcript_status: overrides.transcript_status ?? "none",
    summary_status: overrides.summary_status ?? "none",
    jitter_attempt_id: overrides.jitter_attempt_id ?? `attempt-${overrides.id}`,
    jitter_session_id: overrides.jitter_session_id ?? "session-1",
    call_recordings: overrides.call_recordings ?? [],
    call_transcripts: overrides.call_transcripts ?? [],
  };
}

function renderWidget(
  overrides: Partial<{
    propertyId: string;
    initialRows: CallActivityRollupRow[];
    jitterHost?: string;
  }> = {},
) {
  return render(
    <LeadCallSummary
      propertyId={overrides.propertyId ?? "property-123"}
      initialRows={overrides.initialRows ?? [row({ id: "call-1" })]}
      jitterHost={overrides.jitterHost}
    />,
  );
}

beforeEach(() => {
  for (const key of Object.keys(callbacks)) delete callbacks[key];
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("<LeadCallSummary />", () => {
  it("renders a newest-first per-call log with disposition badges and artifact content", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T15:00:00.000Z"));
    renderWidget({
      initialRows: [
        row({
          id: "older",
          started_at: "2026-05-01T15:00:00.000Z",
          outcome: "no_answer",
        }),
        row({
          id: "newer",
          started_at: "2026-05-06T15:00:00.000Z",
          disposition: "follow_up_requested",
          recording_status: "available",
          transcript_status: "available",
          summary_status: "available",
          call_recordings: [recording({ call_activity_id: "newer" })],
          call_transcripts: [transcript({ call_activity_id: "newer" })],
        }),
      ],
    });

    const callsRegion = screen.getByRole("region", { name: "Calls" });
    const callHistory = screen.getByTestId("call-history");
    const calls = within(callHistory).getAllByRole("article");
    expect(callsRegion).toHaveClass("min-w-0");
    expect(callHistory).toHaveClass("min-w-0");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveClass("min-w-0");
    expect(
      within(calls[0]).getByText("follow up requested"),
    ).toBeInTheDocument();
    expect(within(calls[0]).getByText("2 days ago")).toBeInTheDocument();
    const summaryText = within(calls[0]).getByText(
      "Motivated seller; follow up next week.",
    );
    expect(summaryText).toHaveClass("break-words", "whitespace-pre-wrap");
    expect(
      summaryText.closest('[aria-label="AI summary"]')?.parentElement,
    ).toHaveClass("min-w-0");
    const transcriptToggle = within(calls[0]).getByText("Transcript");
    const transcriptDisclosure = transcriptToggle.closest("details");
    expect(transcriptDisclosure).not.toHaveAttribute("open");
    fireEvent.click(transcriptToggle);
    expect(transcriptDisclosure).toHaveAttribute("open");
    fireEvent.click(transcriptToggle);
    expect(transcriptDisclosure).not.toHaveAttribute("open");
    expect(
      within(calls[0]).getByText("The homeowner wants an offer next week."),
    ).toHaveClass("break-words", "whitespace-pre-wrap");
    expect(
      within(calls[0]).getByRole("button", { name: "Load recording (42s)" }),
    ).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("keeps connected outcomes distinct from DNC and wrong-number dispositions", () => {
    renderWidget({
      initialRows: [
        row({
          id: "dnc-call",
          outcome: "connected_human",
          disposition: "do_not_call",
        }),
        row({
          id: "wrong-call",
          outcome: "connected_human",
          disposition: "wrong_number",
        }),
      ],
    });

    expect(screen.getByTestId("outcome-badge-dnc-call")).toHaveTextContent(
      "Connected",
    );
    expect(screen.getByTestId("outcome-badge-dnc-call")).toHaveClass(
      "bg-emerald-100",
    );
    expect(screen.getByTestId("disposition-badge-dnc-call")).toHaveTextContent(
      "Do not call",
    );
    expect(screen.getByTestId("disposition-badge-dnc-call")).toHaveClass(
      "text-destructive",
    );
    expect(screen.getByTestId("outcome-badge-wrong-call")).toHaveTextContent(
      "Connected",
    );
    expect(
      screen.getByTestId("disposition-badge-wrong-call"),
    ).toHaveTextContent("Wrong number");
    expect(screen.getByTestId("disposition-badge-wrong-call")).toHaveClass(
      "text-destructive",
    );
  });

  it("allows long provider badges to grow without clipping", () => {
    const longOutcome = "provider_outcome_" + "x".repeat(80);
    const longDisposition = "provider_disposition_" + "y".repeat(80);
    renderWidget({
      initialRows: [
        row({
          id: "long-badges",
          outcome: longOutcome,
          disposition: longDisposition,
        }),
      ],
    });

    expect(screen.getByTestId("outcome-badge-long-badges")).toHaveClass(
      "h-auto",
      "min-h-5",
      "max-w-full",
      "whitespace-normal",
      "break-words",
    );
    expect(screen.getByTestId("disposition-badge-long-badges")).toHaveClass(
      "h-auto",
      "min-h-5",
      "max-w-full",
      "whitespace-normal",
      "break-words",
    );
  });

  it("renders explicit pending and child-backed failure states", () => {
    renderWidget({
      initialRows: [
        row({
          id: "pending",
          recording_status: "pending",
          transcript_status: "pending",
          summary_status: "pending",
        }),
        row({
          id: "failed",
          recording_status: "failed",
          transcript_status: "failed",
          summary_status: "failed",
          call_recordings: [
            recording({
              status: "failed",
              error_message: "Storage rejected upload",
            }),
          ],
          call_transcripts: [
            transcript({
              status: "failed",
              text: null,
              summary: null,
              summary_status: "failed",
              error_message: "Deepgram timed out",
              summary_error_message: "Claude rejected the response",
            }),
          ],
        }),
      ],
    });

    expect(screen.getByText("Recording pending")).toBeInTheDocument();
    expect(screen.getByText("Transcript pending")).toBeInTheDocument();
    expect(screen.getByText("AI summary pending")).toBeInTheDocument();
    expect(
      screen.getByText("Recording failed: Storage rejected upload"),
    ).toHaveClass("break-words");
    expect(
      screen.getByText("Transcript failed: Deepgram timed out"),
    ).toHaveClass("break-words");
    expect(
      screen.getByText("AI summary failed: Claude rejected the response"),
    ).toHaveClass("break-words");
  });

  it("is empty and disables the Jitter CTA when the host is absent", () => {
    renderWidget({ initialRows: [], jitterHost: "" });
    expect(screen.getByText("No calls yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Call this lead/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Call this lead/i }),
    ).toHaveAttribute("title", "Jitter host not configured");
  });

  it("preserves the lead-scoped Jitter history link", () => {
    renderWidget({ jitterHost: "https://jitter.example.test/" });
    expect(
      screen.getByRole("link", { name: /Open in Jitter/i }),
    ).toHaveAttribute(
      "href",
      "https://jitter.example.test/history?prospect_id=property-123",
    );
  });

  it("refetches nested artifacts on a Realtime status change and renders the result", async () => {
    const refreshed = row({
      id: "call-1",
      recording_status: "available",
      transcript_status: "available",
      summary_status: "available",
      call_recordings: [recording()],
      call_transcripts: [transcript()],
    });
    maybeSingle.mockResolvedValueOnce({ data: refreshed, error: null });
    renderWidget({
      initialRows: [
        row({
          id: "call-1",
          recording_status: "pending",
          transcript_status: "pending",
          summary_status: "pending",
        }),
      ],
    });

    await waitFor(() => expect(callbacks.UPDATE).toBeDefined());
    await act(async () => {
      callbacks.UPDATE({ new: refreshed });
    });

    await waitFor(() =>
      expect(
        screen.getByText("Motivated seller; follow up next week."),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Load recording (42s)" }),
    ).toBeInTheDocument();
    expect(eq).toHaveBeenCalledWith("id", "call-1");
    expect(eq).toHaveBeenCalledWith("property_id", "property-123");
  });

  it("recovers nested artifacts after a transient Realtime refetch error", async () => {
    const refreshed = row({
      id: "call-1",
      recording_status: "available",
      transcript_status: "available",
      summary_status: "available",
      call_recordings: [recording()],
      call_transcripts: [transcript({ summary: "Recovered summary" })],
    });
    maybeSingle
      .mockResolvedValueOnce({
        data: null,
        error: { message: "temporary network error" },
      })
      .mockResolvedValueOnce({ data: refreshed, error: null });
    renderWidget({
      initialRows: [
        row({
          id: "call-1",
          recording_status: "pending",
          transcript_status: "pending",
          summary_status: "pending",
        }),
      ],
    });

    await waitFor(() => expect(callbacks.UPDATE).toBeDefined());
    await act(async () => callbacks.UPDATE({ new: refreshed }));

    await waitFor(() =>
      expect(screen.getByText("Recovered summary")).toBeInTheDocument(),
    );
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("autonomously reconciles nested artifacts on the capped slow timer after the first six reads fail", async () => {
    vi.useFakeTimers();
    const refreshed = row({
      id: "call-1",
      recording_status: "available",
      transcript_status: "available",
      summary_status: "available",
      call_recordings: [recording()],
      call_transcripts: [transcript({ summary: "Recovered after reconnect" })],
    });
    const parentEvent = {
      id: refreshed.id,
      started_at: refreshed.started_at,
      outcome: refreshed.outcome,
      disposition: refreshed.disposition,
      recording_status: refreshed.recording_status,
      transcript_status: refreshed.transcript_status,
      summary_status: refreshed.summary_status,
      jitter_attempt_id: refreshed.jitter_attempt_id,
      jitter_session_id: refreshed.jitter_session_id,
    };
    maybeSingle
      .mockResolvedValueOnce({ data: null, error: { message: "offline-1" } })
      .mockResolvedValueOnce({ data: null, error: { message: "offline-2" } })
      .mockResolvedValueOnce({ data: null, error: { message: "offline-3" } })
      .mockResolvedValueOnce({ data: null, error: { message: "offline-4" } })
      .mockResolvedValueOnce({ data: null, error: { message: "offline-5" } })
      .mockResolvedValueOnce({ data: null, error: { message: "offline-6" } })
      .mockResolvedValueOnce({ data: refreshed, error: null });
    renderWidget({
      initialRows: [
        row({
          id: "call-1",
          recording_status: "pending",
          transcript_status: "pending",
          summary_status: "pending",
        }),
      ],
    });
    await act(async () => Promise.resolve());
    expect(callbacks.UPDATE).toBeDefined();

    act(() => callbacks.UPDATE({ new: parentEvent }));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(maybeSingle).toHaveBeenCalledTimes(3);
    expect(
      screen.queryByText("Recovered after reconnect"),
    ).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(22_000));
    expect(maybeSingle).toHaveBeenCalledTimes(6);
    expect(
      screen.queryByText("Recovered after reconnect"),
    ).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(maybeSingle).toHaveBeenCalledTimes(6);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText("Recovered after reconnect")).toBeInTheDocument();
    expect(maybeSingle).toHaveBeenCalledTimes(7);
    vi.useRealTimers();
  });

  it("cancels scheduled artifact reconciliation when the widget unmounts", async () => {
    vi.useFakeTimers();
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "offline" },
    });
    const view = renderWidget({
      initialRows: [
        row({
          id: "call-1",
          recording_status: "pending",
          transcript_status: "pending",
          summary_status: "pending",
        }),
      ],
    });
    await act(async () => Promise.resolve());
    const parentEvent = row({
      id: "call-1",
      recording_status: "available",
      transcript_status: "available",
      summary_status: "available",
    });

    act(() => callbacks.UPDATE({ new: parentEvent }));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(maybeSingle).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(22_000));
    expect(maybeSingle).toHaveBeenCalledTimes(6);
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(maybeSingle).toHaveBeenCalledTimes(6);
    vi.useRealTimers();
  });

  it("merges a non-status Realtime update without discarding nested artifacts or refetching", async () => {
    const available = row({
      id: "call-1",
      outcome: "connected_human",
      recording_status: "available",
      transcript_status: "available",
      summary_status: "available",
      call_recordings: [recording()],
      call_transcripts: [transcript()],
    });
    renderWidget({ initialRows: [available] });

    await waitFor(() => expect(callbacks.UPDATE).toBeDefined());
    await act(async () => {
      callbacks.UPDATE({ new: { ...available, outcome: "voicemail" } });
    });

    expect(screen.getByText("Voicemail")).toBeInTheDocument();
    expect(
      screen.getByText("Motivated seller; follow up next week."),
    ).toBeInTheDocument();
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("ignores an older status refetch that resolves after a newer artifact snapshot", async () => {
    let resolveOlder!: (value: {
      data: CallActivityRollupRow;
      error: null;
    }) => void;
    let resolveNewer!: (value: {
      data: CallActivityRollupRow;
      error: null;
    }) => void;
    const olderResult = new Promise<{
      data: CallActivityRollupRow;
      error: null;
    }>((resolve) => {
      resolveOlder = resolve;
    });
    const newerResult = new Promise<{
      data: CallActivityRollupRow;
      error: null;
    }>((resolve) => {
      resolveNewer = resolve;
    });
    maybeSingle
      .mockImplementationOnce(() => olderResult)
      .mockImplementationOnce(() => newerResult);
    renderWidget({
      initialRows: [
        row({
          id: "call-1",
          recording_status: "pending",
          transcript_status: "pending",
          summary_status: "pending",
        }),
      ],
    });
    await waitFor(() => expect(callbacks.UPDATE).toBeDefined());

    const older = row({
      id: "call-1",
      recording_status: "available",
      transcript_status: "available",
      summary_status: "available",
      call_recordings: [recording()],
      call_transcripts: [transcript({ summary: "Stale summary" })],
    });
    const newer = row({
      id: "call-1",
      recording_status: "failed",
      transcript_status: "failed",
      summary_status: "failed",
      call_recordings: [
        recording({
          status: "failed",
          error_message: "Latest recording failure",
        }),
      ],
      call_transcripts: [
        transcript({
          status: "failed",
          text: null,
          summary: null,
          summary_status: "failed",
          error_message: "Latest transcript failure",
          summary_error_message: "Latest summary failure",
        }),
      ],
    });

    act(() => callbacks.UPDATE({ new: older }));
    act(() => callbacks.UPDATE({ new: newer }));
    await act(async () => resolveNewer({ data: newer, error: null }));
    await waitFor(() =>
      expect(
        screen.getByText("Transcript failed: Latest transcript failure"),
      ).toBeInTheDocument(),
    );

    await act(async () => resolveOlder({ data: older, error: null }));
    expect(screen.queryByText("Stale summary")).not.toBeInTheDocument();
    expect(
      screen.getByText("AI summary failed: Latest summary failure"),
    ).toBeInTheDocument();
  });

  it("authenticates Realtime and removes its channel on unmount", async () => {
    const view = renderWidget();
    await waitFor(() => expect(setAuth).toHaveBeenCalledWith("test-token"));
    view.unmount();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });
});
