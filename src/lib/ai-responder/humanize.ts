import type Anthropic from "@anthropic-ai/sdk";

/**
 * Second-pass humanizer for AI-drafted SMS replies.
 *
 * The first-pass `generateAiReply` produces a draft via the v2 system
 * prompt (which already bakes in the high-impact humanizer rules). This
 * pass runs that draft through Claude one more time with a humanizer-
 * focused system prompt as a belt-and-suspenders cleanup — catches the
 * subtle tells the first pass let through (em-dashes, AI vocab,
 * formal-ish phrasing).
 *
 * Hard rule: this MUST NEVER block a send. If the second-pass call
 * fails, times out, or returns something suspicious (empty, too short,
 * too long, contains tool-use chatter), we fall back to the original
 * draft. The first-pass output is already safe — humanize is polish,
 * not gating.
 */

export type AnthropicLike = Pick<Anthropic, "messages">;

export type HumanizeInput = {
  /** Draft SMS body produced by the first-pass model. */
  draft: string;
  /** Claude model id to use. Default in caller is the same as first-pass. */
  model: string;
};

export type HumanizeDeps = {
  client: AnthropicLike;
};

const HUMANIZER_SYSTEM_PROMPT = `You are a copy editor that strips AI-tells from short SMS replies in a real-estate cold-outreach context.

Rewrite the message below to sound like a casual text from one human to another, while preserving its meaning, any names mentioned, and the overall intent (a question, an exit, an acknowledgment).

NEVER use:
- Em-dashes or en-dashes. Replace with commas, periods, or shorter sentences.
- Double-dashes.
- The words: delve, navigate (figuratively), tapestry, underscore (verb), pivotal, vital, crucial, robust, comprehensive, leverage (verb), facilitate.
- The phrases: "I'm thrilled to", "I'd love to", "I'm here to help", "I hope this finds you well", "no-obligation cash offer", "as an investor".
- Exclamation points more than once per message.
- Formal closings: Sincerely, Regards, Best wishes.
- Title-case sentences when the original was lowercase.
- More than one question per message.

ALWAYS:
- Use contractions (I'm, don't, won't).
- Match the tone: casual gets casual, terse gets terse.
- Keep it under 160 characters.
- Preserve all proper names (people, companies) exactly as they appear.
- Output ONLY the rewritten text. No preamble, no quotes, no commentary.`;

/** Reply must be at least this many characters to be considered valid. */
const MIN_REPLY_LEN = 5;
/** SMS hard cap — TCPA-friendly single-segment territory. */
const MAX_REPLY_LEN = 320;

/**
 * Run the draft through the humanizer model. Always resolves to a
 * string — falls back to the input draft if anything goes wrong.
 *
 * @param input  draft body + model id
 * @param deps   anthropic client (DI for testing)
 * @returns      humanized body, or the original draft on failure
 */
export async function humanizeReply(
  input: HumanizeInput,
  deps: HumanizeDeps,
): Promise<string> {
  const draft = input.draft.trim();
  if (!draft) return draft;

  try {
    const response = await deps.client.messages.create({
      model: input.model,
      max_tokens: 200,
      system: [
        {
          type: "text",
          text: HUMANIZER_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Rewrite this SMS reply to remove AI-tells while preserving meaning:\n\n${draft}`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return draft;

    const cleaned = stripQuotesAndPreamble(textBlock.text).trim();
    if (cleaned.length < MIN_REPLY_LEN || cleaned.length > MAX_REPLY_LEN) {
      return draft;
    }

    return cleaned;
  } catch {
    return draft;
  }
}

/**
 * Models occasionally wrap output in quotes or add a "Here's the
 * rewrite:" preamble despite the system prompt. Strip those defensively.
 */
function stripQuotesAndPreamble(text: string): string {
  let out = text.trim();

  const preambleRe = /^(here(?:'s| is)?\s+(?:the\s+)?(?:rewrite|version|reply|edited).*?:\s*)/i;
  out = out.replace(preambleRe, "");

  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1);
  }

  return out.trim();
}

export { HUMANIZER_SYSTEM_PROMPT };
