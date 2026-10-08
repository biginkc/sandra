import "server-only";

import { LUNA_TIMEOUT_MS } from "./config";
import {
  LUNA_ESCALATION_REASONS,
  LUNA_OUTCOMES,
  lunaJsonSchema,
  lunaSystemPrompt,
  lunaUserPrompt,
  type ThreadLine,
} from "./prompt";
import type { JevOutcome } from "../types";

/**
 * Server-only OpenAI Responses API client for Luna. One attempt, 15s timeout,
 * no retry: a failure is an `error` result and the card simply has no
 * suggestion. Error text is status-only; response bodies are never echoed
 * (they can contain the seller's message).
 */
export type LunaClientConfig = {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  baseUrl?: string;
};

export type LunaUsage = { inputTokens: number | null; outputTokens: number | null };
export type LunaOk = {
  status: "ok";
  outcome: JevOutcome;
  confidence: number;
  escalationReason: string;
  model: string;
  usage: LunaUsage | null;
  latencyMs: number;
};
export type LunaError = { status: "error"; error: string; model: string; latencyMs: number };
export type LunaResult = LunaOk | LunaError;

/** Pure: validate the model's JSON text against the schema. Throws on anything off-schema. */
export function parseLunaJson(text: string): { outcome: JevOutcome; confidence: number; escalationReason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("output is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("output is not a JSON object");
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["outcome", "escalation_reason", "confidence"].includes(k));
  if (extra.length) throw new Error("output has unexpected fields");
  if (typeof o.outcome !== "string" || !(LUNA_OUTCOMES as string[]).includes(o.outcome)) {
    throw new Error("outcome missing or not an allowed value");
  }
  if (typeof o.escalation_reason !== "string" || !LUNA_ESCALATION_REASONS.includes(o.escalation_reason)) {
    throw new Error("escalation_reason missing or not an allowed value");
  }
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    throw new Error("confidence missing or outside 0..1");
  }
  return { outcome: o.outcome as JevOutcome, confidence: o.confidence, escalationReason: o.escalation_reason };
}

type ResponsesJson = {
  output?: { type?: string; content?: { type?: string; text?: unknown }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

function extractText(json: ResponsesJson): { text: string; usage: LunaUsage | null } {
  const parts: string[] = [];
  for (const item of json?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c?.type === "refusal") throw new Error("model refused");
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  if (!parts.length) throw new Error("no output_text in response");
  const u = json?.usage;
  return {
    text: parts.join(""),
    usage: u ? { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null } : null,
  };
}

export async function classifyWithLuna(
  cfg: LunaClientConfig,
  thread: readonly ThreadLine[],
  deps: { fetch: typeof fetch },
): Promise<LunaResult> {
  const started = Date.now();
  const fail = (error: string): LunaError => ({ status: "error", error, model: cfg.model, latencyMs: Date.now() - started });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? LUNA_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await deps.fetch(`${cfg.baseUrl ?? "https://api.openai.com/v1"}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.model,
          instructions: lunaSystemPrompt(),
          input: lunaUserPrompt(thread),
          store: false,
          text: { format: { type: "json_schema", name: "sms_classification", strict: true, schema: lunaJsonSchema() } },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      return fail(e instanceof Error && e.name === "AbortError" ? "request timed out" : "network error");
    }
    if (!res.ok) return fail(`HTTP ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return fail("response is not JSON");
    }
    try {
      const { text, usage } = extractText(json as ResponsesJson);
      return { status: "ok", ...parseLunaJson(text), model: cfg.model, usage, latencyMs: Date.now() - started };
    } catch (e) {
      return fail(e instanceof Error ? e.message : "invalid response");
    }
  } finally {
    clearTimeout(timer);
  }
}
