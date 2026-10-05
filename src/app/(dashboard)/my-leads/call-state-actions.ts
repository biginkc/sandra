"use server";

import { reportError } from "@/lib/errors/report";
import {
  EMPTY_CALL_STATE,
  parseAmbiguousCallItems,
  parseCallPromptPage,
  parseCallbackDueItems,
  type CallPromptAckVia,
  type CallStateSnapshot,
} from "@/lib/my-leads/call-state";
import { getMyLeadsFlags } from "@/lib/my-leads/flags";
import { myLeadsViewer } from "@/lib/my-leads/queries";
import { schemaReady } from "@/lib/my-leads/schema-ready";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export type PollCallStateResult = { ok: true; state: CallStateSnapshot } | { ok: false; message: string };

/**
 * One round trip for everything the /my-leads client polls (2.5 ambiguous calls, 2.6 unacknowledged
 * prompts, 2.8 callbacks due). Each read is independently gated: a flag that is off, a missing row,
 * or a schema that has not landed reads as "nothing", never as an error. Personal: the RPCs use
 * auth.uid(); the client never names a member.
 */
export async function pollMyLeadsCallStateAction(
  input: { promptsCursor?: { beforeEnded: string; beforeId: string } | null } = {},
): Promise<PollCallStateResult> {
  let viewer: Awaited<ReturnType<typeof myLeadsViewer>>;
  try {
    viewer = await myLeadsViewer();
  } catch {
    return { ok: false, message: "Sign in with an active organization." };
  }
  const client = viewer.client as unknown as RpcClient;
  // One flag read for all four surfaces. When none is on the answer is "idle" and the client stops polling.
  const flags = await getMyLeadsFlags(viewer.orgId, ["click_to_dial", "auto_prompt", "callback_alert", "native_matcher"]);
  if (!flags.click_to_dial && !flags.auto_prompt && !flags.callback_alert && !flags.native_matcher) {
    return { ok: true, state: { ...EMPTY_CALL_STATE, idle: true } };
  }
  const { auto_prompt: autoPrompt, callback_alert: callbackAlert, native_matcher: nativeMatcher } = flags;
  const [promptsReady, callbacksReady] = await Promise.all([
    autoPrompt ? schemaReady("ack_prompts") : Promise.resolve(false),
    callbackAlert ? schemaReady("callbacks_due") : Promise.resolve(false),
  ]);
  const state: CallStateSnapshot = { ...EMPTY_CALL_STATE, features: { autoPrompt: promptsReady, callbackAlert: callbacksReady } };
  const failedSurfaces: NonNullable<CallStateSnapshot["failedSurfaces"]> = [];
  const guard = async (surface: string, part: "prompts" | "callbacks" | "ambiguous", run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      failedSurfaces.push(part);
      reportError(error instanceof Error ? error : new Error(`${surface} failed`), { tags: { surface: "server", operation: surface } });
    }
  };
  await Promise.all([
    promptsReady
      ? guard("my_leads_poll_prompts", "prompts", async () => {
          const cursor = input.promptsCursor ?? null;
          const { data, error } = await client.rpc("fn_list_unacknowledged_call_prompts", {
            p_org_id: viewer.orgId,
            p_limit: 20,
            p_before_ended: cursor?.beforeEnded ?? null,
            p_before_id: cursor?.beforeId ?? null,
          });
          if (error) throw new Error("fn_list_unacknowledged_call_prompts failed");
          const page = parseCallPromptPage(data);
          state.prompts = page.items;
          state.promptsCursor = page.nextCursor;
        })
      : Promise.resolve(),
    callbacksReady
      ? guard("my_leads_poll_callbacks", "callbacks", async () => {
          const { data, error } = await client.rpc("fn_my_leads_callbacks_due", { p_org_id: viewer.orgId });
          if (error) throw new Error("fn_my_leads_callbacks_due failed");
          state.callbacksDue = parseCallbackDueItems(data);
        })
      : Promise.resolve(),
    nativeMatcher
      ? guard("my_leads_poll_ambiguous", "ambiguous", async () => {
          const { data, error } = await client.rpc("fn_list_ambiguous_native_calls", { p_org_id: viewer.orgId });
          if (error) throw new Error("fn_list_ambiguous_native_calls failed");
          state.ambiguous = parseAmbiguousCallItems(data);
        })
      : Promise.resolve(),
  ]);
  // Keep every read that worked; only a total failure (every attempted read failed) is an error.
  const attempted = Number(promptsReady) + Number(callbacksReady) + Number(nativeMatcher);
  if (attempted > 0 && failedSurfaces.length >= attempted) return { ok: false, message: "Could not refresh call state." };
  if (failedSurfaces.length > 0) state.failedSurfaces = failedSurfaces;
  return { ok: true, state };
}

export type AcknowledgeCallPromptResult = { ok: true; status: "acknowledged" | "already" } | { ok: false; message: string };

/** Marks one prompt acknowledged (save, skip or dismiss). Idempotent; never touches the outcome. */
export async function acknowledgeCallPromptAction(attemptId: unknown, via: CallPromptAckVia): Promise<AcknowledgeCallPromptResult> {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) || (via !== "saved" && via !== "skipped" && via !== "dismissed")) {
    return { ok: false, message: "Unknown call." };
  }
  try {
    const viewer = await myLeadsViewer();
    const { data, error } = await (viewer.client as unknown as RpcClient).rpc("fn_acknowledge_call_prompt", {
      p_org_id: viewer.orgId,
      p_attempt_id: attemptId,
      p_via: via,
    });
    if (error) return { ok: false, message: "Could not acknowledge this call." };
    const status = typeof data === "object" && data !== null && (data as { status?: unknown }).status === "already" ? "already" : "acknowledged";
    return { ok: true, status };
  } catch {
    return { ok: false, message: "Could not acknowledge this call." };
  }
}
