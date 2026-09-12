import 'server-only';
import { createHash } from 'node:crypto';

export type ActualSellerCallStarted = {
  eventId: string;
  eventVersion: 1;
  orgId: string;
  propertyId: string;
  actorUserId: string;
  assignmentEpisodeId: string | null;
  sandraCallToken: string;
  jitterCallId: string;
  sellerProviderCallId: string;
  occurredAt: string;
  evidence: 'seller_call_create_succeeded';
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = /^[A-Za-z0-9_.:-]{1,200}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Shape validation only. Call ONLY after authenticating the internal producer. */
export function parseActualSellerCallStarted(value: unknown, authenticatedOrgId: string): ActualSellerCallStarted | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.eventVersion !== 1 || event.evidence !== 'seller_call_create_succeeded') return null;
  for (const key of ['eventId', 'orgId', 'propertyId', 'actorUserId', 'sandraCallToken']) {
    if (typeof event[key] !== 'string' || !uuid.test(event[key])) return null;
  }
  if (event.orgId !== authenticatedOrgId) return null;
  if (event.assignmentEpisodeId !== null && (typeof event.assignmentEpisodeId !== 'string' || !uuid.test(event.assignmentEpisodeId))) return null;
  for (const key of ['jitterCallId', 'sellerProviderCallId']) {
    if (typeof event[key] !== 'string' || !identifier.test(event[key])) return null;
  }
  if (typeof event.occurredAt !== 'string' || !instant.test(event.occurredAt) || !Number.isFinite(Date.parse(event.occurredAt))) return null;
  const [year, month, day] = event.occurredAt.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month || calendarDate.getUTCDate() !== day) return null;
  // Construct the permitted DTO rather than forwarding untrusted extra fields.
  return {
    eventId: event.eventId as string, eventVersion: 1, orgId: event.orgId as string,
    propertyId: event.propertyId as string, actorUserId: event.actorUserId as string,
    assignmentEpisodeId: event.assignmentEpisodeId as string | null,
    sandraCallToken: event.sandraCallToken as string, jitterCallId: event.jitterCallId as string,
    sellerProviderCallId: event.sellerProviderCallId as string, occurredAt: new Date(event.occurredAt).toISOString(),
    evidence: 'seller_call_create_succeeded',
  };
}

/** Store the digest only. A call token identifies an attempt; it does not authenticate it. */
export function callTokenDigest(token: string): string {
  if (!uuid.test(token)) throw new Error('Invalid call identity');
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}
