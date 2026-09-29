import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ cancelEnrollment: vi.fn(), pauseEnrollmentAction: vi.fn(), changeDripAction: vi.fn() }));
vi.mock("../actions", () => actions);
vi.mock("./detail-actions", () => ({ copySequenceSteps: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/sequences/start-drip-picker", () => ({ StartDripPicker: () => null }));
import { sampleDetail } from "@/app/brand/drips/_sample-detail";
import { DripDetailView } from "./detail-view";

beforeEach(() => {
  actions.cancelEnrollment.mockReset().mockResolvedValue({ ok: true, data: null });
});

it("stops only the checked lead, leaving unselected and historical rows untouched", async () => {
  const user = userEvent.setup();
  render(<DripDetailView detail={sampleDetail} sources={[]} isAdmin />);
  await user.click(screen.getByRole("checkbox", { name: "Select Marisol Vega" }));
  await user.click(screen.getByRole("button", { name: "Stop drip" }));
  expect(actions.cancelEnrollment).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Stop selected" }));
  await waitFor(() => expect(actions.cancelEnrollment).toHaveBeenCalledTimes(1));
  expect(actions.cancelEnrollment).toHaveBeenCalledWith("enrollment-0");
});

it("keeps the step position visible when using the arrows", async () => {
  const user = userEvent.setup();
  render(<DripDetailView detail={sampleDetail} sources={[]} isAdmin />);
  expect(screen.getByText("6 steps · showing 1–4 of 6")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Next steps" }));
  expect(screen.getByText("6 steps · showing 2–5 of 6")).toBeVisible();
});
