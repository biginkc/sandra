import "server-only";
import { inboxDatabaseError, InboxHttpError } from "./http-error";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;

/** The probe is deliberately separate from workset creation.  It reads one
 * authenticated scope and never replaces the scope or mints a cursor. */
export type InboxWorksetUpdate = {
  scopeId: string;
  orgId: string;
  requesterId: string;
  sessionId: string;
  accessEpoch: string;
  generation: string;
  hasUpdates: boolean;
  refreshRequired: boolean;
};

type RpcResult = { data: unknown; error: unknown };
export type InboxWorksetUpdateRpcClient = {
  rpc: (
    name: "inbox_probe_workset_updates",
    args: { scope_id: string },
  ) => { abortSignal: (signal: AbortSignal) => Promise<RpcResult> };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InboxHttpError(503);
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new InboxHttpError(503);
  return value;
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new InboxHttpError(503);
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InboxHttpError(503);
  return value;
}

/** Decode the complete server-owned response.  The client receives identity
 * evidence so a delayed poll cannot be mistaken for another scope or tenant. */
export function decodeInboxWorksetUpdate(value: unknown): InboxWorksetUpdate {
  const row = object(value);
  const expected = [
    "scope_id", "org_id", "requester_id", "session_id", "access_epoch",
    "generation", "has_updates", "refresh_required",
  ];
  if (Object.keys(row).length !== expected.length || expected.some((key) => !Object.hasOwn(row, key))) {
    throw new InboxHttpError(503);
  }
  const result: InboxWorksetUpdate = {
    scopeId: uuid(row.scope_id),
    orgId: uuid(row.org_id),
    requesterId: uuid(row.requester_id),
    sessionId: uuid(row.session_id),
    accessEpoch: decimal(row.access_epoch),
    generation: decimal(row.generation),
    hasUpdates: bool(row.has_updates),
    refreshRequired: bool(row.refresh_required),
  };
  // An origin that cannot be trusted never becomes an arrival signal.  The
  // SQL probe returns this pair for pre-upgrade/missing-origin scopes and the
  // decoder enforces the same invariant before the response crosses HTTP.
  if (result.refreshRequired && result.hasUpdates) throw new InboxHttpError(503);
  return result;
}

export async function probeInboxWorksetUpdates(
  client: InboxWorksetUpdateRpcClient,
  scopeId: string,
  signal: AbortSignal,
): Promise<InboxWorksetUpdate> {
  if (!UUID.test(scopeId)) throw new InboxHttpError(400);
  signal.throwIfAborted();
  const result = await client.rpc("inbox_probe_workset_updates", { scope_id: scopeId }).abortSignal(signal);
  signal.throwIfAborted();
  if (result.error) throw inboxDatabaseError(result.error);
  const decoded = decodeInboxWorksetUpdate(result.data);
  if (decoded.scopeId !== scopeId) throw new InboxHttpError(503);
  return decoded;
}
