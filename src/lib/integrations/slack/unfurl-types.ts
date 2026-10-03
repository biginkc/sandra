export const SLACK_PREVIEW_TIMEZONE_FALLBACK = "America/Chicago";

export type SlackPreviewMessage = {
  id: string;
  createdAt: string;
  body: string;
  direction: "inbound" | "outbound";
  deliveryStatus: string;
  attachmentCount: number;
};

export type SlackPreviewAttempt = {
  id: string;
  occurredAt: string;
  outcome: string | null;
};

/**
 * A point-in-time, tenant-scoped preview read model. `messages` is already
 * limited to the latest three eligible SMS facts and is ordered oldest-first.
 * `propertyId` is lower-case after loadPreviewData validates it as a UUID.
 */
export type SlackLeadPreviewSnapshot = {
  propertyId: string;
  leadName: string | null;
  address: string | null;
  ownerName: string | null;
  ownerAssigned: boolean;
  latestAttempt: SlackPreviewAttempt | null;
  messagesDisposition: string | null;
  lastContactAt: string | null;
  timezone: string;
  messages: readonly SlackPreviewMessage[];
};

export type SlackLeadPreview = SlackLeadPreviewSnapshot;
