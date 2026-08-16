import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StepProgress } from "./step-progress";

const { createClientMock, retryCsvImportJobMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  retryCsvImportJobMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: createClientMock }));
vi.mock("../actions", () => ({
  retryCsvImportJob: retryCsvImportJobMock,
  retryImportListAssignment: vi.fn(),
}));

function job(status: string) {
  return {
    id: "job-1",
    org_id: "org-1",
    type: "csv_import",
    status,
    error_class: "transient",
    total_items: 10,
    processed_items: status === "failed" ? 2 : 3,
    succeeded_items: status === "failed" ? 1 : 2,
    failed_items: 1,
    result_summary: { sideEffects: {} },
  };
}

function mockClient(jobResults: Array<ReturnType<typeof job>>) {
  let jobRead = 0;
  const single = vi.fn(async () => ({
    data: jobResults[Math.min(jobRead++, jobResults.length - 1)],
    error: null,
  }));
  const maybeSingle = vi.fn(async () => ({
    data: { job_id: "job-1" },
    error: null,
  }));
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    single,
    maybeSingle,
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  createClientMock.mockReturnValue({
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    realtime: { setAuth: vi.fn() },
    channel: vi.fn().mockReturnValue(channel),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue(query),
  });
  return { single };
}

describe("<StepProgress /> retry truthfulness", () => {
  beforeEach(() => {
    retryCsvImportJobMock.mockResolvedValue({ ok: true, data: { jobId: "job-1" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("immediately refetches and re-arms fallback polling after a retry", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const { single } = mockClient([job("failed"), job("queued")]);

    render(<StepProgress jobId="job-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry import" }));

    await waitFor(() => expect(single).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("queued")).toBeInTheDocument();
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
  });

  it("shows truthful Job details without a false failed-row download", async () => {
    mockClient([job("failed")]);

    render(<StepProgress jobId="job-1" />);

    expect(await screen.findByRole("link", { name: "Job details" })).toHaveAttribute(
      "href",
      "/jobs/job-1",
    );
    expect(
      screen.queryByRole("link", { name: "Download failed rows" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Skipped").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Unprocessed").nextElementSibling).toHaveTextContent(
      "8",
    );
  });
});
