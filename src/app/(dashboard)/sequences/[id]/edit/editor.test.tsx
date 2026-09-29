import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, expect, vi } from "vitest";

import { SequenceEditor } from "./editor";
import type { SequenceWithSteps } from "../../actions";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: (...args: unknown[]) => refresh(...args) }) }));
vi.mock("../../actions", () => ({ replaceSequenceSteps: (...args: unknown[]) => replace(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

afterEach(() => { replace.mockReset(); refresh.mockReset(); vi.restoreAllMocks(); });
const sequence: SequenceWithSteps = {
  id: "seq-1", name: "Seller follow-up", description: "Existing", active: true,
  append_opt_out: true, archived_at: null,
  steps: [{ id: "step-1", step_index: 0, delay_after_previous_minutes: 1440,
    action_type: "send_sms", template_body: "Hi", template_id: null, target_status: null }],
};
const mount = (options?: { isNew?: boolean; total?: number; steps?: SequenceWithSteps["steps"] }) =>
  render(<SequenceEditor sequence={{ ...sequence, steps: options?.steps ?? sequence.steps }}
    initialImpact={{ total_enrolled: options?.total ?? 0, scheduled_next_7d: 2 }}
    templates={[]} isNew={options?.isNew} />);

describe("drip editor", () => {
  it("saves edited details and every step with exactly one action call", async () => {
    replace.mockResolvedValue({ ok: true, data: ["step-1"] });
    const user = userEvent.setup(); mount();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "New name");
    const card = screen.getByRole("heading", { name: "Step 1" }).closest("div.rounded-md.border") as HTMLElement;
    await user.clear(within(card).getByRole("spinbutton"));
    await user.type(within(card).getByRole("spinbutton"), "3");
    await user.selectOptions(within(card).getByRole("combobox", { name: "Delay unit" }), "hours");
    await user.click(screen.getByRole("button", { name: "Save all steps" }));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ sequenceId: "seq-1", name: "New name",
      steps: [expect.objectContaining({ id: "step-1", step_index: 0, delay_after_previous_minutes: 180 })] }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });

  it("new=1 starts with exactly one blank step; Add step stays local until save", async () => {
    const user = userEvent.setup(); mount({ isNew: true, steps: [] });
    expect(screen.getAllByRole("heading", { name: /^Step \d+$/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save all steps" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add step" }));
    expect(screen.getAllByRole("heading", { name: /^Step \d+$/ })).toHaveLength(2);
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps returned IDs so saving a newly added step again updates it", async () => {
    replace.mockResolvedValue({ ok: true, data: ["step-1", "step-new"] });
    const user = userEvent.setup(); mount();
    await user.click(screen.getByRole("button", { name: "Add step" }));
    const newCard = screen.getByRole("heading", { name: "Step 2" }).closest("div.rounded-md.border") as HTMLElement;
    await user.type(within(newCard).getByPlaceholderText(/cash offer/i), "Another text");
    await user.click(screen.getByRole("button", { name: "Save all steps" }));
    await user.click(screen.getByRole("button", { name: "Save all steps" }));
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[1][0].steps[1].id).toBe("step-new");
  });

  it("warns once for active enrollments and cancellation leaves all data untouched", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup(); mount({ total: 3 });
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByText(/Move and delete are unavailable/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save all steps" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("deletes a draft step without a server mutation", async () => {
    const user = userEvent.setup(); mount();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("heading", { name: "Step 1" })).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
