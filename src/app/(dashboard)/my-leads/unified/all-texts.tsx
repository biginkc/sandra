"use client";

import { MyLeadSmsStrip } from "../_components/sms-strip";
import type { MyLeadDetailPanelProps } from "../_components/types";
import { RepSmsComposer } from "../rep-sms-composer";
import type { WorkFacts } from "./contract";

/**
 * "Show all texts": the full text history (the existing strip, history only) with the existing composer
 * beneath it. The composer carries the reply-to stamp: the newest inbound the classifier knows about
 * (facts.latestInbound.messageId), captured by the composer when the rep opens it. This is a composition of
 * existing components, not a new surface; the container supplies the detail state it already loads.
 */
export type AllTextsProps = {
  facts: Pick<WorkFacts, "propertyId" | "latestInbound">;
  /** The lead's detail state (messages group) from the container's loadMyLeadDetail. */
  state: MyLeadDetailPanelProps["state"];
  onRetry: () => void;
  onLoadDetailPage?: MyLeadDetailPanelProps["onLoadDetailPage"];
  /** The exact saved phone of an open Messages thread, when the container knows it. */
  replyToPhone?: string | null;
  /** After a send: reload the thread and refresh the row. */
  onSent?: (messageId?: string) => void;
};

export function AllTexts({ facts, state, onRetry, onLoadDetailPage, replyToPhone = null, onSent }: AllTextsProps) {
  return (
    <div data-testid={`all-texts-${facts.propertyId}`} className="min-w-0 space-y-3">
      <MyLeadSmsStrip state={state} onRetry={onRetry} onLoadDetailPage={onLoadDetailPage} />
      <div className="flex flex-wrap items-start gap-2">
        <RepSmsComposer
          propertyId={facts.propertyId}
          placement="action"
          replyToPhone={replyToPhone}
          inboundMessageId={facts.latestInbound?.messageId ?? null}
          onSent={(messageId) => {
            onRetry();
            onSent?.(messageId);
          }}
        />
      </div>
    </div>
  );
}
