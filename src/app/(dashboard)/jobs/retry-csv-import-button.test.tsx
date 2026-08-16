import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { retryCsvImportJob, getCsvImportRetryAvailability, routerRefresh } = vi.hoisted(() => ({
  retryCsvImportJob: vi.fn(),
  getCsvImportRetryAvailability: vi.fn(),
  routerRefresh: vi.fn(),
}));

vi.mock("../import/actions", () => ({
  retryCsvImportJob,
  getCsvImportRetryAvailability,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

import { RetryCsvImportButton } from "./retry-csv-import-button";

beforeEach(() => {
  retryCsvImportJob.mockReset();
  getCsvImportRetryAvailability.mockReset();
  getCsvImportRetryAvailability.mockResolvedValue({
    ok: true,
    data: { state: "retryable", message: null },
  });
  routerRefresh.mockReset();
});

describe("RetryCsvImportButton", () => {
  it("restores retry and reports a rejected request", async () => {
    retryCsvImportJob.mockRejectedValueOnce(new Error("Connection lost"));
    const user = userEvent.setup();
    render(<RetryCsvImportButton jobId="job-1" />);

    await user.click(
      await screen.findByRole("button", { name: "Retry import" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection lost",
    );
    expect(screen.getByRole("button", { name: "Retry import" })).toBeEnabled();
  });

  it.each([
    [
      "manual_reconciliation",
      "Automatic retry is blocked to prevent a duplicate provider charge.",
    ],
    ["exhausted", "This import has used all of its retry attempts."],
    ["in_flight", "This import is already being processed."],
  ])("shows %s without offering a retry loop", async (state, message) => {
    getCsvImportRetryAvailability.mockResolvedValueOnce({
      ok: true,
      data: { state, message },
    });
    render(<RetryCsvImportButton jobId="job-1" />);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry import" }),
    ).not.toBeInTheDocument();
  });

  it("stops offering Retry when the claim discovers manual reconciliation", async () => {
    retryCsvImportJob.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "CSV_IMPORT_RETRY_MANUAL_RECONCILIATION",
        message:
          "Automatic retry is blocked to prevent a duplicate provider charge.",
      },
    });
    const user = userEvent.setup();
    render(<RetryCsvImportButton jobId="job-1" />);

    await user.click(
      await screen.findByRole("button", { name: "Retry import" }),
    );

    expect(
      await screen.findByText(
        "Automatic retry is blocked to prevent a duplicate provider charge.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry import" }),
    ).not.toBeInTheDocument();
  });
});
