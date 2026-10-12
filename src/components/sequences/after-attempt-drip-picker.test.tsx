import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ listDripProgress: vi.fn(), changeDripAction: vi.fn(), startDripForLeads: vi.fn() }));
vi.mock("@/lib/sequences/drip-progress", () => ({ listDripProgress: api.listDripProgress }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ ...api, listDripChoices: vi.fn() }));
import { AfterAttemptDripPicker } from "./after-attempt-drip-picker";
const choices = [
  { id: "old", name: "Talking price", textCount: 3, days: 30, firstSend: null },
  { id: "new", name: "Check in every 60 days", textCount: 6, days: 360, firstSend: null },
];
const progress = { propertyId: "p1", enrollmentId: "e1", sequenceId: "old", sequenceName: "Talking price", enrollmentStatus: "active" };
beforeEach(() => { vi.resetAllMocks(); api.listDripProgress.mockResolvedValue([progress]); });
function setup() {
  const onEnrolled = vi.fn(); const onDripChanged = vi.fn();
  render(<AfterAttemptDripPicker propertyId="p1" previewChoices={choices} onEnrolled={onEnrolled} onDripChanged={onDripChanged} />);
  return { user: userEvent.setup(), onEnrolled, onDripChanged };
}
it.each(["active", "paused"])("explicitly replaces a %s enrollment without starting directly", async status => {
  api.listDripProgress.mockResolvedValue([{ ...progress, enrollmentStatus: status }]);
  api.changeDripAction.mockResolvedValue({ ok: true, data: { status: "enrolled", reason: "Enrolled" } });
  const { user, onEnrolled, onDripChanged } = setup();
  expect(await screen.findByText(/Current drip:/)).toHaveTextContent(`Talking price (${status})`);
  await user.click(screen.getByRole("button", { name: /Check in every 60 days/ }));
  expect(api.changeDripAction).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Switch to selected drip" }));
  expect(api.changeDripAction).toHaveBeenCalledExactlyOnceWith("e1", "new");
  expect(api.startDripForLeads).not.toHaveBeenCalled();
  expect(onEnrolled).toHaveBeenCalledOnce(); expect(onDripChanged).toHaveBeenCalledOnce();
});
it("cannot restart the current drip", async () => {
  const { user } = setup(); await screen.findByText(/Current drip:/);
  await user.click(screen.getByRole("button", { name: /Talking price.*texts/ }));
  expect(screen.getByRole("button", { name: "Switch to selected drip" })).toBeDisabled();
  expect(api.changeDripAction).not.toHaveBeenCalled();
});
it("reloads after a partially failed switch and focuses its failure before retrying a normal start", async () => {
  api.changeDripAction.mockResolvedValue({ ok: true, data: { status: "failed", reason: "Previous drip stopped. No consent." } });
  const { user, onEnrolled, onDripChanged } = setup(); await screen.findByText(/Current drip:/);
  api.listDripProgress.mockResolvedValue([]);
  await user.click(screen.getByRole("button", { name: /Check in every 60 days/ }));
  await user.click(screen.getByRole("button", { name: "Switch to selected drip" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Previous drip stopped. No consent.");
  expect(screen.getByRole("alert")).toHaveFocus();
  expect(screen.getByText("Not currently in an active or paused drip.")).toBeVisible();
  expect(onEnrolled).not.toHaveBeenCalled(); expect(onDripChanged).toHaveBeenCalledOnce();
  api.startDripForLeads.mockResolvedValue({ ok: true, data: { results: [{ status: "enrolled", reason: "Enrolled" }] } });
  await user.click(screen.getByRole("button", { name: /Check in every 60 days/ }));
  expect(api.startDripForLeads).toHaveBeenCalledWith("new", ["p1"]);
});
it("blocks enrollment when progress cannot be loaded and supports retry", async () => {
  api.listDripProgress.mockRejectedValue(new Error("offline"));
  const { user } = setup(); await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: /Check in every 60 days/ })).toBeDisabled();
  api.listDripProgress.mockResolvedValue([]);
  await user.click(screen.getByRole("button", { name: "Retry current drip" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Check in every 60 days/ })).toBeEnabled());
});
it("refreshes and stays open after a thrown switch error", async () => {
  api.changeDripAction.mockRejectedValue(new Error("transport lost"));
  const { user, onEnrolled } = setup(); await screen.findByText(/Current drip:/);
  await user.click(screen.getByRole("button", { name: /Check in every 60 days/ }));
  await user.click(screen.getByRole("button", { name: "Switch to selected drip" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Check the current drip before retrying");
  expect(api.listDripProgress).toHaveBeenCalledTimes(2); expect(onEnrolled).not.toHaveBeenCalled();
});
