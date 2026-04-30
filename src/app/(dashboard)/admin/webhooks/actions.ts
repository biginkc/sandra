"use server";

import { createHash, randomBytes } from "node:crypto";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_SOURCES, type LeadSource } from "@/lib/leads/create";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { buildWebhookUrl, type WebhookConsumerType } from "./url";

/**
 * Server actions for the `/admin/webhooks` admin page. Every action is
 * gated by `isAdminEmail` — the layout guards the page route, but
 * server functions are reachable via direct POST requests, so the
 * admin check has to live inside each action too.
 *
 * The plaintext secret is generated here and returned exactly ONCE —
 * at creation or rotation. After that, only the SHA-256 hash lives in
 * the DB. There is no "show plaintext" path; lose it, you rotate.
 */

const SECRET_BYTE_LENGTH = 24; // 24 raw bytes → 48 hex chars
const NAME_MAX_LENGTH = 80;
const NOTES_MAX_LENGTH = 1_000;

function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function newPlaintextSecret(): string {
  return randomBytes(SECRET_BYTE_LENGTH).toString("hex");
}

/**
 * Verify the caller is an admin and return their auth user id (used
 * for `created_by`). Returns `null` and a Result error when the
 * caller fails the check.
 */
async function requireAdmin(): Promise<
  | { ok: true; userId: string | null }
  | { ok: false; error: { code: string; message: string } }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdminEmail(user.email)) {
    return {
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "Only admins can manage webhook consumers.",
      },
    };
  }
  return { ok: true, userId: user.id };
}

export type CreateWebhookConsumerInput = {
  name: string;
  consumer_type: WebhookConsumerType;
  /** Required when `consumer_type === 'lead'`. Must be NULL/omitted when 'provider'. */
  default_source?: LeadSource | null;
  notes?: string | null;
};

export type CreateWebhookConsumerData = {
  id: string;
  plaintextSecret: string;
  url: string;
};

/**
 * Create a new webhook consumer. Generates a fresh plaintext secret,
 * stores only its hash, and returns the plaintext to the caller exactly
 * once. The caller is responsible for displaying it to the integrator
 * before navigating away — there's no recovery path.
 */
export async function createWebhookConsumer(
  input: CreateWebhookConsumerInput,
): Promise<Result<CreateWebhookConsumerData>> {
  const name = input.name.trim();
  if (!name) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Name is required." },
    };
  }
  if (name.length > NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Name is ${name.length} characters — cap is ${NAME_MAX_LENGTH}.`,
      },
    };
  }

  if (input.consumer_type !== "lead" && input.consumer_type !== "provider") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "consumer_type must be 'lead' or 'provider'.",
      },
    };
  }

  const defaultSource = input.default_source ?? null;
  if (input.consumer_type === "lead") {
    if (!defaultSource) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Lead consumers require a default source.",
        },
      };
    }
    if (!LEAD_SOURCES.includes(defaultSource as LeadSource)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `default_source must be one of: ${LEAD_SOURCES.join(", ")}.`,
        },
      };
    }
  } else if (defaultSource !== null) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "Provider consumers must not set default_source — there's no lead being created.",
      },
    };
  }

  const notes = (input.notes ?? "").trim();
  if (notes.length > NOTES_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Notes is ${notes.length} characters — cap is ${NOTES_MAX_LENGTH}.`,
      },
    };
  }

  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  try {
    // Pre-check unique name so we can return a friendly DUPLICATE_NAME
    // (also caught as VALIDATION) instead of the raw 23505 unique
    // violation. Service-role client bypasses RLS — admin actions only.
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("webhook_consumers")
      .select("id")
      .eq("name", name)
      .maybeSingle();
    if (existing) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `A webhook consumer named "${name}" already exists.`,
        },
      };
    }

    const plaintextSecret = newPlaintextSecret();
    const secret_hash = hashSecret(plaintextSecret);

    const { data: inserted, error } = await admin
      .from("webhook_consumers")
      .insert({
        name,
        consumer_type: input.consumer_type,
        default_source: defaultSource,
        secret_hash,
        notes: notes.length > 0 ? notes : null,
        created_by: guard.userId,
      })
      .select("id")
      .single();
    if (error || !inserted) {
      // Catch race-condition unique violations (UNIQUE constraint on
      // name OR on secret_hash). 23505 is the Postgres unique-violation
      // SQLSTATE — surface as VALIDATION so the UI can render it
      // alongside the local pre-check version.
      const code =
        (error as { code?: string } | null)?.code === "23505"
          ? "VALIDATION"
          : "WEBHOOK_CREATE_FAILED";
      return {
        ok: false,
        error: { code, message: error?.message ?? "Insert failed." },
      };
    }

    return ok({
      id: inserted.id,
      plaintextSecret,
      url: buildWebhookUrl(input.consumer_type, plaintextSecret),
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_webhook_consumer" },
      extra: { name, consumer_type: input.consumer_type },
    });
    return errFromUnknown(e, "WEBHOOK_CREATE_FAILED");
  }
}

export type RotateWebhookConsumerData = {
  plaintextSecret: string;
  url: string;
};

/**
 * Rotate a consumer's secret. Generates a new plaintext, replaces the
 * stored hash atomically, and returns the new plaintext exactly once.
 * The previous secret stops working the moment the row's `secret_hash`
 * is updated — no grace period. (Yes, that means a rotation is a hard
 * cutover; integrators get the new URL out-of-band.)
 */
export async function rotateWebhookConsumer(
  id: string,
): Promise<Result<RotateWebhookConsumerData>> {
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "id is required." },
    };
  }

  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  try {
    const admin = createAdminClient();
    const { data: existing, error: lookupErr } = await admin
      .from("webhook_consumers")
      .select("id, consumer_type")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) {
      return {
        ok: false,
        error: {
          code: "WEBHOOK_ROTATE_FAILED",
          message: lookupErr.message,
        },
      };
    }
    if (!existing) {
      return {
        ok: false,
        error: {
          code: "WEBHOOK_NOT_FOUND",
          message: "Webhook consumer does not exist.",
        },
      };
    }

    const plaintextSecret = newPlaintextSecret();
    const secret_hash = hashSecret(plaintextSecret);

    const { error: updateErr } = await admin
      .from("webhook_consumers")
      .update({ secret_hash })
      .eq("id", id);
    if (updateErr) {
      return {
        ok: false,
        error: {
          code: "WEBHOOK_ROTATE_FAILED",
          message: updateErr.message,
        },
      };
    }

    return ok({
      plaintextSecret,
      url: buildWebhookUrl(
        existing.consumer_type as WebhookConsumerType,
        plaintextSecret,
      ),
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "rotate_webhook_consumer" },
      extra: { id },
    });
    return errFromUnknown(e, "WEBHOOK_ROTATE_FAILED");
  }
}

/**
 * Toggle a consumer on or off. Disabling sets `revoked_at` to now;
 * enabling clears it. The route's lookup index (migration 033)
 * partials on `enabled = true and revoked_at is null`, so the row
 * stops authenticating the moment either flag flips.
 */
export async function toggleWebhookConsumer(
  id: string,
  enabled: boolean,
): Promise<Result<null>> {
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "id is required." },
    };
  }

  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("webhook_consumers")
      .update({
        enabled,
        // Setting revoked_at when disabling is the audit signal: the
        // pair (enabled=false, revoked_at=<ts>) tells the admin UI when
        // the consumer was last shut off. Clearing it on re-enable
        // means the audit reflects the most recent revocation.
        revoked_at: enabled ? null : new Date().toISOString(),
      })
      .eq("id", id);
    if (error) {
      return {
        ok: false,
        error: { code: "WEBHOOK_TOGGLE_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "toggle_webhook_consumer" },
      extra: { id, enabled },
    });
    return errFromUnknown(e, "WEBHOOK_TOGGLE_FAILED");
  }
}

/**
 * Update a consumer's free-text notes. Trivial passthrough — admin-only.
 */
export async function updateWebhookConsumerNotes(
  id: string,
  notes: string,
): Promise<Result<null>> {
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "id is required." },
    };
  }

  const trimmed = (notes ?? "").trim();
  if (trimmed.length > NOTES_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Notes is ${trimmed.length} characters — cap is ${NOTES_MAX_LENGTH}.`,
      },
    };
  }

  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("webhook_consumers")
      .update({ notes: trimmed.length > 0 ? trimmed : null })
      .eq("id", id);
    if (error) {
      return {
        ok: false,
        error: { code: "WEBHOOK_NOTES_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_webhook_consumer_notes" },
      extra: { id },
    });
    return errFromUnknown(e, "WEBHOOK_NOTES_FAILED");
  }
}
