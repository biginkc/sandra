import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BulkTagModal } from "./bulk-tag-modal";

vi.mock("../leads/actions", () => ({
  createAndApplyCustomTagBulk: vi.fn(),
  createAndApplyCustomTagBulkFromFilters: vi.fn(),
}));

describe("BulkTagModal", () => {
  it("keeps long generated submit labels inside the modal footer", async () => {
    const user = userEvent.setup();

    render(
      <BulkTagModal
        open
        propertyIds={[]}
        filterArgs={{ search: null, blockStack: [] }}
        tags={[]}
        allMatching
        totalCount={15_401}
        onClose={vi.fn()}
        onApplied={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Tag name"), "mixed-sms-06/18/26");

    const submit = screen.getByRole("button", {
      name: "Create #mixed-sms-06/18/26 and apply",
    });
    expect(submit).toHaveClass(
      "min-w-0",
      "max-w-full",
      "overflow-hidden",
      "sm:w-full",
      "sm:shrink",
    );
    expect(submit).toHaveAttribute(
      "title",
      "Create #mixed-sms-06/18/26 and apply",
    );
    expect(submit.querySelector("span")).toHaveClass(
      "max-w-full",
      "truncate",
    );
    expect(submit.closest('[data-slot="dialog-footer"]')).toHaveClass(
      "sm:grid",
      "sm:grid-cols-[auto_minmax(0,1fr)]",
    );
  });
});
