import { err, type Result } from "@/lib/errors/result";

export type ReplyGeneration = "llm" | "off";

export type ReplyGenerationSetting = {
  configId: string;
  replyGeneration: ReplyGeneration;
};

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

/**
 * Calls the owner-only setter. The database is the authority (active org owner,
 * org resolved from the config row); this only maps its refusals to messages.
 */
export async function setReplyGeneration(
  supabase: RpcClient,
  input: { configId: string; mode: string },
): Promise<Result<ReplyGenerationSetting>> {
  if (input.mode !== "llm" && input.mode !== "off") {
    return err({ code: "INVALID_REQUEST", message: "Unknown setting." });
  }
  const { data, error } = await supabase.rpc("fn_set_ai_reply_generation", {
    p_config_id: input.configId,
    p_mode: input.mode,
  });
  if (error) {
    return err(
      error.code === "42501"
        ? { code: "FORBIDDEN", message: "Only an owner can change AI drafts." }
        : { code: "SET_FAILED", message: "Could not change AI drafts. Nothing was changed." },
    );
  }
  const row = (data ?? {}) as { id?: string; replyGeneration?: string };
  if (row.replyGeneration !== "llm" && row.replyGeneration !== "off") {
    return err({ code: "SET_FAILED", message: "Could not confirm the change. Refresh and check." });
  }
  return { ok: true, data: { configId: input.configId, replyGeneration: row.replyGeneration } };
}
