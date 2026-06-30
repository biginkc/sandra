import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
