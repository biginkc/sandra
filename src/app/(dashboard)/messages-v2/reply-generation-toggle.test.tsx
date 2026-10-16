import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReplyGenerationToggle } from "./reply-generation-toggle";

describe("ReplyGenerationToggle", () => {
  it("shows a read-only badge (no button) for non-owners", () => {
    render(<ReplyGenerationToggle configId="cfg" replyGeneration="off" isOwner={false} action={vi.fn()} />);
    expect(screen.getByTestId("reply-generation-badge")).toHaveTextContent("AI drafts: off");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when the org has no active config", () => {
    const { container } = render(<ReplyGenerationToggle configId={null} replyGeneration={null} isOwner action={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("owner: confirm dialog first, nothing is saved until confirmed", async () => {
    const action = vi.fn(async () => ({ ok: true as const, data: { configId: "cfg", replyGeneration: "off" as const } }));
    render(<ReplyGenerationToggle configId="cfg" replyGeneration="llm" isOwner action={action} />);
    await userEvent.click(screen.getByTestId("reply-generation-toggle"));
    expect(screen.getByText("Turn AI drafts off?")).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByTestId("reply-generation-toggle")).toHaveTextContent("AI drafts: on");
  });

  it("owner: confirming turns it off and the label updates", async () => {
    const action = vi.fn(async () => ({ ok: true as const, data: { configId: "cfg", replyGeneration: "off" as const } }));
    render(<ReplyGenerationToggle configId="cfg" replyGeneration="llm" isOwner action={action} />);
    await userEvent.click(screen.getByTestId("reply-generation-toggle"));
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(action).toHaveBeenCalledWith({ configId: "cfg", mode: "off" });
    await waitFor(() => expect(screen.getByTestId("reply-generation-toggle")).toHaveTextContent("AI drafts: off"));
  });

  it("owner: a refusal keeps the old value and shows the reason", async () => {
    const action = vi.fn(async () => ({ ok: false as const, error: { code: "FORBIDDEN", message: "Only an owner can change AI drafts." } }));
    render(<ReplyGenerationToggle configId="cfg" replyGeneration="llm" isOwner action={action} />);
    await userEvent.click(screen.getByTestId("reply-generation-toggle"));
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only an owner can change AI drafts.");
    expect(screen.getByTestId("reply-generation-toggle")).toHaveTextContent("AI drafts: on");
  });

  it("turning back on from off uses the llm mode", async () => {
    const action = vi.fn(async () => ({ ok: true as const, data: { configId: "cfg", replyGeneration: "llm" as const } }));
    render(<ReplyGenerationToggle configId="cfg" replyGeneration="off" isOwner action={action} />);
    await userEvent.click(screen.getByTestId("reply-generation-toggle"));
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(action).toHaveBeenCalledWith({ configId: "cfg", mode: "llm" });
  });
});
