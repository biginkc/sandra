import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createInboxReadRepository } from "@/lib/inbox/read-api";
import { InboxKnownConversationActions, knownConversationActionContext } from "./known-conversation-actions";

const orgId = "11111111-1111-1111-1111-111111111111";
const conversationId = "22222222-2222-2222-8222-222222222222";
const contactId = "33333333-3333-4333-8333-333333333333";
const propertyId = "44444444-4444-4444-8444-444444444444";
const reviewId = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";

vi.mock("@/app/(dashboard)/messages/dispo-actions", () => ({
  confirmAiDispositionReview: vi.fn(),
  moveMessageThreadToLead: vi.fn(),
  setOutreachDispo: vi.fn(),
}));
vi.mock("@/app/(dashboard)/messages/assign-dropdown", () => ({ AssignDropdown: () => <button type="button">Change assignee</button> }));
vi.mock("@/components/appointments/book-appointment-popover", () => ({ BookAppointmentPopover: () => <button type="button">Book appointment</button> }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("renders individual controls from the decoded SQL detail DTO", async () => {
  const wire = {
    requester_id: contactId,
    org_id: orgId,
    conversation_id: conversationId,
    head_revision: "12",
    read_boundary: messageId,
    boundary_expires_at: "2030-01-01T00:00:00Z",
    capture_generation: propertyId,
    next_cursor: null,
    property_id: propertyId,
    contact_id: contactId,
    contact_name: "Ada Homeowner",
    property_address: "123 Oak St, St Louis, MO",
    property_status: "prospect",
    outreach_dispo: null,
    assignee_id: null,
    thread_customer_phone: "+15555550100",
    thread_business_phone: "+15555550199",
    contact_do_not_contact: false,
    contact_sms_opted_out: false,
    phone_suppressed: false,
    sms_safety_read_failed: false,
    is_dnc_locked: false,
    ai_disposition_review_id: reviewId,
    ai_disposition_review_status: "pending",
    ai_disposition_review_disposition: "nurture",
    ai_disposition_review_reason: "Positive buying signal",
    ai_disposition_review_source_inbound_message_id: messageId,
    ai_disposition_review_source_message_body: "Interested in a showing",
    ai_disposition_review_created_at: "2026-09-13T12:00:00Z",
    ai_responder_status: "escalated",
    ai_responder_reason: "Needs human review",
    ai_responder_status_at: "2026-09-13T12:01:00Z",
    ai_last_delivery_status: "delivered",
    ai_last_delivery_error: null,
    history: [{ id: messageId, created_at_raw: "2026-09-13 12:00:00.123456+00", body: "Interested in a showing", direction: "inbound", read_at_raw: null, inbound_revision: "12" }],
  };
  const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: wire, error: null }) }));
  const decoded = await createInboxReadRepository({ rpc } as never).detail(orgId, conversationId, new AbortController().signal);
  render(<InboxKnownConversationActions context={knownConversationActionContext(decoded, "Ada Homeowner")} currentUserId={contactId} onChanged={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Move to Lead" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:+15555550100");
  expect(screen.getByRole("button", { name: "Book appointment" })).toBeVisible();
  expect(screen.getByText("Sandra suggested: Follow up")).toBeVisible();
  expect(screen.getByRole("region", { name: "Sandra AI status" })).toHaveTextContent("Status: escalated");
});

