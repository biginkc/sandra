import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InboxUnknownSenderActions } from "./unknown-sender-actions";

const mocks = vi.hoisted(() => ({
  dismiss: vi.fn(async () => ({ ok: true, data: { updated: 2 } })),
  restore: vi.fn(async () => ({ ok: true, data: { updated: 2 } })),
}));
vi.mock("@/app/(dashboard)/messages/actions", () => ({
  dismissUnknownSenderAction: mocks.dismiss,
  restoreDismissedSenderAction: mocks.restore,
}));
vi.mock("@/app/(dashboard)/messages/match-sender-dialog", () => ({ MatchSenderDialog: () => null }));
vi.mock("@/app/(dashboard)/messages/merge-property-dialog", () => ({ MergePropertyDialog: () => null }));
vi.mock("@/app/(dashboard)/messages/create-contact-dialog", () => ({ CreateContactDialog: () => null }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("offers existing merge/create/dismiss triage in the unknown detail pane", async () => {
  vi.stubGlobal("confirm", vi.fn(() => true));
  const onChanged = vi.fn();
  render(<InboxUnknownSenderActions fromAddress="+15555550100" latestBody="Hello" dismissed={false} onChanged={onChanged} />);
  expect(screen.getByRole("button", { name: "Merge with existing contact" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Merge with existing property" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Create new lead" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss sender" }));
  await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith("+15555550100"));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it("offers restore for a dismissed sender without exposing active triage controls", async () => {
  const onChanged = vi.fn();
  render(<InboxUnknownSenderActions fromAddress="+15555550101" latestBody="Hello" dismissed onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "Restore sender" }));
  await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith("+15555550101"));
  expect(screen.queryByRole("button", { name: "Dismiss sender" })).not.toBeInTheDocument();
});
