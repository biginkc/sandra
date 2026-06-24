import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TemplateDialog } from "./template-dialog";

vi.mock("./actions", () => ({
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
}));

vi.mock("@/lib/errors/call-action", () => ({
  callAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

describe("TemplateDialog width", () => {
  it("renders the dialog at sm:max-w-4xl, not the primitive's default sm:max-w-sm", () => {
    render(
      <TemplateDialog
        mode="create"
        open
        onOpenChange={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("sm:max-w-4xl");
    expect(dialog.className).not.toContain("sm:max-w-sm");
  });

  it("previews the fixed sender persona passed from the server", () => {
    render(
      <TemplateDialog
        mode="create"
        open
        onOpenChange={vi.fn()}
        senderName="Rosa"
      />,
    );

    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: "Hi {{first_name}}, {{my_first_name}} here." },
    });

    expect(screen.getByText("Hi John, Rosa here.")).toBeVisible();
    expect(screen.getByText(/Sender Name: Rosa/)).toBeVisible();
  });
});
