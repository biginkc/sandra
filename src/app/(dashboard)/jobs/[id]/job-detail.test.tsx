import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: routerRefresh }),
}));
vi.mock("../../properties/promote-leads-actions", () => ({
  retryPromoteLeadsJob: vi.fn(),
}));
vi.mock("../../import/actions", () => ({
  retryCsvImportJob: vi.fn(),
}));

import { JobDetail, type JobDetailProps } from "./job-detail";

function makeJob(
  overrides: Partial<JobDetailProps["job"]> = {},
): JobDetailProps["job"] {
  return {
    id: "job-1",
    org_id: "org-1",
    created_at: "2026-06-30T18:00:00.000Z",
    created_by: null,
    type: "bulk_sms",
    status: "completed",
    total_items: 100,
    processed_items: 100,
    succeeded_items: 98,
    failed_items: 2,
    started_at: "2026-06-30T18:00:00.000Z",
    completed_at: "2026-06-30T18:01:00.000Z",
    worker_heartbeat_at: null,
    retry_count: 0,
    max_retries: 3,
    error_class: null,
    parent_job_id: null,
    related_import_id: null,
    provider: "internal",
    provider_run_id: null,
    provider_webhook_secret: null,
    input_params: { opts: { campaignId: "campaign-1" } },
    result_summary: {},
    error_message: null,
    title: "Bulk SMS",
    description: null,
    ...overrides,
  } as JobDetailProps["job"];
}

describe("<JobDetail /> bulk SMS panel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses shared SMS metrics wording instead of treating job completion as delivery completion", () => {
    render(
      <JobDetail
        job={makeJob()}
        items={[]}
        parent={null}
        childJobs={[]}
        csvImport={null}
        bulkSmsMetrics={{
          queued: 10,
          dueQueued: 2,
          pending: 1,
          sent: 7,
          delivered: 80,
          failed: 1,
          handedOff: 87,
          nextScheduledFor: "2026-06-30T18:00:30.000Z",
          lastScheduledFor: "2026-06-30T19:15:00.000Z",
        }}
        bulkSmsMetricsError={null}
      />,
    );

    expect(screen.getByText("Bulk SMS send progress")).toBeInTheDocument();
    expect(
      screen.getByText(/Job status tracks queue-building/),
    ).toBeInTheDocument();
    expect(screen.getByText("Open campaign live progress")).toHaveAttribute(
      "href",
      "/campaigns/campaign-1",
    );
    expect(screen.getByText("Queued to send")).toBeInTheDocument();
    expect(screen.getByText("Handed to provider")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("in 30s")).toBeInTheDocument();
    expect(screen.getByText("1h 15m")).toBeInTheDocument();
  });

  it("labels overdue queued SMS rows as draining now instead of a future ETA", () => {
    render(
      <JobDetail
        job={makeJob()}
        items={[]}
        parent={null}
        childJobs={[]}
        csvImport={null}
        bulkSmsMetrics={{
          queued: 10,
          dueQueued: 10,
          pending: 0,
          sent: 7,
          delivered: 80,
          failed: 1,
          handedOff: 88,
          nextScheduledFor: "2026-06-30T17:55:00.000Z",
          lastScheduledFor: "2026-06-30T17:59:30.000Z",
        }}
        bulkSmsMetricsError={null}
      />,
    );

    expect(screen.getByText("draining now")).toBeInTheDocument();
    expect(screen.queryByText("<1m")).toBeNull();
  });
});

describe("<JobDetail /> Promote to Leads results", () => {
  it("refreshes running promotion progress without requiring a manual page reload", () => {
    vi.useFakeTimers();
    routerRefresh.mockReset();
    render(
      <JobDetail
        job={makeJob({
          type: "promote_leads",
          status: "running",
          total_items: 3,
          processed_items: 1,
          succeeded_items: 1,
          failed_items: 0,
          completed_at: null,
          result_summary: { promoted: 1, pending: 2 },
        })}
        items={[]}
        parent={null}
        childJobs={[]}
        csvImport={null}
      />,
    );

    act(() => vi.advanceTimersByTime(3_000));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("shows the exact promotion, already-Lead, permanent-DNC, stale, and failed breakdown", () => {
    render(
      <JobDetail
        job={makeJob({
          type: "promote_leads",
          status: "partially_completed",
          total_items: 6,
          processed_items: 6,
          succeeded_items: 2,
          failed_items: 1,
          result_summary: {
            promoted: 2,
            already_lead: 1,
            dnc_locked: 1,
            missing: 1,
            failed: 1,
            pending: 0,
          },
        })}
        items={[
          {
            id: "item-1",
            job_id: "job-1",
            property_id: "property-1",
            contact_id: null,
            message_id: null,
            status: "error",
            input_payload: null,
            output_payload: { outcome: "failed", retryable: true },
            error_message: "Synthetic failure",
            error_class: "database",
            retry_count: 0,
            processed_at: "2026-06-30T18:01:00.000Z",
            source_row_index: null,
            compliance_locked: false,
            item_key: "property-1",
          },
        ]}
        parent={null}
        childJobs={[]}
        csvImport={null}
        promotionRetryableCount={7}
      />,
    );

    const panel = screen.getByTestId("promote-leads-job-panel");
    expect(within(panel).getByText("Promotion results")).toBeVisible();
    expect(within(panel).getByText("Promoted").parentElement).toHaveTextContent(
      "2",
    );
    expect(
      within(panel).getByText("Already Leads").parentElement,
    ).toHaveTextContent("1");
    expect(
      within(panel).getByText("Became permanently DNC").parentElement,
    ).toHaveTextContent("1");
    expect(
      within(panel).getByText("Stale or missing").parentElement,
    ).toHaveTextContent("1");
    expect(within(panel).getByText("Failed").parentElement).toHaveTextContent(
      "1",
    );
    expect(
      screen.getByRole("button", { name: "Retry 7 failed" }),
    ).toBeVisible();
    expect(
      screen.getByRole("tab", { name: "Items (showing 1 of 6)" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Showing first 1 of 6; exact outcome totals are shown above.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/open the Audit tab to query raw/i)).toBeNull();
  });
});

describe("<JobDetail /> CSV recovery", () => {
  it("shows retry for a zero-row workflow-start failure when immutable provenance exists", () => {
    render(
      <JobDetail
        job={makeJob({
          type: "csv_import",
          status: "failed",
          total_items: 20,
          processed_items: 0,
          succeeded_items: 0,
          failed_items: 0,
          related_import_id: "import-1",
        })}
        items={[]}
        parent={null}
        childJobs={[]}
        csvImport={null}
        csvRetryAvailable
      />,
    );
    expect(screen.getByRole("button", { name: "Retry import" })).toBeVisible();
  });

  it("does not advertise retry when authoritative provenance is missing", () => {
    render(
      <JobDetail
        job={makeJob({ type: "csv_import", status: "failed", failed_items: 0 })}
        items={[]}
        parent={null}
        childJobs={[]}
        csvImport={null}
        csvRetryAvailable={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Retry import" })).toBeNull();
  });
});
