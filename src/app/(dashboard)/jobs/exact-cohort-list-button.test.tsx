import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createExactCohortList, routerRefresh, toastSuccess } = vi.hoisted(() => ({
  createExactCohortList: vi.fn(),
  routerRefresh: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("./actions", () => ({ createExactCohortList }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: vi.fn(), info: vi.fn() },
}));

import { ExactCohortListButton } from "./exact-cohort-list-button";

describe("<ExactCohortListButton />", () => {
  beforeEach(() => {
    createExactCohortList.mockReset();
    routerRefresh.mockReset();
    toastSuccess.mockReset();
  });

  it("reviews the exact persisted count and sends the chosen name to the server action", async () => {
    createExactCohortList.mockResolvedValueOnce({
      ok: true,
      data: {
        listId: "list-1",
        name: "CASS verify 4717 properties",
        memberCount: 4_700,
        dncExcludedCount: 17,
        sourceJobId: "job-1",
      },
    });
    const user = userEvent.setup();
    render(
      <ExactCohortListButton
        jobId="job-1"
        defaultName="CASS verify 4717 properties"
        propertyCount={4_717}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create exact cohort list" }));
    expect(
      screen.getByText(/exactly 4,717 persisted job properties/),
    ).toBeVisible();

    const input = screen.getByLabelText("List name");
    await user.clear(input);
    await user.type(input, "Johnson County CASS 2026-09-24");
    await user.click(screen.getByRole("button", { name: "Save exact list" }));

    expect(createExactCohortList).toHaveBeenCalledWith({
      jobId: "job-1",
      name: "Johnson County CASS 2026-09-24",
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Use this list in the campaign audience filter"),
    );
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not submit an empty name", async () => {
    const user = userEvent.setup();
    render(
      <ExactCohortListButton
        jobId="job-2"
        defaultName="Skip-trace exact cohort"
        propertyCount={12}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create exact cohort list" }));
    await user.clear(screen.getByLabelText("List name"));
    expect(screen.getByRole("button", { name: "Save exact list" })).toBeDisabled();
    expect(createExactCohortList).not.toHaveBeenCalled();
  });
});
