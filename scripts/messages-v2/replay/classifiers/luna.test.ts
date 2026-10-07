import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { OUTCOME_CRITERIA, buildQuestions } from "../../../../src/lib/sms-classification/questions";
import { BLANKED_ENV } from "../server";
import { classifyWithLuna, lunaConfigFromEnv, parseLunaJson, type LunaConfig } from "./luna";
import { LUNA_BANNER, NON_VERBATIM, lunaSystemPrompt, lunaSystemSegments, renderLunaPromptMarkdown } from "./luna-prompt";

const cfg = (api: "responses" | "chat" = "responses"): LunaConfig => ({ apiKey: "sk-test", model: "luna-test", api, timeoutMs: 1000, baseUrl: "https://api.openai.com/v1" });
const good = { outcome: "not_interested", escalation_reason: "not_applicable", confidence: 0.93 };
const responsesBody = (o: unknown = good) => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(o) }] }], usage: { input_tokens: 120, output_tokens: 14 } });
const chatBody = (o: unknown = good) => ({ choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 120, completion_tokens: 14 } });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const http = (status: number) => ({ ok: false, status, json: async () => ({}) }) as Response;
const thread = [{ direction: "outbound" as const, body: "Still interested?" }, { direction: "inbound" as const, body: "no thanks" }];
const noSleep = async () => undefined;

describe("config", () => {
  it("requires OPENAI_API_KEY and LUNA_MODEL, with no default model", () => {
    expect(() => lunaConfigFromEnv({ LUNA_MODEL: "m" })).toThrow(/OPENAI_API_KEY/);
    expect(() => lunaConfigFromEnv({ OPENAI_API_KEY: "k" })).toThrow(/LUNA_MODEL/);
    expect(lunaConfigFromEnv({ OPENAI_API_KEY: "k", LUNA_MODEL: "m" })).toMatchObject({ model: "m", api: "responses" });
    expect(() => lunaConfigFromEnv({ OPENAI_API_KEY: "k", LUNA_MODEL: "m", LUNA_API: "x" })).toThrow(/LUNA_API/);
  });
});

describe("parseLunaJson", () => {
  it("accepts a valid object", () => {
    expect(parseLunaJson(JSON.stringify(good))).toEqual({ outcome: "not_interested", escalationReason: "not_applicable", confidence: 0.93 });
  });
  it.each([
    ["not json", "nope"],
    ["unknown outcome", JSON.stringify({ ...good, outcome: "hot" })],
    ["needs_sequence is not an outcome", JSON.stringify({ ...good, outcome: "needs_sequence" })],
    ["bad reason", JSON.stringify({ ...good, escalation_reason: "x" })],
    ["confidence > 1", JSON.stringify({ ...good, confidence: 1.2 })],
    ["confidence string", JSON.stringify({ ...good, confidence: "0.9" })],
    ["extra field", JSON.stringify({ ...good, why: "because" })],
    ["array", "[]"],
  ])("rejects %s", (_n, text) => {
    expect(() => parseLunaJson(text)).toThrow();
  });
});

describe("classifyWithLuna", () => {
  it("maps a Responses API reply to the typed outcome shape and sends a strict json_schema request", async () => {
    const fetchMock = vi.fn(async () => ok(responsesBody()));
    const r = await classifyWithLuna(cfg(), thread, { fetch: fetchMock as never, sleep: noSleep });
    expect(r).toMatchObject({ status: "ok", outcome: "not_interested", confidence: 0.93, escalationReason: "not_applicable", usage: { inputTokens: 120, outputTokens: 14 }, model: "luna-test" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init.body));
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.instructions).toBe(lunaSystemPrompt());
    expect(body.input).toContain("[inbound] no thanks");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });
  it("maps a Chat Completions reply", async () => {
    const fetchMock = vi.fn(async () => ok(chatBody()));
    const r = await classifyWithLuna(cfg("chat"), thread, { fetch: fetchMock as never, sleep: noSleep });
    expect(r).toMatchObject({ status: "ok", outcome: "not_interested", usage: { inputTokens: 120, outputTokens: 14 } });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://api.openai.com/v1/chat/completions");
  });
  it("retries exactly once on a transient failure, then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(http(503)).mockResolvedValueOnce(ok(responsesBody()));
    const r = await classifyWithLuna(cfg(), thread, { fetch: fetchMock as never, sleep: noSleep });
    expect(r.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("records an error (never a guess) after the second failure, and retries invalid output once", async () => {
    const fetchMock = vi.fn(async () => ok(responsesBody({ ...good, outcome: "made_up" })));
    const r = await classifyWithLuna(cfg(), thread, { fetch: fetchMock as never, sleep: noSleep });
    expect(r).toMatchObject({ status: "error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r).not.toHaveProperty("outcome");
  });
  it("does not retry auth errors and never echoes the response body", async () => {
    const fetchMock = vi.fn(async () => http(401));
    const r = await classifyWithLuna(cfg(), thread, { fetch: fetchMock as never, sleep: noSleep });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "error", error: "HTTP 401" });
  });
  it("treats a timeout/abort as a retryable error", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi.fn().mockRejectedValue(abort);
    const r = await classifyWithLuna(cfg(), thread, { fetch: fetchMock as never, sleep: noSleep });
    expect(r).toMatchObject({ status: "error", error: "request timed out" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("a refusal is an error", async () => {
    const refusal = { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] };
    const r = await classifyWithLuna(cfg(), thread, { fetch: (async () => ok(refusal)) as never, sleep: noSleep });
    expect(r.status).toBe("error");
  });
});

describe("prompt governance", () => {
  it("every definition is a verbatim copy of the Jev code; only the listed sentences are new", () => {
    const q = buildQuestions(false);
    const verbatim = lunaSystemSegments().filter((s) => s.verbatim).map((s) => s.text);
    for (const [name, def] of Object.entries(OUTCOME_CRITERIA)) expect(verbatim).toContain(`${name}: ${def}`);
    expect(verbatim).toContain(q.outcome.instructions);
    expect(verbatim).toContain(q.escalation_reason.instructions);
    for (const [name, def] of Object.entries(q.escalation_reason.criteria)) expect(verbatim).toContain(`${name}: ${def}`);
    const nonVerbatim = lunaSystemSegments().filter((s) => !s.verbatim).map((s) => s.text);
    const allowed: string[] = Object.values(NON_VERBATIM);
    expect(nonVerbatim.every((t) => allowed.includes(t))).toBe(true);
    expect(nonVerbatim.length).toBe(allowed.length - 1); // the last entry is the user-message header
  });
  it("luna-prompt.md is current, carries the DRAFT header, and lists the non-verbatim sentences", () => {
    const md = readFileSync(path.join(__dirname, "../luna-prompt.md"), "utf8");
    expect(md).toBe(renderLunaPromptMarkdown());
    expect(md.split("\n")[0]).toBe(`# ${LUNA_BANNER}`);
    for (const s of Object.values(NON_VERBATIM)) expect(md).toContain(s);
  });
});

describe("Luna stays out of production", () => {
  it("OPENAI_API_KEY is not blanked by the replay server env (compare runs standalone and needs it)", () => {
    expect((BLANKED_ENV as readonly string[]).includes("OPENAI_API_KEY")).toBe(false);
    expect((BLANKED_ENV as readonly string[]).includes("LUNA_MODEL")).toBe(false);
  });
  it("nothing under src/ references the Luna classifier", () => {
    const hits: string[] = [];
    const root = path.resolve(__dirname, "../../../../src");
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e) && /classifiers\/luna|LUNA_MODEL|messages-v2\/replay\/compare/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
  it("the compare modules never import a database client, messaging provider or Supabase client", () => {
    const dir = path.resolve(__dirname, "..");
    const files = ["compare.ts", "compare-core.ts", "compare-cache.ts", "compare-scoring.ts", "compare-thread.ts", "compare-safety.ts", "ground-truth.ts", "classifiers/luna.ts", "classifiers/luna-prompt.ts"];
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), "utf8");
      const imports = src.split("\n").filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l)).join("\n");
      expect(imports, f).not.toMatch(/from "pg"|from "@supabase|messaging\/|sms-send|rep-sms/);
      expect(src, f).not.toMatch(/\bsendSms\w*\(/);
    }
  });
});
