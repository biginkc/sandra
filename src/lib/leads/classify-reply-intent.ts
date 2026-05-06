import Anthropic from "@anthropic-ai/sdk";

export type ReplyIntent = "positive" | "negative" | "neutral";

/**
 * Classifies an inbound SMS body as positive (seller shows genuine interest),
 * negative (clear disinterest/hostility), or neutral (ambiguous, confused,
 * one-word acknowledgment). Used to gate auto-qualification — only positive
 * replies promote a prospect to new_lead.
 *
 * Uses Haiku for cost efficiency (~100 tokens in + 1 token out). Falls back
 * to "neutral" on any parse error so the caller can decide the safe default.
 */
export async function classifyReplyIntent(
  body: string,
  anthropic: Anthropic,
): Promise<ReplyIntent> {
  const snippet = body.slice(0, 300);

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 5,
    messages: [
      {
        role: "user",
        content: `You classify inbound SMS replies from homeowners who were contacted about selling their property.

Reply: "${snippet}"

Does this reply show genuine interest in selling?

Respond with exactly one word:
- positive  (asking about price, says yes, wants to talk, shows willingness to sell)
- negative  (explicitly not interested, wants to be left alone, hostile)
- neutral   (confused, asking who you are, vague acknowledgment, unclear)`,
      },
    ],
  });

  const text =
    msg.content[0]?.type === "text" ? msg.content[0].text.trim().toLowerCase() : "";

  if (text.startsWith("positive")) return "positive";
  if (text.startsWith("negative")) return "negative";
  return "neutral";
}
