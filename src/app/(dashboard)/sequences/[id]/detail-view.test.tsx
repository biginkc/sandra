import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ cancelEnrollment: vi.fn(), pauseEnrollmentAction: vi.fn(), changeDripAction: vi.fn() }));
vi.mock("../actions", () => actions);
vi.mock("./detail-actions", () => ({ copySequenceSteps: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/sequences/start-drip-picker", () => ({ StartDripPicker: () => null }));
import { sampleDetail } from "@/app/brand/drips/_sample-detail";
import { sampleSequences } from "@/app/brand/drips/_sample";
import { DripDetailView } from "./detail-view";

beforeEach(() => {
  actions.cancelEnrollment.mockReset().mockResolvedValue({ ok: true, data: null });
});

it("stops only the checked lead, leaving unselected and historical rows untouched", async () => {
  const user = userEvent.setup();
  render(<DripDetailView detail={sampleDetail} sources={[]} isAdmin />);
  await user.click(screen.getByRole("checkbox", { name: "Select Marisol Vega" }));
  await user.click(screen.getByRole("button", { name: "Stop drip" }));
  expect(actions.cancelEnrollment).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Stop selected" }));
  await waitFor(() => expect(actions.cancelEnrollment).toHaveBeenCalledTimes(1));
  expect(actions.cancelEnrollment).toHaveBeenCalledWith("enrollment-0");
});

it("keeps the step position visible when using the arrows", async () => {
  const user = userEvent.setup();
  render(<DripDetailView detail={sampleDetail} sources={[]} isAdmin />);
  expect(screen.getByText("6 steps · showing 1–4 of 6")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Next steps" }));
  expect(screen.getByText("6 steps · showing 2–5 of 6")).toBeVisible();
});

it("uses singular labels and identifies sampled filter counts", () => {
  const detail = { ...sampleDetail, sequence: { ...sampleDetail.sequence, steps: [sampleDetail.sequence.steps[0]] }, peopleCount: 201, people: [sampleDetail.people[0]] };
  render(<DripDetailView detail={detail} sources={[]} isAdmin />);
  expect(screen.getByText(/1 step · 201 people enrolled/)).toBeVisible();
  expect(screen.getByText("1 step · showing 1–1 of 1")).toBeVisible();
  expect(screen.getByText(/counts from latest 200/i)).toBeVisible();
});

it("uses a singular person label for one enrollment", () => {
  render(<DripDetailView detail={{ ...sampleDetail, peopleCount: 1, people: [sampleDetail.people[0]] }} sources={[]} isAdmin />);
  expect(screen.getByText(/1 person enrolled/)).toBeVisible();
});

it("offers only unarchived drips with steps as copy sources", async () => {
  const user = userEvent.setup();
  const empty = { ...sampleDetail, sequence: { ...sampleDetail.sequence, steps: [] } };
  const live = { ...sampleSequences[0], id: "live-source", name: "Live source", step_count: 2 };
  const archived = { ...live, id: "archived-source", name: "Archived source", archived_at: "2026-09-01T00:00:00Z" };
  render(<DripDetailView detail={empty} sources={[live, archived]} isAdmin />);
  await user.click(screen.getByRole("button", { name: "Copy steps from another drip" }));
  expect(screen.getByRole("button", { name: /Live source/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Archived source/ })).not.toBeInTheDocument();
});

it("opens the selected property's conversation and omits the link without one", () => {
  const detail = { ...sampleDetail, peopleCount: 3, people: [
    { ...sampleDetail.people[0], propertyId: "property-a", threadId: "conversation-a" },
    { ...sampleDetail.people[1], propertyId: "property-b", threadId: "conversation-b" },
    { ...sampleDetail.people[2], propertyId: "property-c", threadId: null },
  ] };
  render(<DripDetailView detail={detail} sources={[]} isAdmin />);
  expect(screen.getAllByRole("link", { name: "Open thread" }).map((link) => link.getAttribute("href"))).toEqual([
    "/messages?thread=conversation-a", "/messages?thread=conversation-b",
  ]);
});
