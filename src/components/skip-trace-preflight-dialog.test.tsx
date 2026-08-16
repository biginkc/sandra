import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { SkipTracePreflightDialog } from "./skip-trace-preflight-dialog";
import type { SkipTracePreflight } from "@/lib/skip-trace/actions";

const {
  approveSkipTraceJob,
  preflightSkipTrace,
  requestSkipTrace,
  verifyPropertiesBulk,
} = vi.hoisted(() => ({
  approveSkipTraceJob: vi.fn(),
  preflightSkipTrace: vi.fn(),
  requestSkipTrace: vi.fn(),
  verifyPropertiesBulk: vi.fn(),
}));

vi.mock("@/app/(dashboard)/leads/actions", () => ({
  verifyPropertiesBulk,
}));

vi.mock("@/lib/skip-trace/actions", () => ({
  approveSkipTraceJob,
  preflightSkipTrace,
  requestSkipTrace,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function makePreflight(
  overrides: Partial<SkipTracePreflight> = {},
): SkipTracePreflight {
  return {
    requested: 3,
    eligible: 1,
    cassVerified: 1,
    cassUnverified: 2,
    notEligible: 2,
    killSwitchSkipped: 0,
    tracefyCreditsRequired: 5,
    tracefyCreditsAvailable: 100,
    tracefyCreditStatus: "sufficient",
    canLaunchSkipTrace: true,
    estimatedCassVerificationCostUsd: 0.06,
    cassVerificationPropertyIds: ["u1", "u2"],
    ...overrides,
  };
}

function renderDialog(
  preflight: SkipTracePreflight,
  props: Partial<ComponentProps<typeof SkipTracePreflightDialog>> = {},
) {
  preflightSkipTrace.mockResolvedValue({ ok: true, data: preflight });
  requestSkipTrace.mockResolvedValue({
    ok: true,
    data: {
      jobId: "job-1",
      status: "queued",
      requested: preflight.requested,
      eligible: preflight.eligible,
      cassSkipped: preflight.cassUnverified,
      killSwitchSkipped: preflight.killSwitchSkipped,
    },
  });
  verifyPropertiesBulk.mockResolvedValue({
    ok: true,
    data: { jobId: "cass-job-1" },
  });

  return render(
    <SkipTracePreflightDialog
      open
      onOpenChange={vi.fn()}
      propertyIds={["p1", "p2", "p3"]}
      {...props}
    />,
  );
}

function expectMetric(label: string, value: string) {
  const container = screen.getByText(label).parentElement;
  expect(container).not.toBeNull();
  expect(within(container!).getByText(value)).toBeInTheDocument();
}

describe("<SkipTracePreflightDialog />", () => {
  beforeEach(() => {
    approveSkipTraceJob.mockReset();
    preflightSkipTrace.mockReset();
    requestSkipTrace.mockReset();
    verifyPropertiesBulk.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.info).mockClear();
  });

  it("shows CASS counts, Tracefy credits, and CASS estimate", async () => {
    renderDialog(makePreflight());

    expect(
      await screen.findByRole("heading", {
        name: "Confirm skip-trace preflight",
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText("100 available / 5 needed")).toBeInTheDocument();
    expectMetric("Selected", "3");
    expectMetric("Skip-trace eligible", "1");
    expectMetric("CASS verified", "1");
    expectMetric("CASS not verified", "2");
    expectMetric("Can CASS now", "2");
    expectMetric("Not eligible", "2");
    expectMetric("Skip-trace disabled", "0");
    expect(screen.getByText(/\$0\.06/)).toBeInTheDocument();
  });

  it("does not claim a canceled approval is running", async () => {
    approveSkipTraceJob.mockResolvedValue({
      ok: true,
      data: { jobId: "job-1", status: "canceled", excluded: 3 },
    });
    renderDialog(
      makePreflight({
        requested: 3,
        eligible: 3,
        cassVerified: 3,
        cassUnverified: 0,
        notEligible: 0,
        cassVerificationPropertyIds: [],
      }),
      { approveJobId: "job-1" },
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Approve skip-trace" }),
    );

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        "Skip-trace canceled - nothing eligible remains.",
        expect.objectContaining({ description: expect.stringContaining("3 properties") }),
      );
    });
    expect(toast.success).not.toHaveBeenCalledWith(
      "Skip-trace approved - running.",
    );
  });

  it("reports a queued approval as running", async () => {
    approveSkipTraceJob.mockResolvedValue({
      ok: true,
      data: { jobId: "job-1", status: "queued", excluded: 1 },
    });
    renderDialog(
      makePreflight({
        requested: 2,
        eligible: 2,
        cassVerified: 2,
        cassUnverified: 0,
        notEligible: 0,
        cassVerificationPropertyIds: [],
      }),
      { approveJobId: "job-1" },
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Approve skip-trace" }),
    );

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        "Skip-trace approved - running.",
      );
    });
  });

  it("highlights CASS verification as the primary action for mixed selections", async () => {
    renderDialog(makePreflight());

    const verifyButton = await screen.findByRole("button", {
      name: "Verify unverified addresses",
    });
    const skipButton = screen.getByRole("button", {
      name: "Skip trace verified only",
    });

    expect(verifyButton).toHaveClass("bg-primary");
    expect(skipButton).toHaveClass("border-border");
  });

  it("requires explicit CASS spend confirmation before verifying", async () => {
    const user = userEvent.setup();
    renderDialog(makePreflight());

    await screen.findByText("100 available / 5 needed");
    await user.click(
      screen.getByRole("button", { name: "Verify unverified addresses" }),
    );

    expect(verifyPropertiesBulk).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Confirm CASS verification before spend/),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Start CASS verification" }),
    );

    await waitFor(() => {
      expect(verifyPropertiesBulk).toHaveBeenCalledWith(
        ["u1", "u2"],
        expect.any(String),
      );
    });
    expect(requestSkipTrace).not.toHaveBeenCalled();
  });

  it("launches only through the server request action after preflight", async () => {
    const user = userEvent.setup();
    renderDialog(makePreflight());

    await screen.findByText("100 available / 5 needed");
    await user.click(
      screen.getByRole("button", { name: "Skip trace verified only" }),
    );

    await waitFor(() => {
      expect(requestSkipTrace).toHaveBeenCalledWith(["p1", "p2", "p3"]);
    });
  });

  it("disables skip trace when Tracefy credits are unavailable", async () => {
    renderDialog(
      makePreflight({
        tracefyCreditsAvailable: null,
        tracefyCreditStatus: "unavailable",
        canLaunchSkipTrace: false,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getAllByText(/Tracefy credits could not be confirmed/).length,
      ).toBeGreaterThan(0);
    });
    expect(
      screen.getByRole("button", { name: "Skip trace verified only" }),
    ).toBeDisabled();
  });

  it("disables skip trace when Tracefy credits are insufficient", async () => {
    renderDialog(
      makePreflight({
        tracefyCreditsAvailable: 4,
        tracefyCreditStatus: "insufficient",
        canLaunchSkipTrace: false,
      }),
    );

    expect(await screen.findByText("4 available / 5 needed")).toBeInTheDocument();
    expect(
      screen.getByText(/Tracefy credits are insufficient/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Skip trace verified only" }),
    ).toBeDisabled();
  });

  it("does not enable pending approval when the job eligibility is stale", async () => {
    renderDialog(makePreflight(), { approveJobId: "job-1" });

    expect(
      await screen.findByText(
        /Pending job must be fully CASS-verified and eligible before approval/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve skip-trace" }),
    ).toBeDisabled();
  });

  it("ignores stale preflight results after the selected records change", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    preflightSkipTrace
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const onOpenChange = vi.fn();
    const { rerender } = render(
      <SkipTracePreflightDialog
        open
        onOpenChange={onOpenChange}
        propertyIds={["p1"]}
      />,
    );
    await waitFor(() => {
      expect(preflightSkipTrace).toHaveBeenCalledWith(["p1"]);
    });

    rerender(
      <SkipTracePreflightDialog
        open
        onOpenChange={onOpenChange}
        propertyIds={["p2"]}
      />,
    );
    await waitFor(() => {
      expect(preflightSkipTrace).toHaveBeenCalledWith(["p2"]);
    });

    await act(async () => {
      resolveSecond({
        ok: true,
        data: makePreflight({
          requested: 1,
          eligible: 1,
          cassVerified: 1,
          cassUnverified: 0,
          notEligible: 0,
          tracefyCreditsAvailable: 80,
          cassVerificationPropertyIds: [],
          estimatedCassVerificationCostUsd: 0,
        }),
      });
    });
    expect(await screen.findByText("80 available / 5 needed")).toBeInTheDocument();

    await act(async () => {
      resolveFirst({
        ok: true,
        data: makePreflight({
          requested: 1,
          eligible: 0,
          cassVerified: 0,
          cassUnverified: 1,
          notEligible: 1,
          tracefyCreditsAvailable: 5,
          canLaunchSkipTrace: false,
        }),
      });
    });

    expect(screen.getByText("80 available / 5 needed")).toBeInTheDocument();
    expect(screen.queryByText("5 available / 5 needed")).not.toBeInTheDocument();
  });
});
