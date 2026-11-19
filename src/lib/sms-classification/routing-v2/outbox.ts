/**
 * Single-attempt delivery for the transactional v2 outbox. The database owns claim and
 * final authorization (fresh flags, latest inbound, suppression and takeover checks).
 * Never retry an authorized intent blindly: a timeout may mean the provider accepted it.
 * The normal SMS/alert adapter must retain its own provider fence and idempotency key.
 */
export type V2OutboxIntent = {
  id: string;
  orgId: string;
  propertyId: string;
  inboundMessageId: string;
  kind: "reply" | "alert";
  payload: Record<string, unknown>;
};
export type V2DeliveryResult =
  | { kind: "accepted"; receiptId: string }
  | { kind: "not_sent"; reason: string }
  | { kind: "unknown"; reason: string };
export type V2PreparedDelivery =
  | { kind: "ready"; send: (idempotencyKey: string) => Promise<V2DeliveryResult> }
  | { kind: "wait"; reason: string }
  | { kind: "refused"; reason: string };
export type V2OutboxDeps = {
  /** Pure preparation / reads only. Quiet hours must return wait before taking a claim. */
  prepare: (intent: V2OutboxIntent) => Promise<V2PreparedDelivery>;
  claim: (id: string) => Promise<string>;
  authorize: (id: string) => Promise<string>;
  /** Persist acceptance with receipt before reporting sent. */
  accepted: (intent: V2OutboxIntent, receiptId: string) => Promise<void>;
  /** Leave an unknown authorized intent non-retryable; put it in reconciliation/human queue. */
  reconcile: (intent: V2OutboxIntent, reason: string) => Promise<void>;
  notSent: (intent: V2OutboxIntent, reason: string) => Promise<void>;
};
export type V2OutboxResult =
  | { kind: "sent"; receiptId: string }
  | { kind: "waiting"; reason: string }
  | { kind: "skipped"; reason: string }
  | { kind: "reconcile"; reason: string };

export async function deliverV2Outbox(intent: V2OutboxIntent, deps: V2OutboxDeps): Promise<V2OutboxResult> {
  const prepared = await deps.prepare(intent);
  if (prepared.kind === "wait") return { kind: "waiting", reason: prepared.reason };
  if (prepared.kind === "refused") {
    await deps.notSent(intent, prepared.reason);
    return { kind: "skipped", reason: prepared.reason };
  }
  const claim = await deps.claim(intent.id);
  if (claim !== "ok") return { kind: "skipped", reason: claim };
  let authorized: string;
  try {
    authorized = await deps.authorize(intent.id);
  } catch {
    // Authorization may have committed even if the response was lost. No provider call.
    await deps.reconcile(intent, "authorization_unknown");
    return { kind: "reconcile", reason: "authorization_unknown" };
  }
  if (authorized !== "ok") {
    if (authorized === "already_authorized") {
      await deps.reconcile(intent, "already_authorized");
      return { kind: "reconcile", reason: "already_authorized" };
    }
    return { kind: "skipped", reason: authorized };
  }
  let result: V2DeliveryResult;
  try {
    // The outbox id itself (a uuid) is the provider idempotency key (messages.idempotency_key).
    result = await prepared.send(intent.id);
  } catch {
    result = { kind: "unknown", reason: "provider_outcome_unknown" };
  }
  if (result.kind === "unknown") {
    await deps.reconcile(intent, result.reason);
    return { kind: "reconcile", reason: result.reason };
  }
  if (result.kind === "not_sent") {
    await deps.notSent(intent, result.reason);
    return { kind: "skipped", reason: result.reason };
  }
  if (!result.receiptId.trim()) {
    await deps.reconcile(intent, "missing_provider_receipt");
    return { kind: "reconcile", reason: "missing_provider_receipt" };
  }
  try {
    await deps.accepted(intent, result.receiptId);
  } catch {
    await deps.reconcile(intent, "acceptance_record_failed");
    return { kind: "reconcile", reason: "acceptance_record_failed" };
  }
  return { kind: "sent", receiptId: result.receiptId };
}
