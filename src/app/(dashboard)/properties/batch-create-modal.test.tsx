import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createDialerBatchFromFilters,
  createDialerBatchFromPropertyIds,
  getAllMatchingProspectIds,
  previewBatchEligibilityAction,
  toastSuccess,
} = vi.hoisted(() => ({
  createDialerBatchFromFilters: vi.fn(),
  createDialerBatchFromPropertyIds: vi.fn(),
  getAllMatchingProspectIds: vi.fn(),
  previewBatchEligibilityAction: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("./actions", () => ({
  createDialerBatchFromFilters,
  createDialerBatchFromPropertyIds,
  getAllMatchingProspectIds,
  previewBatchEligibilityAction,
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
  },
}));

// eslint-disable-next-line import/first
import { BatchCreateModal } from "./batch-create-modal";
// eslint-disable-next-line import/first
import type { FilterBlock } from "./prospects-query";

const defaultBlockStack: FilterBlock[] = [];

function renderModal(
  overrides: Partial<{
    open: boolean;
    onClose: () => void;
    selectedIds?: string[];
    filterArgs?: { search?: string | null; blockStack: FilterBlock[] };
    totalCount: number;
  }> = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <BatchCreateModal
      open={overrides.open ?? true}
      onClose={onClose}
      selectedIds={overrides.selectedIds}
      filterArgs={overrides.filterArgs}
      totalCount={overrides.totalCount ?? overrides.selectedIds?.length ?? 0}
    />,
  );
  return { onClose };
}

beforeEach(() => {
  createDialerBatchFromFilters.mockReset();
  createDialerBatchFromPropertyIds.mockReset();
  getAllMatchingProspectIds.mockReset();
  previewBatchEligibilityAction.mockReset();
  toastSuccess.mockReset();

  getAllMatchingProspectIds.mockResolvedValue({
    ok: true,
    data: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
  });
  previewBatchEligibilityAction.mockResolvedValue({
    ok: true,
    data: { callable: 5, blocked: { do_not_contact: 2 }, missing: 1 },
  });
  createDialerBatchFromPropertyIds.mockResolvedValue({
    ok: true,
    data: {
      batchId: "batch-123",
      counts: { callable: 5, blocked: { do_not_contact: 2 }, missing: 1 },
    },
  });
  createDialerBatchFromFilters.mockResolvedValue({
    ok: true,
    data: {
      batchId: "batch-456",
      counts: { callable: 5, blocked: { do_not_contact: 2 }, missing: 1 },
    },
  });
});

describe("<BatchCreateModal />", () => {
  it("renders title 'Create dialer batch'", async () => {
    renderModal({ selectedIds: ["p1"] });

    expect(
      screen.getByRole("heading", { name: "Create dialer batch" }),
    ).toBeInTheDocument();
    await screen.findByText("5 callable");
  });

  it("calls previewBatchEligibilityAction on open with selectedIds and renders counts", async () => {
    renderModal({ selectedIds: ["p1", "p2", "p3"] });

    await waitFor(() =>
      expect(previewBatchEligibilityAction).toHaveBeenCalledWith([
        "p1",
        "p2",
        "p3",
      ]),
    );
    expect(await screen.findByText("5 callable")).toBeInTheDocument();
    expect(screen.getByText("2 blocked")).toBeInTheDocument();
    expect(screen.getByText("1 missing phone")).toBeInTheDocument();
    expect(screen.getByText("do not contact: 2")).toBeInTheDocument();
  });

  it("disables Create batch button while preview is loading", async () => {
    previewBatchEligibilityAction.mockReturnValue(new Promise(() => undefined));
    renderModal({ selectedIds: ["p1"] });

    expect(
      screen.getByRole("button", { name: /Create batch/i }),
    ).toBeDisabled();
    expect(screen.getByText(/Checking callability/i)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
    expect(screen.queryByText("0 callable")).not.toBeInTheDocument();
    expect(screen.queryByText("0 blocked")).not.toBeInTheDocument();
    expect(screen.queryByText("0 missing phone")).not.toBeInTheDocument();
  });

  it("disables Create batch button while submission is in flight", async () => {
    const user = userEvent.setup();
    let resolveCreate: (value: unknown) => void = () => undefined;
    createDialerBatchFromPropertyIds.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );

    renderModal({ selectedIds: ["p1"] });
    await screen.findByText("5 callable");
    await user.click(screen.getByRole("button", { name: /Create batch/i }));

    expect(screen.getByRole("button", { name: /Creating/i })).toBeDisabled();
    await act(async () => {
      resolveCreate({
        ok: true,
        data: {
          batchId: "batch-789",
          counts: { callable: 1, blocked: {}, missing: 0 },
        },
      });
    });
  });

  it("calls createDialerBatchFromPropertyIds when selected-IDs mode", async () => {
    const user = userEvent.setup();
    renderModal({ selectedIds: ["a", "b", "c"] });
    await screen.findByText("5 callable");

    await user.click(screen.getByRole("button", { name: /Create batch/i }));

    await waitFor(() =>
      expect(createDialerBatchFromPropertyIds).toHaveBeenCalledWith(
        ["a", "b", "c"],
        expect.objectContaining({ sourceKind: "selected_ids" }),
      ),
    );
  });

  it("calls createDialerBatchFromFilters when select-all/filter mode", async () => {
    const user = userEvent.setup();
    renderModal({
      filterArgs: { search: "foo", blockStack: defaultBlockStack },
      totalCount: 1382,
    });
    await screen.findByText("5 callable");

    await user.click(screen.getByRole("button", { name: /Create batch/i }));

    await waitFor(() =>
      expect(createDialerBatchFromFilters).toHaveBeenCalledWith({
        search: "foo",
        blockStack: defaultBlockStack,
        imported: null,
        title: undefined,
      }),
    );
  });

  it("shows sonner toast on success and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ selectedIds: ["p1"], onClose });
    await screen.findByText("5 callable");

    await user.click(screen.getByRole("button", { name: /Create batch/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0][0]).toContain("Batch batch-123 created");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows error message on Result.ok=false and keeps modal open", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    createDialerBatchFromPropertyIds.mockResolvedValue({
      ok: false,
      error: { code: "BATCH_CREATE_FAILED", message: "Could not create batch" },
    });
    renderModal({ selectedIds: ["p1"], onClose });
    await screen.findByText("5 callable");

    await user.click(screen.getByRole("button", { name: /Create batch/i }));

    expect(await screen.findByText("Could not create batch")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows dashes instead of skeletons when loading matching prospects fails", async () => {
    getAllMatchingProspectIds.mockResolvedValue({
      ok: false,
      error: {
        code: "MATCHING_PROSPECTS_FAILED",
        message: "Could not load prospects",
      },
    });
    renderModal({
      filterArgs: { blockStack: defaultBlockStack },
      totalCount: 8,
    });

    expect(
      await screen.findByText("Could not load prospects"),
    ).toBeInTheDocument();
    expect(screen.getByText("— callable")).toBeInTheDocument();
    expect(screen.getByText("— blocked")).toBeInTheDocument();
    expect(screen.getByText("— missing phone")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it("shows dashes instead of skeletons when callability preview fails", async () => {
    previewBatchEligibilityAction.mockResolvedValue({
      ok: false,
      error: { code: "PREVIEW_FAILED", message: "Could not check callability" },
    });
    renderModal({ selectedIds: ["p1"] });

    expect(
      await screen.findByText("Could not check callability"),
    ).toBeInTheDocument();
    expect(screen.getByText("— callable")).toBeInTheDocument();
    expect(screen.getByText("— blocked")).toBeInTheDocument();
    expect(screen.getByText("— missing phone")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it("does not enable Create batch when preview returns 0 callable", async () => {
    previewBatchEligibilityAction.mockResolvedValue({
      ok: true,
      data: {
        callable: 0,
        blocked: { do_not_contact: 2, outside_window: 1 },
        missing: 4,
      },
    });
    renderModal({ selectedIds: ["p1", "p2"] });

    expect(await screen.findByText("0 callable")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Create batch/i }),
    ).toBeDisabled();
    expect(screen.getByText(/No callable phones/i)).toBeInTheDocument();
  });

  it("renders blocked-reason breakdown as a list", async () => {
    previewBatchEligibilityAction.mockResolvedValue({
      ok: true,
      data: {
        callable: 5,
        blocked: { do_not_contact: 2, outside_window: 3 },
        missing: 1,
      },
    });
    renderModal({ selectedIds: ["p1"] });

    const list = await screen.findByRole("list", {
      name: "Blocked reasons",
    });
    expect(within(list).getByText("do not contact: 2")).toBeInTheDocument();
    expect(within(list).getByText("outside window: 3")).toBeInTheDocument();
  });

  it("when both selectedIds and filterArgs are undefined: renders error state, dashes, Create button disabled, no server action called", () => {
    renderModal({ totalCount: 0 });

    expect(
      screen.getByText(/Select prospects or apply a filter to create a batch/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Create batch/i }),
    ).toBeDisabled();
    expect(screen.getByText("— callable")).toBeInTheDocument();
    expect(screen.getByText("— blocked")).toBeInTheDocument();
    expect(screen.getByText("— missing phone")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
    expect(previewBatchEligibilityAction).not.toHaveBeenCalled();
    expect(createDialerBatchFromPropertyIds).not.toHaveBeenCalled();
    expect(createDialerBatchFromFilters).not.toHaveBeenCalled();
  });

  it("when both selectedIds and filterArgs are populated: prefers selectedIds", async () => {
    const user = userEvent.setup();
    renderModal({
      selectedIds: ["a", "b"],
      filterArgs: { search: "foo", blockStack: defaultBlockStack },
      totalCount: 2,
    });
    await screen.findByText("5 callable");

    await user.click(screen.getByRole("button", { name: /Create batch/i }));

    await waitFor(() =>
      expect(createDialerBatchFromPropertyIds).toHaveBeenCalledWith(
        ["a", "b"],
        expect.any(Object),
      ),
    );
    expect(createDialerBatchFromFilters).not.toHaveBeenCalled();
  });
});
