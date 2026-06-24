export function getOutboundSenderName(): string {
  return process.env.OUTBOUND_SENDER_NAME?.trim() || "Mel";
}
