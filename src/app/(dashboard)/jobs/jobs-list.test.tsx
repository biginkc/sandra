import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import type {
  ParsedTableSearch,
  SortDirection,
} from "@/components/table/use-table-url-state";

import { JobsList } from "./jobs-list";
import type { JobsFilters } from "./page";

// `next/navigation`'s real router needs an App Router context Vitest doesn't
// provide. Stub the bits the table actually calls. Hoisted mock state lets
// tests assert what URL replace() was called with when the user types
// search / clicks a sort header / toggles a status pill.
const { routerReplace } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// The action modules import server-only Supabase bindings. Stub so jsdom
// doesn't try to load them during the (unused-in-these-tests) Start CASS /
// Retry / Approve buttons.
vi.mock("./actions", () => ({
  retryFailedCassItems: vi.fn(),
  startQueuedCassJob: vi.fn(),
}));

vi.mock("@/lib/skip-trace/actions", () => ({
  approveSkipTraceJob: vi.fn(),
  denySkipTraceJob: vi.fn(),
}));

// Supabase realtime + initial-fetch mock — pattern from
// inbox-filters.test.tsx:46-61. We hold the initial-fetch resolver in a
// hoisted ref so each test can drive when jobs hydrate (which clears the
// `loading` early return so the toolbar can render).
const { jobsResolver } = vi.hoisted(() => {
  const ref: { resolve: ((data: unknown) => void) | null } = { resolve: null };
  return { jobsResolver: ref };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
    realtime: { setAuth: vi.fn() },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: vi.fn(),
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () =>
            new Promise((resolve) => {
              jobsResolver.resolve = (data) =>
                resolve({ data, error: null });
            }),
        }),
      }),
    }),
  }),
}));

type MockJob = {
  id: string;
  title: string | null;
  type: string;
  status: string;
  created_at: string;
  total_items: number;
  processed_items: number;
  failed_items: number;
  result_summary: unknown;
};

function makeJob(overrides: Partial<MockJob> & { id: string }): MockJob {
  return {
    id: overrides.id,
    title: overrides.title ?? `Job ${overrides.id}`,
    type: overrides.type ?? "import",
    status: overrides.status ?? "completed",
    created_at: overrides.created_at ?? "2026-04-29T12:00:00Z",
    total_items: overrides.total_items ?? 100,
    processed_items: overrides.processed_items ?? 100,
    failed_items: overrides.failed_items ?? 0,
    result_summary: overrides.result_summary ?? {},
  };
}

const DEFAULT_PARSED: ParsedTableSearch<JobsFilters> = {
  page: 1,
  search: null,
  sort: "created_at",
  dir: "desc" as SortDirection,
  filters: { status: null },
};

async function renderJobs(
  opts: {
    jobs?: MockJob[];
    parsed?: Partial<ParsedTableSearch<JobsFilters>>;
  } = {},
) {
  const result = render(
    <JobsList
      isAdmin={false}
      parsed={{
        ...DEFAULT_PARSED,
        ...opts.parsed,
        filters: {
          ...DEFAULT_PARSED.filters,
          ...(opts.parsed?.filters ?? {}),
        },
      }}
    />,
  );

  // The realtime hook's IIFE awaits getSession() then the from()...limit()
  // promise; resolving the limit() promise drives setJobs + setLoading(false).
  // We wrap in act() so React flushes the resulting state updates inside the
  // test boundary.
  await act(async () => {
    // Drain getSession() microtask first.
    await Promise.resolve();
    if (jobsResolver.resolve) {
      jobsResolver.resolve(opts.jobs ?? []);
      jobsResolver.resolve = null;
    }
    // Drain the from()...limit() then() handlers.
    await Promise.resolve();
    await Promise.resolve();
  });

  // Belt-and-braces: wait for the toolbar to actually render so individual
  // tests can call screen.getByTestId synchronously.
  await waitFor(() => {
    expect(screen.getByTestId("jobs-search")).toBeInTheDocument();
  });

  return result;
}

beforeEach(() => {
  routerReplace.mockReset();
  jobsResolver.resolve = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<JobsList />", () => {
  it("renders the toolbar (search + 4 status pills) and four sortable column headers", async () => {
    await renderJobs();
    expect(screen.getByTestId("jobs-search")).toBeInTheDocument();
    expect(screen.getByTestId("jobs-filter-queued")).toBeInTheDocument();
    expect(screen.getByTestId("jobs-filter-running")).toBeInTheDocument();
    expect(screen.getByTestId("jobs-filter-failed")).toBeInTheDocument();
    expect(
      screen.getByTestId("jobs-filter-pending_approval"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("jobs-sort-title")).toBeInTheDocument();
    expect(screen.getByTestId("jobs-sort-type")).toBeInTheDocument();
    expect(screen.getByTestId("jobs-sort-status")).toBeInTheDocument();
    expect(screen.getByTestId("jobs-sort-created_at")).toBeInTheDocument();
  });

  it("typing in the search input calls router.replace after the 250ms debounce with /jobs?search=...", async () => {
    // Real timers + waitFor — fake timers don't compose cleanly with the
    // hook's debounce + skeleton timers (per Plan 01-02 / 01-04 SUMMARYs).
    const user = userEvent.setup();
    await renderJobs();
    await user.type(screen.getByTestId("jobs-search"), "import");

    await waitFor(
      () => {
        expect(routerReplace).toHaveBeenCalled();
      },
      { timeout: 1500 },
    );
    // mode: "client" → router.replace called with (url, { scroll: false }).
    expect(routerReplace.mock.calls.at(-1)?.[0]).toBe("/jobs?search=import");
    expect(routerReplace.mock.calls.at(-1)?.[1]).toEqual({ scroll: false });
  });

  it("clicking the Queued pill (no status filter active) sets ?status=queued", async () => {
    const user = userEvent.setup();
    await renderJobs();
    await user.click(screen.getByTestId("jobs-filter-queued"));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    expect(routerReplace.mock.calls[0][0]).toBe("/jobs?status=queued");
  });

  it("clicking the Queued pill when already active clears the status filter (URL collapses to /jobs)", async () => {
    const user = userEvent.setup();
    await renderJobs({ parsed: { filters: { status: "queued" } } });
    await user.click(screen.getByTestId("jobs-filter-queued"));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    // status flips to null → buildFilterParams omits it; sort/dir/page all
    // default → URL collapses to the bare path.
    expect(routerReplace.mock.calls[0][0]).toBe("/jobs");
  });

  it("clicking the Title sort header (default sort: created_at desc) emits /jobs?sort=title&dir=asc", async () => {
    const user = userEvent.setup();
    await renderJobs();
    await user.click(screen.getByTestId("jobs-sort-title"));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    // sort=title !== default created_at → emitted.
    // dir=asc !== defaultDir desc → emitted.
    expect(routerReplace.mock.calls[0][0]).toBe("/jobs?sort=title&dir=asc");
  });

  it("in-memory filter — when parsed.filters.status='queued', only queued jobs render in the body", async () => {
    await renderJobs({
      jobs: [
        makeJob({ id: "j1", title: "Queued job", status: "queued" }),
        makeJob({ id: "j2", title: "Done job", status: "completed" }),
      ],
      parsed: { filters: { status: "queued" } },
    });

    // useMemo applies status filter in-memory over the realtime jobs array.
    expect(screen.getByText("Queued job")).toBeInTheDocument();
    expect(screen.queryByText("Done job")).not.toBeInTheDocument();
  });

  it("typing search renders the realtime jobs initially, then debounces + fires router.replace with /jobs?search=...", async () => {
    // Note: in mode: "client" the URL update happens via router.replace, but
    // the visible filter only updates when the parent re-renders with a new
    // `parsed.search`. In production, App Router re-renders the client
    // component when the URL changes. In jsdom we don't have a real router,
    // so we assert the routerReplace call (which proves the URL update fired
    // with the right value); the in-memory filter behavior is verified by
    // the parsed-prop test above.
    const user = userEvent.setup();
    await renderJobs({
      jobs: [
        makeJob({ id: "j1", title: "import props" }),
        makeJob({ id: "j2", title: "skip trace queue" }),
      ],
    });

    // Both rows visible before any URL change — the realtime mock array
    // hydrated visibleJobs via the useMemo.
    expect(screen.getByText("import props")).toBeInTheDocument();
    expect(screen.getByText("skip trace queue")).toBeInTheDocument();

    await user.type(screen.getByTestId("jobs-search"), "import");

    await waitFor(
      () => {
        expect(routerReplace).toHaveBeenCalledWith("/jobs?search=import", {
          scroll: false,
        });
      },
      { timeout: 1500 },
    );
  });
});
