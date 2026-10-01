import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

const listDripChoices = vi.hoisted(() => vi.fn());
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices }));

import { StartDripPicker } from "./start-drip-picker";

it("shows the first text preview and enrollment reason", async () => {
  listDripChoices.mockResolvedValue({ ok: true, data: [{ id: "s1", name: "Seller follow-up", textCount: 3, days: 7, firstSend: "Monday, Sep 28, 8:00 AM CDT" }] });
  const user = userEvent.setup();
  const onChoose = vi.fn().mockResolvedValue({ status: "failed", reason: "Lead only has a landline." });
  render(<StartDripPicker onChoose={onChoose} />);
  await user.click(screen.getByRole("button", { name: "Start follow-up drip" }));
  expect(await screen.findByText(/First text: Monday, Sep 28/)).toBeInTheDocument();
  expect(screen.getByText("3 texts · over 7 days")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Seller follow-up/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved. Not enrolled: Lead only has a landline."));
  expect(onChoose).toHaveBeenCalledWith("s1");
});

it("leaves enrollment to the follow-up owner", async () => {
  listDripChoices.mockResolvedValue({ ok: true, data: [] });
  const user = userEvent.setup();
  const onLeave = vi.fn().mockResolvedValue(undefined);
  render(<StartDripPicker onChoose={vi.fn()} onLeave={onLeave} />);
  await user.click(screen.getByRole("button", { name: "Start follow-up drip" }));
  await user.click(await screen.findByRole("button", { name: "Leave it to the follow-up owner" }));
  expect(onLeave).toHaveBeenCalledOnce();
});

it("omits the first-text line when a drip has no SMS step", async () => {
  listDripChoices.mockResolvedValue({ ok: true, data: [{ id: "status-only", name: "Status only", textCount: 0, days: 1, firstSend: null }] });
  const user = userEvent.setup();
  render(<StartDripPicker onChoose={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Start follow-up drip" }));
  expect(await screen.findByRole("button", { name: /Status only/ })).toBeInTheDocument();
  expect(screen.queryByText(/First text:/)).not.toBeInTheDocument();
});

it("selectionOnly selects without enrolling or reporting an enrollment result", async () => {
  const onChoose = vi.fn().mockResolvedValue({ status: "enrolled", reason: "Enrolled" });
  const onResult = vi.fn();
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(<StartDripPicker inline selectionOnly previewChoices={[{ id: "s1", name: "Seller follow-up", textCount: 1, days: 1, firstSend: null }]} onChoose={onChoose} onResult={onResult} onSelect={onSelect} />);
  await user.click(await screen.findByRole("button", { name: /Seller follow-up/ }));
  expect(onSelect).toHaveBeenCalledWith("s1");
  expect(onChoose).not.toHaveBeenCalled();
  expect(onResult).not.toHaveBeenCalled();
});

it("filters drips by name and scrolls the popup list", async () => {
  listDripChoices.mockResolvedValue({ ok: true, data: [
    { id: "a", name: "A — Confirmed owner", textCount: 11, days: 211, firstSend: null },
    { id: "c", name: "C — Not interested", textCount: 3, days: 366, firstSend: null },
  ] });
  const user = userEvent.setup();
  render(<StartDripPicker onChoose={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Start follow-up drip" }));
  await screen.findByRole("button", { name: /Confirmed owner/ });
  expect(screen.getByTestId("drip-choice-list")).toHaveClass("overflow-y-auto");
  await user.type(screen.getByRole("searchbox", { name: "Search drips" }), "not int");
  expect(screen.getByRole("button", { name: /Not interested/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Confirmed owner/ })).not.toBeInTheDocument();
  await user.clear(screen.getByRole("searchbox", { name: "Search drips" }));
  await user.type(screen.getByRole("searchbox", { name: "Search drips" }), "zzz");
  expect(screen.getByText(/No drips match/)).toBeInTheDocument();
});

it("opens upward when the trigger sits near the bottom of the screen", async () => {
  listDripChoices.mockResolvedValue({ ok: true, data: [{ id: "a", name: "A — Confirmed owner", textCount: 11, days: 211, firstSend: null }] });
  const user = userEvent.setup();
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: window.innerHeight - 40, bottom: window.innerHeight - 4 } as DOMRect);
  render(<StartDripPicker onChoose={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Start follow-up drip" }));
  expect(screen.getByRole("dialog", { name: "Start follow-up drip" })).toHaveClass("bottom-full");
  rect.mockRestore();
});
