import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InboxKnownConversationActions, type KnownConversationActionContext } from "./known-conversation-actions";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => ({ ok: true, status: "confirmed" as const })),
  promote: vi.fn(async () => ({ ok: true, alreadyQualified: false })),
  dispo: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/app/(dashboard)/messages/dispo-actions", () => ({
  confirmAiDispositionReview: mocks.confirm,
  moveMessageThreadToLead: mocks.promote,
  setOutreachDispo: mocks.dispo,
}));
vi.mock("@/app/(dashboard)/messages/assign-dropdown", () => ({
  AssignDropdown: () => <button type="button">Change assignee</button>,
}));
vi.mock("@/components/appointments/book-appointment-popover", () => ({
  BookAppointmentPopover: () => <button type="button">Book appointment</button>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const context: KnownConversationActionContext = {
  conversationId: "00000000-0000-4000-8000-000000000001",
  propertyId: "00000000-0000-4000-8000-000000000002",
  contactId: "00000000-0000-4000-8000-000000000003",
  contactName: "Ada",
  propertyAddress: "123 Oak",
  propertyStatus: "prospect",
  outreachDispo: null,
  assigneeId: null,
  assigneeLabel: null,
  currentPhone: "+15555550100",
  isDncLocked: false,
  contactDoNotContact: false,
  aiDispositionReview: { id: "00000000-0000-4000-8000-000000000004", disposition: "nurture", reason: "Asked for a later call", sourceMessageBody: "Next week works" },
  aiResponderStatus: "waiting_for_review",
  aiResponderReason: "Human review requested",
  aiLastDeliveryStatus: "delivered",
  aiLastDeliveryError: null,
};

afterEach(() => { vi.clearAllMocks(); });

it("keeps promotion, individual tools, Follow up and AI review in the conversation pane", async () => {
  const onChanged = vi.fn();
  render(<InboxKnownConversationActions context={context} currentUserId="00000000-0000-4000-8000-000000000005" onChanged={onChanged} />);
  expect(screen.getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:+15555550100");
  expect(screen.getByRole("link", { name: "New message" })).toHaveAttribute("href", "/leads?compose=1");
  expect(screen.getByRole("button", { name: "Book appointment" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Move to Lead" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Follow up" })).toBeVisible();
  expect(screen.getByText("Sandra suggested: Follow up")).toBeVisible();
  expect(screen.getByRole("region", { name: "Sandra AI status" })).toHaveTextContent("Status: waiting_for_review");

  fireEvent.click(screen.getByRole("button", { name: "Confirm Sandra disposition" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(context.aiDispositionReview!.id));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it("uses existing authorized individual mutations for promotion and outcome correction", async () => {
  const onChanged = vi.fn();
  render(<InboxKnownConversationActions context={{ ...context, aiDispositionReview: null }} currentUserId={context.conversationId} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "Move to Lead" }));
  await waitFor(() => expect(mocks.promote).toHaveBeenCalledWith(context.propertyId));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
  await waitFor(() => expect(mocks.dispo).toHaveBeenCalledWith(context.propertyId, "nurture"));
});
