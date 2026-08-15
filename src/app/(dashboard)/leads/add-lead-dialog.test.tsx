import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLeadFromForm, routerPush } = vi.hoisted(() => ({
  createLeadFromForm: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("./new/actions", () => ({
  createLeadFromForm,
}));

import { AddLeadDialog } from "./add-lead-dialog";

function renderDialog() {
  return render(
    <AddLeadDialog
      markets={["Jackson County MO", "Johnson County KS"]}
      sources={["cold_call", "referral"]}
    />,
  );
}

beforeEach(() => {
  createLeadFromForm.mockReset();
  routerPush.mockReset();
});

describe("AddLeadDialog", () => {
  it("preserves the real create form fields and omits fields the save path cannot persist", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add lead" }));

    expect(screen.getByLabelText("Street address")).toBeRequired();
    expect(screen.getByLabelText("City")).toBeVisible();
    expect(screen.getByLabelText("State")).toBeRequired();
    expect(screen.getByLabelText("ZIP")).toBeVisible();
    expect(screen.getByLabelText("Market")).toBeVisible();
    expect(screen.getByLabelText("First name")).toBeVisible();
    expect(screen.getByLabelText("Last name")).toBeVisible();
    expect(screen.getByLabelText("Phone")).toBeVisible();
    expect(screen.getByLabelText("Email")).toBeVisible();
    expect(screen.queryByLabelText(/assignee/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/motivation/i)).not.toBeInTheDocument();
  });

  it("warns rather than blocks when no phone or email is supplied", async () => {
    const user = userEvent.setup();
    createLeadFromForm.mockResolvedValue({
      ok: true,
      data: {
        propertyId: "property-1",
        wasDuplicate: false,
        phoneDropped: null,
      },
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add lead" }));
    await user.type(screen.getByLabelText("Street address"), "123 Main St");
    await user.click(screen.getByRole("button", { name: "Create lead" }));

    expect(screen.getByText("No phone or email was provided.")).toBeVisible();
    expect(createLeadFromForm).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Create without contact details" }),
    );
    expect(createLeadFromForm).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "123 Main St",
        state: "MO",
        phone_1: "",
        email: "",
      }),
    );
    expect(routerPush).toHaveBeenCalledWith("/leads/property-1");
  });

  it("protects a dirty form before closing", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");
    confirm.mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add lead" }));
    await user.type(screen.getByLabelText("Street address"), "123 Main St");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("keeps the form open with a retryable message after an unexpected save failure", async () => {
    const user = userEvent.setup();
    createLeadFromForm.mockRejectedValue(new Error("network unavailable"));
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add lead" }));
    await user.type(screen.getByLabelText("Street address"), "123 Main St");
    await user.type(screen.getByLabelText("Phone"), "8165550100");
    await user.click(screen.getByRole("button", { name: "Create lead" }));

    expect(
      await screen.findByText("We couldn't create this lead. Try again."),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(routerPush).not.toHaveBeenCalled();
  });
});
