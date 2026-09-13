import type { InboxWorksetRequest } from "./sync-gateway";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fields = new Set(["orgId", "filter", "cursor", "limit", "replacesScopeId"]);

/** Validate the transport envelope only. The repository must separately validate canonical
 * filter/cursor semantics and authorize the replacement against durable current session state.
 * In particular, accepting a UUID here never grants access to its scope or organization.
 */
export function parseInboxWorksetRequest(value: unknown): InboxWorksetRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.has(key))) return null;
  if (typeof input.orgId !== "string" || !uuid.test(input.orgId)) return null;
  if (!input.filter || typeof input.filter !== "object" || Array.isArray(input.filter)) return null;
  if (input.cursor !== null && (typeof input.cursor !== "string" || input.cursor.length === 0 || input.cursor.length > 4096)) return null;
  if (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) return null;
  if (Object.hasOwn(input, "replacesScopeId") && (typeof input.replacesScopeId !== "string" || !uuid.test(input.replacesScopeId))) return null;
  return {
    orgId: input.orgId,
    filter: input.filter as Record<string, unknown>,
    cursor: input.cursor as string | null,
    limit: input.limit,
    ...(typeof input.replacesScopeId === "string" ? { replacesScopeId: input.replacesScopeId } : {}),
  };
}
