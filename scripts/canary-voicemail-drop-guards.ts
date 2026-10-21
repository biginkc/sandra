/**
 * Pure guards for scripts/canary-voicemail-drop.ts (production voicemail-drop
 * canary). Kept side-effect free so they can be unit tested.
 */

/** Jarrad's own cell. The canary refuses every other destination. */
export const CANARY_TARGET_PHONE = "+13107540662";
export const CANARY_MARKER_PREFIX = "PROD-CANARY RVM-DROP";
export const CANARY_CALL_PREFIX = "prod-canary-rvm-";
export const CANARY_CALL_PROVIDER = "prod_canary";

const RUN_ID = /^rvm-[0-9a-z-]{6,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CanaryMode = "create" | "watch" | "after-callback" | "cleanup";

export type CanaryArgs = {
  mode: CanaryMode;
  runId: string;
  script: string | null;
  kick: boolean;
};

export function toE164(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Throws unless the phone normalizes to exactly the canary target. */
export function assertCanaryTargetPhone(raw: string | null | undefined, context = "phone"): string {
  const phone = toE164(raw);
  if (phone !== CANARY_TARGET_PHONE) {
    throw new Error(`Refusing ${context}: only ${CANARY_TARGET_PHONE} may be targeted by this canary`);
  }
  return phone;
}

export function assertRunId(runId: string | null | undefined): string {
  if (!runId || !RUN_ID.test(runId)) throw new Error("run id must look like rvm-<lowercase/digits/dashes>");
  return runId;
}

export function assertUuid(value: string | null | undefined, name: string): string {
  if (!value || !UUID.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

export function newRunId(now = new Date()): string {
  return `rvm-${now.toISOString().replace(/[:.]/g, "-").replace(/z$/i, "").toLowerCase()}`;
}

/** Every name the canary writes, derived from the run id only. */
export function canaryNames(runId: string) {
  assertRunId(runId);
  const marker = `${CANARY_MARKER_PREFIX} ${runId}`;
  return {
    marker,
    contactFirstName: "PROD-CANARY",
    contactLastName: marker,
    propertyAddress: `${marker} — NOT A PROSPECT`,
    sequenceName: `${marker} drip`,
    callAttemptId: `${CANARY_CALL_PREFIX}${runId}`,
  };
}

type Row = Record<string, unknown>;
const str = (row: Row, key: string) => (typeof row[key] === "string" ? (row[key] as string) : "");

/**
 * Canary-only check. Throws unless the row carries the marker for this run.
 * Every write after creation and every cleanup delete goes through this.
 */
export function assertCanaryRow(
  kind: "contact" | "property" | "sequence" | "call_activity" | "enrollment" | "voicemail_drop",
  row: Row | null | undefined,
  runId: string,
  ids: { propertyId?: string; contactId?: string } = {},
): void {
  if (!row) throw new Error(`Refusing ${kind}: row missing`);
  const names = canaryNames(runId);
  const fail = () => {
    throw new Error(`Refusing ${kind} ${str(row, "id") || "?"}: not a canary row for ${runId}`);
  };
  switch (kind) {
    case "contact":
      if (str(row, "last_name") !== names.contactLastName) fail();
      assertCanaryTargetPhone(str(row, "phone_1"), "contact phone_1");
      if (row.phone_2 || row.phone_3) fail();
      return;
    case "property":
      if (str(row, "address") !== names.propertyAddress) fail();
      return;
    case "sequence":
      if (str(row, "name") !== names.sequenceName) fail();
      return;
    case "call_activity":
      if (str(row, "jitter_attempt_id") !== names.callAttemptId || str(row, "provider") !== CANARY_CALL_PROVIDER) fail();
      return;
    case "enrollment":
    case "voicemail_drop":
      if (!ids.propertyId || str(row, "property_id") !== ids.propertyId) fail();
      if (row.contact_id != null && (!ids.contactId || str(row, "contact_id") !== ids.contactId)) fail();
      if (kind === "voicemail_drop") assertCanaryTargetPhone(str(row, "to_phone"), "voicemail drop to_phone");
      return;
  }
}

export function parseCanaryArgs(argv: readonly string[], now = new Date()): CanaryArgs {
  const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
  const value = (name: string) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  const modes = (["watch", "after-callback", "cleanup"] as const).filter((m) => flags.has(`--${m}`));
  if (modes.length > 1) throw new Error("Pick one mode: --watch, --after-callback or --cleanup");
  const mode = (modes[0] ?? "create") as CanaryMode;
  const kick = flags.has("--kick");
  if (mode === "create") {
    const script = value("script");
    if (!script || !script.trim()) {
      throw new Error("--script \"<approved voicemail text>\" is required; the canary has no default wording");
    }
    const runId = value("run-id") ?? newRunId(now);
    return { mode, runId: assertRunId(runId), script, kick };
  }
  if (value("script")) throw new Error("--script is only valid when creating");
  return { mode, runId: assertRunId(value("run-id")), script: null, kick };
}

export const TERMINAL_DROP_STATUSES = new Set(["delivered", "failed", "skipped"]);

/** --watch stops when the drop is terminal and, if delivered, proof is stored. */
export function isWatchDone(drop: { status: string; proof_storage_path: string | null } | null, enrollmentStatus: string | null): boolean {
  if (drop) {
    if (drop.status === "delivered") return Boolean(drop.proof_storage_path);
    return TERMINAL_DROP_STATUSES.has(drop.status);
  }
  // No drop row and the enrollment already moved on (not eligible, paused, etc.)
  return enrollmentStatus !== null && enrollmentStatus !== "active";
}
