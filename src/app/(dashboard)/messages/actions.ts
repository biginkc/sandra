"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  releaseQueuedMessage,
  type SendSmsOutcome,
} from "@/lib/messaging/send";

export type ReleaseQueuedPayload = { outcome: SendSmsOutcome };

/**
 * Send one queued message. Called from the `/messages` page's "Send
 * Next" button and from the auto-send interval tick. Re-checks consent
 * + quiet hours at release time so a message queued 12 hours ago can
 * still be blocked if the contact opted out in between.
 */
export async function releaseMessage(
  messageId: string,
): Promise<Result<ReleaseQueuedPayload>> {
  try {
    const supabase = await createClient();
    const outcome = await releaseQueuedMessage(supabase, messageId);
    return ok({ outcome });
  } catch (e) {
    reportError(e, {
      tags: { surface: "release_message" },
      extra: { messageId },
    });
    return errFromUnknown(e, "RELEASE_MESSAGE_FAILED");
  }
}

/**
 * Edit a queued message's body before it sends. Only applies to
 * `status='queued'` rows — post-send is immutable.
 */
export async function updateQueuedMessage(
  messageId: string,
  body: string,
): Promise<Result<null>> {
  const trimmed = body.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: { code: "EMPTY_BODY", message: "Message body is empty." },
    };
  }
  if (trimmed.length > 1600) {
    return {
      ok: false,
      error: {
        code: "BODY_TOO_LONG",
        message: `Message is ${trimmed.length} characters — cap is 1600.`,
      },
    };
  }
  try {
    const supabase = await createClient();
    // Guard: only touch rows currently queued. A concurrent release
    // can't race us because of the status='queued' filter.
    const { error, data } = await supabase
      .from("messages")
      .update({ body: trimmed })
      .eq("id", messageId)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "UPDATE_FAILED", message: error.message },
      };
    }
    if (!data) {
      return {
        ok: false,
        error: {
          code: "NOT_QUEUED",
          message:
            "Message is no longer queued (already sent, failed, or deleted).",
        },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_queued_message" },
      extra: { messageId },
    });
    return errFromUnknown(e, "UPDATE_QUEUED_FAILED");
  }
}

/**
 * Delete a queued message. Same guard as edit — won't touch a message
 * that's already been sent.
 */
export async function deleteQueuedMessage(
  messageId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const { error, data } = await supabase
      .from("messages")
      .delete()
      .eq("id", messageId)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "DELETE_FAILED", message: error.message },
      };
    }
    if (!data) {
      return {
        ok: false,
        error: {
          code: "NOT_QUEUED",
          message:
            "Message is no longer queued — refresh the page to see current state.",
        },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "delete_queued_message" },
      extra: { messageId },
    });
    return errFromUnknown(e, "DELETE_QUEUED_FAILED");
  }
}
