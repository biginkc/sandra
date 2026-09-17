"use client"

import { useRouter } from "next/navigation"

import { RepSmsComposer } from "../../my-leads/rep-sms-composer"

export function LeadRepSmsComposer({
  propertyId,
  replyToPhone,
}: {
  propertyId: string
  replyToPhone?: string | null
}) {
  const router = useRouter()
  return (
    <RepSmsComposer
      propertyId={propertyId}
      replyToPhone={replyToPhone}
      onSent={() => router.refresh()}
    />
  )
}
