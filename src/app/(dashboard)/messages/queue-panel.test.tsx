import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listQueuedPage, releaseMessage, refresh } = vi.hoisted(() => ({
  listQueuedPage: vi.fn(),
  releaseMessage: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("./actions", () => ({
  listQueuedPage,
  releaseMessage,
  deleteQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
    realtime: { setAuth: vi.fn() },
    channel: () => {
      const ch = {
        on: () => ch,
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { QueuePanel, type QueuedRow } from "./queue-panel";
import { toast } from "sonner";

function makeRow(n: number): QueuedRow {
  return {
    id: `msg-${String(n).padStart(4, "0")}`,
    body: `body ${n}`,
    fromAddress: "+15550000000",
    toAddress: `+1555000${String(n).padStart(4, "0")}`,
    createdAt: "2026-06-12T12:00:00.000Z",
    scheduledFor: `2026-06-12T18:${String(n % 60).padStart(2, "0")}:00.000Z`,
    propertyId: null,
    contactId: null,
    propertyAddress: `${n} Main St`,
    contactName: null,
    contactPhone: null,
  };
}

// jsdom has no IntersectionObserver — install a stub that captures the
// callback so tests can fire intersections deterministically.
let intersect: (() => void) | null = null;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  listQueuedPage.mockReset();
  releaseMessage.mockReset();
  refresh.mockReset();
  intersect = null;
  observe.mockClear();
  disconnect.mockClear();
  localStorage.clear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        intersect = () =>
          cb(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = () => [];
      root = null;
      rootMargin = "";
      thresholds = [];
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<QueuePanel /> infinite scroll", () => {
  it("renders no sentinel when initialHasMore=false", () => {
    render(<QueuePanel initial={[makeRow(1)]} initialHasMore={false} />);
    expect(
      screen.queryByTestId("queue-load-more-sentinel"),
    ).not.toBeInTheDocument();
    expect(observe).not.toHaveBeenCalled();
  });

  it("loads the next page on intersection using the last row's keyset cursor", async () => {
    const first = [makeRow(1), makeRow(2)];
    listQueuedPage.mockResolvedValue({
      ok: true,
      data: { rows: [makeRow(3), makeRow(4)], hasMore: false },
    });

    render(<QueuePanel initial={first} initialHasMore={true} />);
    expect(screen.getByTestId("queue-load-more-sentinel")).toBeInTheDocument();
    expect(observe).toHaveBeenCalledTimes(1);

    await act(async () => {
      intersect!();
    });

    expect(listQueuedPage).toHaveBeenCalledWith({
      scheduledFor: first[1].scheduledFor,
      id: first[1].id,
    });
    // Appended rows render…
    expect(screen.getByText("3 Main St")).toBeInTheDocument();
    expect(screen.getByText("4 Main St")).toBeInTheDocument();
    // …and the sentinel is gone because hasMore came back false.
    expect(
      screen.queryByTestId("queue-load-more-sentinel"),
    ).not.toBeInTheDocument();
  });

  it("dedups rows the client already has (queue drained between pages)", async () => {
    listQueuedPage.mockResolvedValue({
      ok: true,
      data: { rows: [makeRow(2), makeRow(3)], hasMore: false },
    });

    render(
      <QueuePanel initial={[makeRow(1), makeRow(2)]} initialHasMore={true} />,
    );

    await act(async () => {
      intersect!();
    });

    expect(screen.getAllByText("2 Main St")).toHaveLength(1);
    expect(screen.getByText("3 Main St")).toBeInTheDocument();
  });

  it("keeps the sentinel when a page fetch fails so the user can retry by scrolling", async () => {
    listQueuedPage.mockResolvedValue({
      ok: false,
      error: { code: "QUEUE_PAGE_FAILED", message: "boom" },
    });

    render(<QueuePanel initial={[makeRow(1)]} initialHasMore={true} />);

    await act(async () => {
      intersect!();
    });

    expect(screen.getByTestId("queue-load-more-sentinel")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry loading queue" }),
    ).toBeInTheDocument();
  });

  it("never presents a failed first page as an empty Outbox", () => {
    render(
      <QueuePanel initial={[]} initialHasMore={false} initialLoadFailed />,
    );

    expect(screen.getByTestId("queue-load-failure")).toHaveTextContent(
      "This is a load failure, not an empty queue",
    );
    expect(screen.queryByTestId("queue-empty")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("adopts the successful server snapshot after a failed-load retry", async () => {
    const view = render(
      <QueuePanel initial={[]} initialHasMore={false} initialLoadFailed />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    view.rerender(
      <QueuePanel
        initial={[makeRow(1)]}
        initialHasMore={false}
        initialLoadFailed={false}
      />,
    );

    expect(await screen.findByText("1 Main St")).toBeInTheDocument();
    expect(screen.queryByTestId("queue-load-failure")).not.toBeInTheDocument();
    expect(screen.queryByTestId("queue-empty")).not.toBeInTheDocument();
  });

  it("renders narrow-safe Outbox cards with labeled Edit, Delete, and Send controls", () => {
    render(<QueuePanel initial={[makeRow(1)]} initialHasMore={false} />);

    const card = screen.getByTestId("outbox-card-msg-0001");
    expect(card).toHaveTextContent("QUEUED");
    expect(screen.getByRole("button", { name: "Edit" })).toHaveClass(
      "min-h-11",
    );
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
      "min-h-11",
    );
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass(
      "min-h-11",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("re-arms the sentinel and re-seeds from page 1 when live stats outrun an empty table", async () => {
    listQueuedPage.mockResolvedValue({
      ok: true,
      data: { rows: [makeRow(1)], hasMore: false },
    });

    // Empty queue, fully loaded… but the live stats say 1 queued
    // (another tab queued a message; realtime has no INSERT path).
    render(<QueuePanel initial={[]} initialHasMore={false} totalQueued={1} />);

    // The sentinel re-arms instead of letting the table contradict the badge.
    expect(screen.getByTestId("queue-load-more-sentinel")).toBeInTheDocument();

    await act(async () => {
      intersect!();
    });

    // Empty list → null cursor re-seed, and the new row renders.
    expect(listQueuedPage).toHaveBeenCalledWith(null);
    expect(screen.getByText("1 Main St")).toBeInTheDocument();
  });

  it("rate-limits the corrective fetch on a stale-high total instead of tight-looping", async () => {
    vi.useFakeTimers();
    try {
      // Server truth: the queue really is empty — the badge is stale-high.
      listQueuedPage.mockResolvedValue({
        ok: true,
        data: { rows: [], hasMore: false },
      });

      render(
        <QueuePanel initial={[]} initialHasMore={false} totalQueued={1} />,
      );

      // One corrective attempt fires…
      expect(
        screen.getByTestId("queue-load-more-sentinel"),
      ).toBeInTheDocument();
      await act(async () => {
        intersect!();
      });
      expect(listQueuedPage).toHaveBeenCalledTimes(1);

      // …and within the cooldown the sentinel stays retired — no loop.
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(
        screen.queryByTestId("queue-load-more-sentinel"),
      ).not.toBeInTheDocument();
      expect(listQueuedPage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers when a real row later appears at the SAME numeric total", async () => {
    vi.useFakeTimers();
    try {
      // First corrective fetch: badge stale-high, queue genuinely empty.
      listQueuedPage.mockResolvedValue({
        ok: true,
        data: { rows: [], hasMore: false },
      });

      render(
        <QueuePanel initial={[]} initialHasMore={false} totalQueued={1} />,
      );
      await act(async () => {
        intersect!();
      });
      expect(listQueuedPage).toHaveBeenCalledTimes(1);

      // Now a REAL message gets queued; the live total is still 1.
      listQueuedPage.mockResolvedValue({
        ok: true,
        data: { rows: [makeRow(1)], hasMore: false },
      });

      // After the cooldown the sentinel re-arms by itself…
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(
        screen.getByTestId("queue-load-more-sentinel"),
      ).toBeInTheDocument();

      // …and the next corrective fetch surfaces the row.
      await act(async () => {
        intersect!();
      });
      expect(listQueuedPage).toHaveBeenCalledTimes(2);
      expect(screen.getByText("1 Main St")).toBeInTheDocument();
      expect(
        screen.queryByTestId("queue-load-more-sentinel"),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows 'X of Y loaded' when the live total exceeds the loaded rows", () => {
    render(
      <QueuePanel
        initial={[makeRow(1), makeRow(2)]}
        initialHasMore={true}
        totalQueued={8964}
      />,
    );
    expect(screen.getByText("2 of 8964 loaded")).toBeInTheDocument();
  });

  it("shows plain 'N queued' when everything is loaded", () => {
    render(
      <QueuePanel
        initial={[makeRow(1), makeRow(2)]}
        initialHasMore={false}
        totalQueued={2}
      />,
    );
    expect(screen.getByText("2 queued")).toBeInTheDocument();
  });

  it("handles terminal-suppressed queued rows as a skip instead of a generic error", async () => {
    releaseMessage.mockResolvedValue({
      ok: true,
      data: {
        outcome: {
          status: "blocked_terminal_dispo",
          reason:
            "Property is suppressed by terminal disposition: wrong_number.",
        },
      },
    });

    render(<QueuePanel initial={[makeRow(1)]} initialHasMore={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith("Skipped", {
        description:
          "Property is suppressed by terminal disposition: wrong_number.",
      });
    });
    expect(screen.queryByText("1 Main St")).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalledWith("blocked_terminal_dispo");
  });

  it("keeps the configured cadence after a row is consumed instead of restarting immediately", async () => {
    vi.useFakeTimers();
    releaseMessage.mockResolvedValue({
      ok: true,
      data: { outcome: { status: "sent" } },
    });
    const view = render(
      <QueuePanel initial={[makeRow(1), makeRow(2)]} initialHasMore={false} />,
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: "Auto-send" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(releaseMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(14_000);
        await Promise.resolve();
      });
      expect(releaseMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
      });
      expect(releaseMessage).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("restores a saved cadence without overwriting it with the default on mount", async () => {
    localStorage.setItem("sandra.queue.cadence", "30");
    render(<QueuePanel initial={[makeRow(1)]} initialHasMore={false} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Cadence")).toHaveValue(30);
    });
    expect(localStorage.getItem("sandra.queue.cadence")).toBe("30");
  });

  it("stops auto-send on the next tick when the queue becomes empty", async () => {
    vi.useFakeTimers();
    releaseMessage.mockResolvedValue({
      ok: true,
      data: { outcome: { status: "sent" } },
    });
    const view = render(
      <QueuePanel initial={[makeRow(1)]} initialHasMore={false} />,
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: "Auto-send" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(releaseMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(15_000);
        await Promise.resolve();
      });
      expect(releaseMessage).toHaveBeenCalledTimes(1);
      expect(toast.info).toHaveBeenCalledWith("Queue empty — auto-send stopped");
      expect(screen.getByRole("button", { name: "Auto-send" })).toBeDisabled();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it.each([
    ["blocked_provider_off", { status: "blocked_provider_off", reason: "off" }],
    ["blocked_no_approved_sender", { status: "blocked_no_approved_sender", reason: "none" }],
    ["blocked_no_phone", { status: "blocked_no_phone", reason: "none" }],
    ["blocked_landline", { status: "blocked_landline", reason: "landline" }],
    ["blocked_terminal_dispo", { status: "blocked_terminal_dispo", reason: "terminal" }],
    ["blocked_automated_suppressed", { status: "blocked_automated_suppressed", reason: "suppressed" }],
    ["blocked_fresh_state_unavailable", { status: "blocked_fresh_state_unavailable", error: "unavailable" }],
    ["blocked_no_consent", { status: "blocked_no_consent", reason: "no consent" }],
    ["blocked_quiet_hours", { status: "blocked_quiet_hours", reason: "quiet" }],
    ["blocked_not_due", { status: "blocked_not_due", retryAt: "2026-08-17T13:00:00Z" }],
    ["blocked_campaign_paused", { status: "blocked_campaign_paused", reason: "paused" }],
    ["provider_failed", { status: "provider_failed", error: "provider" }],
    ["provider_deferred", { status: "provider_deferred", error: "retry", attempt: 1, retryAt: "2026-08-17T13:00:00Z" }],
    ["contact_not_found", { status: "contact_not_found" }],
    ["property_not_found", { status: "property_not_found" }],
    ["db_error", { status: "db_error", error: "database" }],
  ])("stops auto-send after %s", async (_status, outcome) => {
    vi.useFakeTimers();
    releaseMessage.mockResolvedValue({ ok: true, data: { outcome } });
    const view = render(
      <QueuePanel initial={[makeRow(1), makeRow(2)]} initialHasMore={false} />,
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: "Auto-send" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(releaseMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(releaseMessage).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Auto-send" })).toBeVisible();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("never overlaps auto-send releases when the provider response is slow", async () => {
    vi.useFakeTimers();
    let resolveRelease!: (value: unknown) => void;
    releaseMessage.mockReturnValue(
      new Promise((resolve) => {
        resolveRelease = resolve;
      }),
    );
    const view = render(
      <QueuePanel initial={[makeRow(1), makeRow(2)]} initialHasMore={false} />,
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: "Auto-send" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(releaseMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(releaseMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveRelease({
          ok: true,
          data: { outcome: { status: "sent" } },
        });
        await Promise.resolve();
      });
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
