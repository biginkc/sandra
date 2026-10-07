/**
 * "Luna": an OpenAI model used as a classifier, for the LOCAL replay comparison only.
 * Never imported by anything under src/ (a unit test enforces that). Returns the same typed outcome
 * shape Jev returns (outcome, confidence 0..1, escalationReason). A failed call is an `error` result;
 * nothing is ever guessed.
 */
import {
  LUNA_ESCALATION_REASONS,
  LUNA_OUTCOMES,
  lunaJsonSchema,
  lunaSystemPrompt,
  lunaUserPrompt,
  type ThreadLine,
} from "./luna-prompt";
import type { JevEscalationReason, JevOutcome } from "../../../../src/lib/sms-classification/types";

export type LunaConfig = {
  apiKey: string;
  model: string;
  api: "responses" | "chat";
  timeoutMs: number;
  baseUrl: string;
};

export class LunaConfigError extends Error {}

/** OPENAI_API_KEY and LUNA_MODEL are required; there is deliberately no default model. */
export function lunaConfigFromEnv(env: Record<string, string | undefined>): LunaConfig {
  const apiKey = (env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) throw new LunaConfigError("OPENAI_API_KEY is required");
  const model = (env.LUNA_MODEL ?? "").trim();
  if (!model) throw new LunaConfigError("LUNA_MODEL is required (no default; Jarrad supplies the model id)");
  const api = (env.LUNA_API ?? "responses").trim();
  if (api !== "responses" && api !== "chat") throw new LunaConfigError('LUNA_API must be "responses" or "chat"');
  const timeoutMs = env.LUNA_TIMEOUT_MS ? Number(env.LUNA_TIMEOUT_MS) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new LunaConfigError("LUNA_TIMEOUT_MS must be a positive number");
  return { apiKey, model, api, timeoutMs, baseUrl: "https://api.openai.com/v1" };
}

export type LunaUsage = { inputTokens: number | null; outputTokens: number | null };
export type LunaOk = {
  status: "ok";
  outcome: JevOutcome;
  confidence: number;
  escalationReason: JevEscalationReason;
  usage: LunaUsage | null;
  latencyMs: number;
  model: string;
};
export type LunaError = { status: "error"; error: string; latencyMs: number; model: string };
export type LunaResult = LunaOk | LunaError;

export type LunaDeps = { fetch: typeof fetch; sleep?: (ms: number) => Promise<void> };

class Retryable extends Error {}
class Fatal extends Error {}

/** Pure: validate the model's JSON text against the schema. Throws on anything off-schema. */
export function parseLunaJson(text: string): { outcome: JevOutcome; confidence: number; escalationReason: JevEscalationReason } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Retryable("output is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Retryable("output is not a JSON object");
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["outcome", "escalation_reason", "confidence"].includes(k));
  if (extra.length) throw new Retryable(`unexpected field(s): ${extra.join(", ")}`);
  if (typeof o.outcome !== "string" || !(LUNA_OUTCOMES as string[]).includes(o.outcome)) throw new Retryable("outcome missing or not an allowed value");
  if (typeof o.escalation_reason !== "string" || !LUNA_ESCALATION_REASONS.includes(o.escalation_reason)) throw new Retryable("escalation_reason missing or not an allowed value");
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) throw new Retryable("confidence missing or outside 0..1");
  return { outcome: o.outcome as JevOutcome, confidence: o.confidence, escalationReason: o.escalation_reason as JevEscalationReason };
}

function buildRequest(cfg: LunaConfig, thread: readonly ThreadLine[]): { url: string; body: unknown } {
  const schema = lunaJsonSchema();
  const system = lunaSystemPrompt();
  const user = lunaUserPrompt(thread);
  if (cfg.api === "responses") {
    return {
      url: `${cfg.baseUrl}/responses`,
      body: {
        model: cfg.model,
        instructions: system,
        input: user,
        store: false,
        text: { format: { type: "json_schema", name: "sms_classification", strict: true, schema } },
      },
    };
  }
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    body: {
      model: cfg.model,
      store: false,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "sms_classification", strict: true, schema } },
    },
  };
}

type ApiJson = {
  output?: { type?: string; content?: { type?: string; text?: unknown }[] }[];
  choices?: { message?: { content?: unknown; refusal?: unknown } }[];
  usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
};

function extract(cfg: LunaConfig, json: ApiJson): { text: string; usage: LunaUsage | null } {
  if (cfg.api === "responses") {
    const parts: string[] = [];
    for (const item of json?.output ?? []) {
      if (item?.type === "message") for (const c of item.content ?? []) {
        if (c?.type === "refusal") throw new Retryable("model refused");
        if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
      }
    }
    if (!parts.length) throw new Retryable("no output_text in response");
    const u = json?.usage;
    return { text: parts.join(""), usage: u ? { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null } : null };
  }
  const msg = json?.choices?.[0]?.message;
  if (msg?.refusal) throw new Retryable("model refused");
  if (typeof msg?.content !== "string") throw new Retryable("no message content in response");
  const u = json?.usage;
  return { text: msg.content, usage: u ? { inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null } : null };
}

async function once(cfg: LunaConfig, thread: readonly ThreadLine[], deps: LunaDeps) {
  const { url, body } = buildRequest(cfg, thread);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new Retryable(e instanceof Error && e.name === "AbortError" ? "request timed out" : "network error");
    }
    if (!res.ok) {
      // Never echo the response body: it could contain request content. Status only.
      if (res.status === 429 || res.status >= 500) throw new Retryable(`HTTP ${res.status}`);
      throw new Fatal(`HTTP ${res.status}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Retryable("response is not JSON");
    }
    const { text, usage } = extract(cfg, json as ApiJson);
    return { ...parseLunaJson(text), usage };
  } finally {
    clearTimeout(timer);
  }
}

/** One classification. Retries exactly once on transient failure or off-schema output. */
export async function classifyWithLuna(cfg: LunaConfig, thread: readonly ThreadLine[], deps: LunaDeps): Promise<LunaResult> {
  const started = Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError = "unknown error";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await once(cfg, thread, deps);
      return { status: "ok", ...r, latencyMs: Date.now() - started, model: cfg.model };
    } catch (e) {
      lastError = e instanceof Error ? e.message : "unknown error";
      if (e instanceof Fatal || !(e instanceof Retryable)) break;
      if (attempt === 0) await sleep(500);
    }
  }
  return { status: "error", error: lastError, latencyMs: Date.now() - started, model: cfg.model };
}
