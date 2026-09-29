import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ archiveSequence: vi.fn(), restoreSequence: vi.fn(), updateSequence: vi.fn() }));
vi.mock("./actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/errors/call-action", () => ({ callAction: (promise: Promise<unknown>) => promise }));
import { SequenceRowActions } from "./row-actions";

it("closes new enrollment without calling it a pause", async () => {
  const user = userEvent.setup();
  actions.updateSequence.mockResolvedValue({ ok: true, data: null });
  render(<SequenceRowActions sequenceId="s1" isArchived={false} isActive />);
  await user.click(screen.getByRole("button", { name: "Actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Close to new leads" }));
  await waitFor(() => expect(actions.updateSequence).toHaveBeenCalledWith("s1", { active: false }));
  expect(screen.queryByText(/pause/i)).not.toBeInTheDocument();
});

it("asks before archiving", async () => {
  const user = userEvent.setup();
  actions.archiveSequence.mockResolvedValue({ ok: true, data: null });
  render(<SequenceRowActions sequenceId="s2" isArchived={false} isActive />);
  await user.click(screen.getByRole("button", { name: "Actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(screen.getByRole("dialog", { name: "Archive this drip?" })).toBeVisible();
  expect(actions.archiveSequence).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Archive drip" }));
  await waitFor(() => expect(actions.archiveSequence).toHaveBeenCalledWith("s2"));
});
