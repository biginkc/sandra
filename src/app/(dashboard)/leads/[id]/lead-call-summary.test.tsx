import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callbacks, channelOn, removeChannel, setAuth } = vi.hoisted(() => ({
  callbacks: {} as Record<string, (payload: { new: unknown }) => void>,
  channelOn: vi.fn(),
  removeChannel: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
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
      realtime: { setAuth },
      removeChannel,
    };
  },
}));

// eslint-disable-next-line import/first
import {
  LeadCallSummary,
  type CallActivityRollupRow,
} from "./lead-call-summary";

function row(
  overrides: Partial<CallActivityRollupRow> & { id: string },
): CallActivityRollupRow {
  return {
    id: overrides.id,
    started_at: overrides.started_at ?? "2026-05-06T15:00:00.000Z",
    outcome: overrides.outcome ?? "connected_human",
    disposition: overrides.disposition ?? null,
    recording_status: overrides.recording_status ?? "none",
    transcript_status: overrides.transcript_status ?? "none",
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
      propertyId={overrides.propertyId ?? "abc-123"}
      initialRows={overrides.initialRows ?? [row({ id: "call-1" })]}
      jitterHost={overrides.jitterHost}
    />,
  );
}

beforeEach(() => {
  for (const key of Object.keys(callbacks)) delete callbacks[key];
  channelOn.mockClear();
  removeChannel.mockClear();
  setAuth.mockClear();
});

describe("<LeadCallSummary />", () => {
  it("renders attempt count from server-fetched rows", () => {
    renderWidget({
      initialRows: Array.from({ length: 5 }, (_, index) =>
        row({ id: `call-${index}` }),
      ),
    });

    expect(screen.getByText("5 calls")).toBeInTheDocument();
  });

  it("renders latest outcome badge from most recent row", () => {
    renderWidget({
      initialRows: [
        row({ id: "old", started_at: "2026-05-01T15:00:00.000Z", outcome: "no_answer" }),
        row({ id: "new", started_at: "2026-05-07T15:00:00.000Z", outcome: "voicemail" }),
      ],
    });

    expect(screen.getByTestId("latest-outcome-badge")).toHaveTextContent(
      "Voicemail",
    );
  });

  it("renders latest call timestamp using a relative formatter", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T15:00:00.000Z"));
    renderWidget({
      initialRows: [row({ id: "call-1", started_at: "2026-05-06T15:00:00.000Z" })],
    });

    expect(screen.getByTestId("latest-call-timestamp")).toHaveTextContent(
      "2 days ago",
    );
    vi.useRealTimers();
  });

  it("renders availability indicators for recordings, transcripts, and pending states", () => {
    renderWidget({
      initialRows: [
        row({ id: "call-1", recording_status: "available", transcript_status: "available" }),
        row({ id: "call-2", recording_status: "available", transcript_status: "pending" }),
        row({ id: "call-3", recording_status: "pending", transcript_status: "available" }),
      ],
    });

    const availability = screen.getByLabelText(
      "Recording and transcript availability",
    );
    expect(within(availability).getByText(/Recording/i)).toBeInTheDocument();
    expect(within(availability).getAllByText(/2 available/)).toHaveLength(2);
    expect(within(availability).getAllByText(/1 pending/)).toHaveLength(2);
    expect(within(availability).getByText(/Transcript/i)).toBeInTheDocument();
  });

  it("renders empty state when initialRows is empty", () => {
    renderWidget({ initialRows: [] });

    expect(screen.getByText("No calls yet")).toBeInTheDocument();
    expect(
      screen.getByText("This lead hasn't been called yet."),
    ).toBeInTheDocument();
  });

  it("does not render any per-attempt row", () => {
    renderWidget({ initialRows: [row({ id: "call-1" }), row({ id: "call-2" })] });

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/call-1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/attempt/i)).not.toBeInTheDocument();
  });

  it("does not render any recording playback element", () => {
    const { container } = renderWidget({
      initialRows: [row({ id: "call-1", recording_status: "available" })],
    });

    expect(container.querySelector("audio")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByRole("button", { name: /play/i })).toBeNull();
  });

  it("does not render transcript text", () => {
    renderWidget({
      initialRows: [row({ id: "call-1", transcript_status: "available" })],
    });

    expect(screen.queryByText(/full transcript/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/hello from the homeowner/i)).not.toBeInTheDocument();
  });

  it("renders deep-link button as enabled with prospect_id when jitterHost is non-empty", () => {
    renderWidget({ jitterHost: "http://localhost:3001" });

    const link = screen.getByRole("link", { name: /Open in Jitter/i });
    expect(link).toHaveAttribute(
      "href",
      "http://localhost:3001/history?prospect_id=abc-123",
    );
  });

  it("renders deep-link button as disabled with tooltip when jitterHost is empty string", () => {
    renderWidget({ jitterHost: "" });

    const button = screen.getByRole("button", { name: /Open in Jitter/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Jitter host not configured");
    expect(screen.queryByRole("link", { name: /Open in Jitter/i })).toBeNull();
  });

  it("renders deep-link button as disabled with tooltip when jitterHost is undefined", () => {
    renderWidget({ jitterHost: undefined });

    const button = screen.getByRole("button", { name: /Open in Jitter/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Jitter host not configured");
  });

  it("when jitterHost is empty, the empty-state Call this lead CTA is disabled with the same tooltip", () => {
    renderWidget({ initialRows: [], jitterHost: "" });

    const button = screen.getByRole("button", { name: /Call this lead/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Jitter host not configured");
    expect(screen.queryByRole("link", { name: /Call this lead/i })).toBeNull();
  });

  it("when jitterHost is non-empty, the empty-state Call this lead CTA is enabled and href contains prospect_id", () => {
    renderWidget({ initialRows: [], jitterHost: "http://localhost:3001/" });

    expect(screen.getByRole("link", { name: /Call this lead/i })).toHaveAttribute(
      "href",
      "http://localhost:3001/history?prospect_id=abc-123",
    );
  });

  it("subscribes to Realtime channel and re-renders on INSERT", async () => {
    renderWidget({ initialRows: [] });

    await waitFor(() => expect(callbacks.INSERT).toBeDefined());
    await act(async () => {
      callbacks.INSERT({ new: row({ id: "inserted", outcome: "connected_human" }) });
    });

    expect(screen.getByText("1 call")).toBeInTheDocument();
    expect(screen.getByTestId("latest-outcome-badge")).toHaveTextContent(
      "Connected",
    );
  });

  it("subscribes to Realtime channel and re-renders on UPDATE", async () => {
    renderWidget({ initialRows: [row({ id: "call-1", outcome: "no_answer" })] });

    await waitFor(() => expect(callbacks.UPDATE).toBeDefined());
    await act(async () => {
      callbacks.UPDATE({ new: row({ id: "call-1", outcome: "voicemail" }) });
    });

    expect(screen.getByText("1 call")).toBeInTheDocument();
    expect(screen.getByTestId("latest-outcome-badge")).toHaveTextContent(
      "Voicemail",
    );
  });
});
