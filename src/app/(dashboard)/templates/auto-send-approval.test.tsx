import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AutoSendApproval } from "./auto-send-approval";

const { setTemplateAutoSendApproval } = vi.hoisted(() => ({
  setTemplateAutoSendApproval: vi.fn(),
}));

vi.mock("./auto-reply-actions", () => ({ setTemplateAutoSendApproval }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const TEXT = "Hi {{first_name | there}}, thanks for the reply.\nTalk soon.";
const tpl = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Thanks",
  content: TEXT,
  approved_for_auto_send: false,
  approved_at: null,
  ...over,
});

beforeEach(() => {
  setTemplateAutoSendApproval.mockReset();
  setTemplateAutoSendApproval.mockResolvedValue({ ok: true, data: { approved: true } });
});

describe("<AutoSendApproval />", () => {
  it("owners see an unchecked 'Approved for automatic replies' switch", () => {
    render(<AutoSendApproval template={tpl()} isOwner />);
    const toggle = screen.getByRole("switch", { name: /approved for automatic replies/i });
    expect(toggle).not.toBeChecked();
  });

  it("turning it on does NOT approve yet: it shows the exact text first", async () => {
    const user = userEvent.setup();
    render(<AutoSendApproval template={tpl()} isOwner />);
    await user.click(screen.getByRole("switch", { name: /approved for automatic replies/i }));

    expect(setTemplateAutoSendApproval).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByTestId("approval-exact-text").textContent).toBe(TEXT);
  });

  it("cancelling leaves the template unapproved and sends nothing to the server", async () => {
    const user = userEvent.setup();
    render(<AutoSendApproval template={tpl()} isOwner />);
    await user.click(screen.getByRole("switch", { name: /approved for automatic replies/i }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(setTemplateAutoSendApproval).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: /approved for automatic replies/i })).not.toBeChecked();
  });

  it("confirming approves exactly the text that was shown", async () => {
    const user = userEvent.setup();
    render(<AutoSendApproval template={tpl()} isOwner />);
    await user.click(screen.getByRole("switch", { name: /approved for automatic replies/i }));
    await user.click(screen.getByTestId("approval-confirm"));

    await waitFor(() =>
      expect(setTemplateAutoSendApproval).toHaveBeenCalledWith({
        templateId: "t1",
        approved: true,
        expectedContent: TEXT,
      }),
    );
  });

  it("a failed approval keeps the dialog open so nothing looks approved", async () => {
    setTemplateAutoSendApproval.mockResolvedValue({
      ok: false,
      error: { code: "TPL_APPROVAL_FAILED", message: "text changed" },
    });
    const user = userEvent.setup();
    render(<AutoSendApproval template={tpl()} isOwner />);
    await user.click(screen.getByRole("switch", { name: /approved for automatic replies/i }));
    await user.click(screen.getByTestId("approval-confirm"));

    await waitFor(() => expect(setTemplateAutoSendApproval).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("turning an approved template off revokes it without needing the text", async () => {
    const user = userEvent.setup();
    render(<AutoSendApproval template={tpl({ approved_for_auto_send: true })} isOwner />);
    const toggle = screen.getByRole("switch", { name: /approved for automatic replies/i });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(() =>
      expect(setTemplateAutoSendApproval).toHaveBeenCalledWith({
        templateId: "t1",
        approved: false,
        expectedContent: null,
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("non-owners get no control, only a read-only badge on approved templates", () => {
    const { rerender } = render(<AutoSendApproval template={tpl()} isOwner={false} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText(/approved for automatic replies/i)).not.toBeInTheDocument();

    rerender(<AutoSendApproval template={tpl({ approved_for_auto_send: true })} isOwner={false} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText("Approved for automatic replies")).toBeVisible();
  });
});
