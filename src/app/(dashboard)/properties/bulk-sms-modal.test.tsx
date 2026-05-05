import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bulkQueueSms, listSmsTemplateCategories, countAlreadyContacted } =
  vi.hoisted(() => ({
    bulkQueueSms: vi.fn(),
    listSmsTemplateCategories: vi.fn(),
    countAlreadyContacted: vi.fn(),
  }));

vi.mock("./actions", () => ({
  bulkQueueSms,
  listSmsTemplateCategories,
  countAlreadyContacted,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// eslint-disable-next-line import/first
import { BulkSmsModal } from "./bulk-sms-modal";

function renderModal(
  propertyIds: string[],
  overrides: Partial<{
    open: boolean;
    onClose: () => void;
    onQueued: (n: number) => void;
  }> = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const onQueued = overrides.onQueued ?? vi.fn();
  return render(
    <BulkSmsModal
      open={overrides.open ?? true}
      propertyIds={propertyIds}
      onClose={onClose}
      onQueued={onQueued}
    />,
  );
}

beforeEach(() => {
  bulkQueueSms.mockReset();
  listSmsTemplateCategories.mockReset();
  countAlreadyContacted.mockReset();

  listSmsTemplateCategories.mockResolvedValue({
    ok: true,
    data: [
      { category: "Opener - Homeowner", count: 15 },
      { category: "Outreach - Homeowner", count: 9 },
    ],
  });
  countAlreadyContacted.mockResolvedValue({ ok: true, data: 0 });
  bulkQueueSms.mockResolvedValue({
    ok: true,
    data: { succeeded: 0, skipped: 0, failed: [] },
  });
});

describe("<BulkSmsModal /> pacing + skip-contacted (260504-tgq)", () => {
  it("Pacing input defaults to 18 with seconds unit", async () => {
    renderModal(["p1"]);

    // Wait for the open-time effects to settle (categories + count fetch).
    await waitFor(() =>
      expect(listSmsTemplateCategories).toHaveBeenCalled(),
    );

    const paceInput = screen.getByLabelText(/^Pacing$/i) as HTMLInputElement;
    expect(paceInput.value).toBe("18");

    const paceUnit = screen.getByLabelText(
      /Pacing unit/i,
    ) as HTMLSelectElement;
    expect(paceUnit.value).toBe("seconds");
  });

  it("Selecting 'minutes' and entering 5 submits paceSeconds=300", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });

    renderModal(["p1"]);
    await waitFor(() =>
      expect(listSmsTemplateCategories).toHaveBeenCalled(),
    );

    const paceInput = screen.getByLabelText(/^Pacing$/i);
    const paceUnit = screen.getByLabelText(/Pacing unit/i);

    await user.clear(paceInput);
    await user.type(paceInput, "5");
    await user.selectOptions(paceUnit, "minutes");

    await user.click(
      screen.getByRole("button", { name: /Queue 1 message/i }),
    );

    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [ids, opts] = bulkQueueSms.mock.calls[0];
    expect(ids).toEqual(["p1"]);
    expect(opts.paceSeconds).toBe(300);
  });

  it("Pacing of 5 seconds shows inline validation error and submit does not call bulkQueueSms", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);
    await waitFor(() =>
      expect(listSmsTemplateCategories).toHaveBeenCalled(),
    );

    const paceInput = screen.getByLabelText(/^Pacing$/i);
    await user.clear(paceInput);
    await user.type(paceInput, "5");

    // Inline error renders below the field.
    expect(
      await screen.findByText(/between 10 seconds and 10 minutes/i),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Queue 1 message/i }),
    );

    expect(bulkQueueSms).not.toHaveBeenCalled();
  });

  it("Pacing of 11 minutes shows inline validation error and submit does not call bulkQueueSms", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);
    await waitFor(() =>
      expect(listSmsTemplateCategories).toHaveBeenCalled(),
    );

    const paceInput = screen.getByLabelText(/^Pacing$/i);
    const paceUnit = screen.getByLabelText(/Pacing unit/i);

    await user.clear(paceInput);
    await user.type(paceInput, "11");
    await user.selectOptions(paceUnit, "minutes");

    expect(
      await screen.findByText(/between 10 seconds and 10 minutes/i),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Queue 1 message/i }),
    );

    expect(bulkQueueSms).not.toHaveBeenCalled();
  });

  it("Skip-contacted checkbox is checked by default when propertyIds.length is 51", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `p${i + 1}`);
    renderModal(ids);
    await waitFor(() =>
      expect(listSmsTemplateCategories).toHaveBeenCalled(),
    );

    const skipCheckbox = screen.getByRole("checkbox", {
      name: /Skip prospects already contacted/i,
    }) as HTMLInputElement;
    expect(skipCheckbox.checked).toBe(true);
  });

  it("Skip-contacted checkbox is unchecked by default when propertyIds.length is 50", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `p${i + 1}`);
    renderModal(ids);
    await waitFor(() =>
      expect(listSmsTemplateCategories).toHaveBeenCalled(),
    );

    const skipCheckbox = screen.getByRole("checkbox", {
      name: /Skip prospects already contacted/i,
    }) as HTMLInputElement;
    expect(skipCheckbox.checked).toBe(false);
  });

  it("Modal open fires countAlreadyContacted with the given propertyIds and renders the returned count in the checkbox label", async () => {
    countAlreadyContacted.mockResolvedValue({ ok: true, data: 24 });

    renderModal(["p1", "p2", "p3"]);

    await waitFor(() =>
      expect(countAlreadyContacted).toHaveBeenCalledWith(["p1", "p2", "p3"]),
    );

    // Once loaded the label should include the live count.
    expect(
      await screen.findByText(/Skip prospects already contacted \(24\)/i),
    ).toBeInTheDocument();
  });

  it("Submit passes paceSeconds AND skipIfContacted to bulkQueueSms", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    countAlreadyContacted.mockResolvedValue({ ok: true, data: 7 });

    // 51 ids → skip-contacted defaults to true.
    const ids = Array.from({ length: 51 }, (_, i) => `p${i + 1}`);
    renderModal(ids);
    await waitFor(() =>
      expect(listSmsTemplateCategories).toHaveBeenCalled(),
    );
    await waitFor(() => expect(countAlreadyContacted).toHaveBeenCalled());

    const paceInput = screen.getByLabelText(/^Pacing$/i);
    await user.clear(paceInput);
    await user.type(paceInput, "30");

    await user.click(
      screen.getByRole("button", { name: /Queue 51 messages/i }),
    );

    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [, opts] = bulkQueueSms.mock.calls[0];
    expect(opts.paceSeconds).toBe(30);
    expect(opts.skipIfContacted).toBe(true);
    // Template-pool mode should also forward the category.
    expect(opts.templateCategory).toBe("Opener - Homeowner");
  });

  it("Helper text reflects current resolved pace seconds (in-range values only; out-of-range swaps to inline error)", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);
    await waitFor(() =>
      expect(listSmsTemplateCategories).toHaveBeenCalled(),
    );

    // Default 18 seconds → "18-second intervals"
    expect(
      screen.getByText(/Messages release at 18-second intervals\./i),
    ).toBeInTheDocument();

    const paceInput = screen.getByLabelText(/^Pacing$/i);
    await user.clear(paceInput);
    await user.type(paceInput, "12");

    // Still in-range — helper text reflects new value.
    expect(
      await screen.findByText(/Messages release at 12-second intervals\./i),
    ).toBeInTheDocument();

    const paceUnit = screen.getByLabelText(/Pacing unit/i);
    await user.clear(paceInput);
    await user.type(paceInput, "5");
    await user.selectOptions(paceUnit, "minutes");

    // 5 minutes → 300 seconds → "300-second intervals"
    expect(
      await screen.findByText(/Messages release at 300-second intervals\./i),
    ).toBeInTheDocument();
  });
});
