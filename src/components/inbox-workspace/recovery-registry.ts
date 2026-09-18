import type { InboxQueryIdentity } from "@/lib/inbox/workspace-query";

export type RecoveryKind = "metadata" | "reply";
export type RecoveryEntry = {
  kind?: RecoveryKind;
  preparationId: string;
  idempotencyKey: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ENTRIES = 50;

/**
 * Keep only opaque acceptance identities in session storage. The storage key
 * is bound to the complete authenticated workspace identity; the value never
 * contains targets, labels, message bodies, or organization data beyond the
 * binding already represented by the key.
 *
 * A single object remains the on-disk representation for one entry so older
 * sessions and the existing recovery tests continue to read cleanly. Adding
 * a second entry upgrades the value to an array, which prevents completion of
 * one accepted operation from deleting another uncertain operation.
 */
export function recoveryStorageKey(prefix: string, identity: InboxQueryIdentity): string {
  return `${prefix}:${JSON.stringify([identity.orgId, identity.userId, identity.sessionId, identity.accessEpoch])}`;
}

function valid(value: unknown): value is RecoveryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.kind === undefined || row.kind === "metadata" || row.kind === "reply")
    && typeof row.preparationId === "string" && UUID.test(row.preparationId)
    && typeof row.idempotencyKey === "string" && UUID.test(row.idempotencyKey);
}

export function parseRecoveryEntries(raw: string | null): RecoveryEntry[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > 500 || entries.some(entry => !valid(entry))) throw new Error("Invalid recovery record");
  const unique = new Map<string, RecoveryEntry>();
  for (const entry of entries as RecoveryEntry[]) unique.set(`${entry.kind ?? "metadata"}:${entry.preparationId}:${entry.idempotencyKey}`, entry);
  return [...unique.values()];
}

export function readRecoveryEntries(key: string): RecoveryEntry[] {
  return parseRecoveryEntries(sessionStorage.getItem(key));
}

export function writeRecoveryEntries(key: string, entries: readonly RecoveryEntry[]): void {
  if (entries.length > MAX_ENTRIES) throw new Error("Too many unresolved Inbox operations");
  if (!entries.length) {
    sessionStorage.removeItem(key);
    return;
  }
  sessionStorage.setItem(key, JSON.stringify(entries.length === 1 ? entries[0] : entries));
}

export function rememberRecoveryEntry(key: string, entry: RecoveryEntry): void {
  const entries = readRecoveryEntries(key);
  if (entries.some(current => (current.kind ?? "metadata") === (entry.kind ?? "metadata") && current.preparationId === entry.preparationId && current.idempotencyKey === entry.idempotencyKey)) return;
  writeRecoveryEntries(key, [...entries, entry]);
}

export function forgetRecoveryEntry(key: string, entry: Pick<RecoveryEntry, "preparationId" | "idempotencyKey">): void {
  const entries = readRecoveryEntries(key);
  writeRecoveryEntries(key, entries.filter(current => current.preparationId !== entry.preparationId || current.idempotencyKey !== entry.idempotencyKey));
}
