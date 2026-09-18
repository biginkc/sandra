/** Client/server-neutral DTOs for the authenticated Inbox detail read.
 *
 * The SQL read function owns these fields. The browser may render them, but it
 * never derives property/contact identity or safety state from the transcript,
 * summary labels, or a second client-side query.
 */
export type InboxDispositionReview = {
  id: string;
  status: "pending";
  disposition: string;
  reason: string;
  sourceInboundMessageId: string;
  sourceMessageBody: string | null;
  createdAt: string;
};

export type InboxDetailActionFields = {
  propertyId: string | null;
  contactId: string | null;
  contactName: string | null;
  propertyAddress: string | null;
  propertyStatus: string | null;
  outreachDispo: string | null;
  assigneeId: string | null;
  threadCustomerPhone: string | null;
  threadBusinessPhone: string | null;
  contactDoNotContact: boolean;
  contactSmsOptedOut: boolean;
  phoneSuppressed: boolean | null;
  smsSafetyReadFailed: boolean;
  isDncLocked: boolean;
  aiDispositionReview: InboxDispositionReview | null;
  aiResponderStatus: string | null;
  aiResponderReason: string | null;
  aiResponderStatusAt: string | null;
  aiLastDeliveryStatus: string | null;
  aiLastDeliveryError: string | null;
};

