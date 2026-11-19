import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
vi.mock("./voicemail-template-actions", () => ({
  createVoicemailTemplate: (...a: unknown[]) => create(...a),
  updateVoicemailTemplate: (...a: unknown[]) => update(...a),
  deleteVoicemailTemplate: (...a: unknown[]) => remove(...a),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { VoicemailTemplatesSection } from "./voicemail-templates-section";

afterEach(() => { create.mockReset(); update.mockReset(); remove.mockReset(); });

const row = (id: string, category: string, content: string) =>
  ({ id, name: `Script ${id}`, content, category, created_at: "", updated_at: "" });

describe("voicemail scripts on the Templates page", () => {
  it("lists scripts by group and flags ones that cannot be read aloud", () => {
    render(<VoicemailTemplatesSection templates={[row("1", "Group A", "Hi"), row("2", "Group B", "[Hi/Hello]")]} />);
    expect(screen.getByText("Group A")).toBeInTheDocument();
    expect(screen.getByText("Group B")).toBeInTheDocument();
    expect(screen.getByText(/Remove \[this\/that\] choices/)).toBeInTheDocument();
  });

  it("creates a script with a group; the save button waits for a valid script", async () => {
    create.mockResolvedValue({ ok: true, data: { id: "vt-new" } });
    const user = userEvent.setup();
    render(<VoicemailTemplatesSection templates={[]} />);
    await user.click(screen.getByRole("button", { name: "New voicemail script" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save" });
    await user.type(within(dialog).getByLabelText("Name"), "First");
    await user.type(within(dialog).getByLabelText("Group"), "Group A");
    await user.type(within(dialog).getByLabelText("Script"), "Hi {{first_name}");
    expect(save).toBeDisabled();
    await user.clear(within(dialog).getByLabelText("Script"));
    await user.type(within(dialog).getByLabelText("Script"), "Hi {{{{first_name}}");
    expect(save).toBeEnabled();
    await user.click(save);
    expect(create).toHaveBeenCalledWith({ name: "First", category: "Group A", content: "Hi {{first_name}}" });
  });

  it("blocks scripts over 1,200 characters", async () => {
    const user = userEvent.setup();
    render(<VoicemailTemplatesSection templates={[row("1", "Group A", "a".repeat(1201))]} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("1201 / 1,200")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
