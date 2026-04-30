import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, expect, vi } from "vitest";

import { SequenceEditor } from "./editor";
import type { SequenceWithSteps } from "../../actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

const upsertSequenceStep = vi.fn();
const deleteSequenceStep = vi.fn();
const updateSequence = vi.fn();

vi.mock("../../actions", () => ({
  upsertSequenceStep: (...args: unknown[]) => upsertSequenceStep(...args),
  deleteSequenceStep: (...args: unknown[]) => deleteSequenceStep(...args),
  updateSequence: (...args: unknown[]) => updateSequence(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  upsertSequenceStep.mockReset();
  deleteSequenceStep.mockReset();
  updateSequence.mockReset();
});

function makeSequence(
  overrides: Partial<SequenceWithSteps> = {},
): SequenceWithSteps {
  return {
    id: overrides.id ?? "seq-1",
    name: overrides.name ?? "Flow",
    description: overrides.description ?? null,
    active: overrides.active ?? true,
    append_opt_out: overrides.append_opt_out ?? false,
    archived_at: overrides.archived_at ?? null,
    steps: overrides.steps ?? [],
  };
}

function makeStep(
  overrides: Partial<SequenceWithSteps["steps"][number]> & { id: string },
): SequenceWithSteps["steps"][number] {
  return {
    id: overrides.id,
    step_index: overrides.step_index ?? 0,
    delay_after_previous_minutes: overrides.delay_after_previous_minutes ?? 0,
    action_type: overrides.action_type ?? "send_sms",
    template_body: overrides.template_body ?? "Hi",
    template_id: overrides.template_id ?? null,
    target_status: overrides.target_status ?? null,
  };
}

function renderEditor(sequence: SequenceWithSteps) {
  return render(
    <SequenceEditor
      sequence={sequence}
      initialImpact={{ total_enrolled: 0, scheduled_next_7d: 0 }}
      templates={[]}
    />,
  );
}

describe("<SequenceEditor /> — sequences-flows migrated tests", () => {
  it("2. add-step modal validates required fields + persists on save", async () => {
    const user = userEvent.setup();
    upsertSequenceStep.mockResolvedValue({ ok: true, data: { id: "step-new" } });

    renderEditor(makeSequence({ id: "seq-2", steps: [] }));

    await user.click(screen.getByRole("button", { name: /add step/i }));

    const modal = await screen.findByRole("dialog");
    expect(modal).toBeInTheDocument();
    const modalSubmit = within(modal).getByRole("button", {
      name: /add step/i,
    });
    expect(modalSubmit).toBeDisabled();

    await user.type(
      within(modal).getByPlaceholderText(/cash offer/i),
      "Hi {{first_name}}, testing from flow-2",
    );
    expect(modalSubmit).toBeEnabled();

    await user.click(modalSubmit);

    expect(upsertSequenceStep).toHaveBeenCalledTimes(1);
    const call = upsertSequenceStep.mock.calls[0][0];
    expect(call.sequence_id).toBe("seq-2");
    expect(call.step_index).toBe(0);
    expect(call.action_type).toBe("send_sms");
    expect(call.template_body).toContain("testing from flow-2");
  });

  it("3. delay unit picker round-trips (1 day → 3 hours)", async () => {
    const user = userEvent.setup();
    upsertSequenceStep.mockResolvedValue({ ok: true, data: { id: "step-3" } });

    const step = makeStep({
      id: "step-3",
      delay_after_previous_minutes: 1440,
      template_body: "Hello",
    });
    const { unmount } = renderEditor(
      makeSequence({ id: "seq-3", steps: [step] }),
    );

    expect(screen.getByRole("heading", { name: /^Step 1$/ })).toBeInTheDocument();
    const stepCard = screen
      .getByRole("heading", { name: /^Step 1$/ })
      .closest("div.rounded-md.border") as HTMLElement;
    expect(stepCard).not.toBeNull();

    const amount = within(stepCard).getAllByRole("spinbutton")[0];
    expect(amount).toHaveValue(1);
    const unit = within(stepCard).getAllByRole("combobox")[0];
    expect(unit).toHaveValue("days");

    await user.clear(amount);
    await user.type(amount, "3");
    await user.selectOptions(unit, "hours");

    await user.click(within(stepCard).getByRole("button", { name: /save step/i }));

    expect(upsertSequenceStep).toHaveBeenCalledTimes(1);
    const call = upsertSequenceStep.mock.calls[0][0];
    expect(call.id).toBe("step-3");
    expect(call.delay_after_previous_minutes).toBe(180);

    // "Reload" by re-rendering with the persisted minutes value — the
    // unit picker should now display 3 hours.
    unmount();
    renderEditor(
      makeSequence({
        id: "seq-3",
        steps: [
          makeStep({
            id: "step-3",
            delay_after_previous_minutes: 180,
            template_body: "Hello",
          }),
        ],
      }),
    );
    const reloadedCard = screen
      .getByRole("heading", { name: /^Step 1$/ })
      .closest("div.rounded-md.border") as HTMLElement;
    expect(within(reloadedCard).getAllByRole("spinbutton")[0]).toHaveValue(3);
    expect(within(reloadedCard).getAllByRole("combobox")[0]).toHaveValue("hours");
  });

  it("4. delete a step removes it from the list", async () => {
    const user = userEvent.setup();
    deleteSequenceStep.mockResolvedValue({ ok: true, data: undefined });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const step = makeStep({
      id: "step-4",
      template_body: "Only step",
    });
    const { rerender } = renderEditor(
      makeSequence({ id: "seq-4", steps: [step] }),
    );

    expect(screen.getByRole("heading", { name: /^Step 1$/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(deleteSequenceStep).toHaveBeenCalledTimes(1);
    expect(deleteSequenceStep).toHaveBeenCalledWith("step-4", "seq-4");

    // Server-side rerender (simulating router.refresh) drops the step
    // and the empty state surfaces.
    rerender(
      <SequenceEditor
        sequence={makeSequence({ id: "seq-4", steps: [] })}
        initialImpact={{ total_enrolled: 0, scheduled_next_7d: 0 }}
        templates={[]}
      />,
    );
    expect(screen.getByText(/no steps yet/i)).toBeInTheDocument();

    confirmSpy.mockRestore();
  });
});
