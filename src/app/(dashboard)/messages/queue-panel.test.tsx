import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listQueuedPage } = vi.hoisted(() => ({ listQueuedPage: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("./actions", () => ({
  listQueuedPage,
  releaseMessage: vi.fn(),
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

// eslint-disable-next-line import/first
import { QueuePanel, type QueuedRow } from "./queue-panel";

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
  intersect = null;
  observe.mockClear();
  disconnect.mockClear();
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
});
