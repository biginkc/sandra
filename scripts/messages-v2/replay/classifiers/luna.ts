/**
 * "Luna": an OpenAI model used as a classifier, for the LOCAL replay comparison only.
 * Never imported by anything under src/ (a unit test enforces that). Returns the same typed outcome
 * shape Jev returns (outcome, confidence 0..1, escalationReason). A failed call is an `error` result;
 * nothing is ever guessed.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
  api: "responses" | "chat" | "codex-cli";
  timeoutMs: number;
  baseUrl: string;
};

export class LunaConfigError extends Error {}

/** OPENAI_API_KEY and LUNA_MODEL are required; there is deliberately no default model. */
export function lunaConfigFromEnv(env: Record<string, string | undefined>): LunaConfig {
  const api = (env.LUNA_API ?? "responses").trim();
  if (api !== "responses" && api !== "chat" && api !== "codex-cli") throw new LunaConfigError('LUNA_API must be "responses", "chat" or "codex-cli"');
  const apiKey = (env.OPENAI_API_KEY ?? "").trim();
  // codex-cli uses the local Codex CLI login; no API key is read or needed.
  if (!apiKey && api !== "codex-cli") throw new LunaConfigError("OPENAI_API_KEY is required");
  const model = (env.LUNA_MODEL ?? "").trim();
  if (!model) throw new LunaConfigError("LUNA_MODEL is required (no default; Jarrad supplies the model id)");
  const timeoutMs = env.LUNA_TIMEOUT_MS ? Number(env.LUNA_TIMEOUT_MS) : api === "codex-cli" ? 120_000 : 30_000;
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

export type CodexRun = { code: number | null; stderr: string; stdout: string; timedOut: boolean };
export type LunaDeps = {
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** codex-cli transport only: run `codex` with args, prompt on stdin. Default spawns the real CLI. */
  runCodex?: (args: string[], stdin: string, timeoutMs: number) => Promise<CodexRun>;
};

export const CODEX_CAPACITY_BACKOFF_MS = 30_000;
export const CODEX_CAPACITY_RETRIES = 3;

class Capacity extends Error {}

/** Pure: the last top-level JSON object in free text (codex may wrap it in prose or a fence). */
export function lastJsonObject(text: string): string | null {
  let last: string | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { last = text.slice(i, j + 1); i = j; break; }
    }
  }
  return last;
}

export function codexPrompt(thread: readonly ThreadLine[]): string {
  return [
    lunaSystemPrompt(),
    "Respond with ONLY one JSON object (no prose, no code fence) that validates against this JSON schema:",
    JSON.stringify(lunaJsonSchema()),
    lunaUserPrompt(thread),
  ].join("\n\n");
}

export function defaultRunCodex(args: string[], stdin: string, timeoutMs: number): Promise<CodexRun> {
  return new Promise((resolve) => {
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stderr: String(e.message), stdout, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr, stdout, timedOut }); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

async function onceCodex(cfg: LunaConfig, thread: readonly ThreadLine[], deps: LunaDeps) {
  const run = deps.runCodex ?? defaultRunCodex;
  const scratch = mkdtempSync(path.join(tmpdir(), "luna-codex-"));
  const cwd = path.join(scratch, "cwd");
  const outFile = path.join(scratch, "out.txt");
  try {
    mkdirSync(cwd);
    const args = ["exec", "-m", cfg.model, "-s", "read-only", "--skip-git-repo-check", "-C", cwd, "-o", outFile, "-"];
    const r = await run(args, codexPrompt(thread), cfg.timeoutMs);
    if (r.timedOut) throw new Retryable("codex timed out");
    // Status only; never echo codex output (it can contain request content).
    if (/at capacity/i.test(`${r.stderr}\n${r.stdout}`)) throw new Capacity("codex at capacity");
    if (r.code !== 0) throw new Retryable(`codex exited ${r.code}`);
    let text: string;
    try { text = readFileSync(outFile, "utf8"); } catch { throw new Retryable("codex wrote no output file"); }
    const json = lastJsonObject(text);
    if (!json) throw new Retryable("no JSON object in codex output");
    return { ...parseLunaJson(json), usage: null as LunaUsage | null };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

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

function buildRequest(cfg: LunaConfig & { api: "responses" | "chat" }, thread: readonly ThreadLine[]): { url: string; body: unknown } {
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

function extract(cfg: LunaConfig & { api: "responses" | "chat" }, json: ApiJson): { text: string; usage: LunaUsage | null } {
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

async function once(cfg: LunaConfig & { api: "responses" | "chat" }, thread: readonly ThreadLine[], deps: LunaDeps) {
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
  let capacityLeft = CODEX_CAPACITY_RETRIES;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = cfg.api === "codex-cli" ? await onceCodex(cfg, thread, deps) : await once(cfg as LunaConfig & { api: "responses" | "chat" }, thread, deps);
      return { status: "ok", ...r, latencyMs: Date.now() - started, model: cfg.model };
    } catch (e) {
      lastError = e instanceof Error ? e.message : "unknown error";
      if (e instanceof Capacity) {
        if (capacityLeft-- > 0) { await sleep(CODEX_CAPACITY_BACKOFF_MS); attempt--; continue; }
        break;
      }
      if (e instanceof Fatal || !(e instanceof Retryable)) break;
      if (attempt === 0) await sleep(500);
    }
  }
  return { status: "error", error: lastError, latencyMs: Date.now() - started, model: cfg.model };
}
