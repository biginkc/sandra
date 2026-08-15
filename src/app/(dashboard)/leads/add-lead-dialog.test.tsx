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
      teamMembers={[
        { id: "user-me", email: "me@example.com" },
        { id: "user-other", email: "teammate@example.com" },
      ]}
      currentUserId="user-me"
    />,
  );
}

beforeEach(() => {
  createLeadFromForm.mockReset();
  routerPush.mockReset();
});

describe("AddLeadDialog", () => {
  it("preserves the real create form fields and includes prototype-approved persisted fields", async () => {
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
    expect(screen.getByLabelText("Assigned teammate")).toHaveValue("user-me");
    expect(screen.getByLabelText("Motivation (optional)")).toHaveValue("");
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
        assigned_user_id: "user-me",
        motivation_level: null,
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

  it("locks every close/save action and submits only once while creation is pending", async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: {
      ok: true;
      data: { propertyId: string; wasDuplicate: false; phoneDropped: null };
    }) => void;
    createLeadFromForm.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add lead" }));
    await user.type(screen.getByLabelText("Street address"), "123 Main St");
    await user.type(screen.getByLabelText("Phone"), "8165550100");
    const create = screen.getByRole("button", { name: "Create lead" });
    await user.dblClick(create);

    expect(createLeadFromForm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    resolveSave({
      ok: true,
      data: {
        propertyId: "property-1",
        wasDuplicate: false,
        phoneDropped: null,
      },
    });
    expect(await screen.findByRole("button", { name: "Add lead" })).toBeVisible();
    expect(routerPush).toHaveBeenCalledTimes(1);
  });

  it("surfaces an existing address without closing or reporting normal success", async () => {
    const user = userEvent.setup();
    createLeadFromForm.mockResolvedValue({
      ok: true,
      data: {
        propertyId: "property-existing",
        wasDuplicate: true,
        phoneDropped: null,
      },
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add lead" }));
    await user.type(screen.getByLabelText("Street address"), "123 Main St");
    await user.type(screen.getByLabelText("Phone"), "8165550100");
    await user.click(screen.getByRole("button", { name: "Create lead" }));

    expect(
      await screen.findByText("A lead already exists at this address."),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(routerPush).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Open existing lead" }));
    expect(routerPush).toHaveBeenCalledWith("/leads/property-existing");
  });
});
