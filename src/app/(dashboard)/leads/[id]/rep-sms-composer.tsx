"use client"

import { useRouter } from "next/navigation"

import { RepSmsComposer } from "../../my-leads/rep-sms-composer"

export function LeadRepSmsComposer({
  propertyId,
  replyToPhone,
  inboundMessageId,
  placement = "action",
}: {
  propertyId: string
  replyToPhone?: string | null
  inboundMessageId?: string | null
  placement?: "inline" | "action"
}) {
  const router = useRouter()
  return (
    <RepSmsComposer
      propertyId={propertyId}
      replyToPhone={replyToPhone}
      inboundMessageId={inboundMessageId}
      placement={placement}
      onSent={() => router.refresh()}
    />
  )
}
