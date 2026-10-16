import { createHmac, randomUUID } from "node:crypto";

import type { Trace } from "./trace";

/**
 * In-process Bland double. It implements the HTTP surface (`fetch`) the real
 * `createBlandClient` talks to, so the real classification code (accepted /
 * rejected / unknown, timeouts, unparseable bodies) is exercised, and it
 * delivers webhooks by calling the real webhook handler with a signed Request.
 * No network, no real Bland.
 *
 * Misbehaviour is configured per dialled number (each stress lead has its own
 * number), because that is all `sendCall` knows before the request id is bound.
 */
export type CallKind =
  | "callback"
  | "reached"
  | "not_interested"
  | "wrong_number"
  | "voicemail"
  | "no_answer_status"
  /** already_sold: maps to `unknown`, parks the request for a human. */
  | "unknown_token";

/** What Sandra must end up recording for a call of this kind (spec, not code-derived). */
export const EXPECTED_OUTCOME: Record<CallKind, "no_answer" | "callback_requested" | "reached_no_callback" | "not_interested" | "wrong_number" | "unknown"> = {
  callback: "callback_requested",
  reached: "reached_no_callback",
  not_interested: "not_interested",
  wrong_number: "wrong_number",
  voicemail: "no_answer",
  no_answer_status: "no_answer",
  unknown_token: "unknown",
};

export type SendBehavior =
  | "accept"
  /** The call IS placed, the response never arrives (client sees a timeout). */
  | "accept_timeout"
  /** The call IS placed, Bland answers 502. */
  | "accept_5xx"
  /** Nothing placed, Bland answers 503. */
  | "fail_5xx"
  | "reject_4xx"
  | "network_error_no_call"
  /** 200 with a body we cannot parse; the call IS placed. */
  | "accept_unparseable";

export type LookupBehavior =
  | "truth"
  | "not_completed"
  | "not_found"
  | "error_500"
  | "mismatch_key"
  | "mismatch_number"
  | "mismatch_call_id";

/** Kinds that end without a conversation: the call-twice retry applies to these. */
export const NON_CONNECT_KINDS: readonly CallKind[] = ["voicemail", "no_answer_status"];

export type Plan = {
  kind: CallKind;
  /**
   * What the SECOND call (the call-twice retry) turns out to be. Default: the
   * same as `kind`, so a no-answer lead is not answered on either try.
   */
  secondKind?: CallKind;
  send: SendBehavior;
  lookup: LookupBehavior;
  /** Webhooks delivered inside the send-call request, before its response returns. */
  webhooksBeforeResponse: number;
  /** Hold the send-call response until this resolves (the call is "in progress"). */
  hold?: Promise<void>;
  followUp?: string;
};

export type SendRecord = { tick: number; requestId: string; key: string; number: string; callId: string | null; placed: boolean; attempt: number | null };

export type FakeCall = {
  callId: string;
  requestId: string;
  key: string;
  number: string;
  plan: Plan;
  createdTick: number;
  /** 1 for the first call of a request, 2 for the retry. */
  attempt: number;
  /** What THIS call turns out to be (the plan's kind, or its secondKind for the retry). */
  kind: CallKind;
};

export type WebhookFlavor =
  | "good"
  | "bad_signature"
  | "missing_signature"
  | "tampered_body"
  | "malformed_json"
  | "not_object"
  | "no_metadata"
  | "mismatch_request_id"
  | "mismatch_key"
  | "mismatch_number"
  | "mismatch_call_id"
  /** A not-yet-completed progress payload (maps to unknown, never to an outcome). */
  | "incomplete"
  /** Completed but with a call_outcome token the pathway cannot emit. */
  | "unmapped_token"
  /** A real, validly signed payload that belongs to ANOTHER request (hostile or confused). */
  | "foreign_request";

export type WebhookResult = { flavor: WebhookFlavor; status: number; body: Record<string, unknown> };

export type FakeBlandDeps = {
  trace: Trace;
  secret: string;
  /** Delivers a request to the real webhook handler. */
  deliver: (request: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  fromNumber?: string;
};

const FOLLOW_UP = ["tomorrow at 3pm", "Thursday morning", "call me next week", "after 5pm Central tomorrow", ""];

export class FakeBland {
  readonly plans = new Map<string, Plan>();
  readonly sends: SendRecord[] = [];
  readonly calls = new Map<string, FakeCall>();
  readonly webhooks: { tick: number; callId: string; requestId: string; flavor: WebhookFlavor; status: number }[] = [];

  constructor(private readonly deps: FakeBlandDeps) {}

  plan(number: string, plan: Plan) {
    this.plans.set(number, plan);
  }

  /** The `fetch` the real Bland client uses. */
  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/v1/calls") return this.handleSend(JSON.parse(String(init?.body)));
    const match = /^\/v1\/calls\/(.+)$/.exec(url.pathname);
    if (method === "GET" && match) return this.handleLookup(decodeURIComponent(match[1]!));
    return json(404, { message: "no such route" });
  };

  private async handleSend(body: { phone_number: string; metadata?: { request_id?: string; idempotency_key?: string; attempt?: number } }): Promise<Response> {
    const number = body.phone_number;
    const requestId = body.metadata?.request_id ?? "";
    const key = body.metadata?.idempotency_key ?? "";
    const plan = this.plans.get(number);
    const record: SendRecord = { tick: this.deps.trace.tick(), requestId, key, number, callId: null, placed: false, attempt: body.metadata?.attempt ?? null };
    this.sends.push(record);
    this.deps.trace.add("bland", "mark", "send-call", { requestId, number });
    if (!plan) return json(400, { status: "error", message: "unplanned number" });

    const place = () => {
      const callId = `call_${randomUUID()}`;
      const attempt = [...this.calls.values()].filter((c) => c.requestId === requestId).length + 1;
      const kind = attempt === 1 ? plan.kind : (plan.secondKind ?? plan.kind);
      const call: FakeCall = { callId, requestId, key, number, plan, createdTick: this.deps.trace.tick(), attempt, kind };
      this.calls.set(callId, call);
      record.callId = callId;
      record.placed = true;
      return call;
    };

    switch (plan.send) {
      case "reject_4xx":
        return json(400, { status: "error", message: "invalid number" });
      case "fail_5xx":
        return json(503, { status: "error", message: "unavailable" });
      case "network_error_no_call":
        throw new TypeError("fetch failed");
      default:
        break;
    }

    const call = place();
    for (let i = 0; i < plan.webhooksBeforeResponse; i += 1) await this.webhook(call, "good");
    if (plan.hold) await plan.hold;

    switch (plan.send) {
      case "accept_timeout": {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      case "accept_5xx":
        return json(502, { status: "error", message: "bad gateway" });
      case "accept_unparseable":
        return new Response("<html>ok</html>", { status: 200 });
      default:
        return json(200, { status: "success", call_id: call.callId });
    }
  }

  private handleLookup(callId: string): Response {
    const call = this.calls.get(callId);
    if (!call) return json(404, { message: "not found" });
    const { plan } = call;
    switch (plan.lookup) {
      case "not_found":
        return json(404, { message: "not found" });
      case "error_500":
        return json(500, { message: "boom" });
      case "not_completed":
        return json(200, { ...this.payload(call), completed: false, status: "in-progress" });
      case "mismatch_key":
        return json(200, { ...this.payload(call), metadata: { request_id: call.requestId, idempotency_key: randomUUID(), attempt: call.attempt } });
      case "mismatch_number":
        return json(200, { ...this.payload(call), to: "+18165559999" });
      case "mismatch_call_id":
        return json(200, { ...this.payload(call), call_id: `call_${randomUUID()}` });
      default:
        return json(200, this.payload(call));
    }
  }

  /** The post-call payload (webhook body and get-call response share this shape). */
  payload(call: FakeCall): Record<string, unknown> {
    const vars: Record<string, string> = {
      seller_and_property: "Seller, the house",
      motivation_and_timeline: "needs to move soon",
      price_expectation: "around 150k",
      script_progress: "done",
    };
    const base: Record<string, unknown> = {
      call_id: call.callId,
      to: call.number,
      from: this.deps.fromNumber ?? "+18165550000",
      completed: true,
      status: "completed",
      answered_by: "human",
      metadata: { request_id: call.requestId, idempotency_key: call.key, attempt: call.attempt },
      summary: "stress summary",
      variables: vars,
    };
    switch (call.kind) {
      case "callback":
        vars.call_outcome = "callback_requested seller wants a call back";
        vars.follow_up_preference = call.plan.followUp ?? FOLLOW_UP[0]!;
        break;
      case "reached":
        vars.call_outcome = "qualified_review_requested all questions answered";
        break;
      case "not_interested":
        vars.call_outcome = "not_interested please stop calling";
        break;
      case "wrong_number":
        vars.call_outcome = "wrong_person this is not the owner";
        break;
      case "voicemail":
        base.answered_by = "voicemail";
        break;
      case "no_answer_status":
        base.status = "no-answer";
        base.answered_by = null;
        break;
      case "unknown_token":
        vars.call_outcome = "already_sold the house is sold";
        break;
    }
    return base;
  }

  /** Deliver one webhook for a placed call, optionally misbehaving. */
  async webhook(call: FakeCall, flavor: WebhookFlavor, foreign?: FakeCall): Promise<WebhookResult> {
    let payload: Record<string, unknown> = this.payload(call);
    let raw: string | null = null;
    let signWith = this.deps.secret;
    let signature: string | null | undefined;
    switch (flavor) {
      case "good":
        break;
      case "bad_signature":
        signWith = "wrong-secret";
        break;
      case "missing_signature":
        signature = null;
        break;
      case "malformed_json":
        raw = "{not json";
        break;
      case "not_object":
        raw = "[1,2,3]";
        break;
      case "no_metadata":
        delete payload.metadata;
        break;
      case "mismatch_request_id":
        payload = { ...payload, metadata: { request_id: randomUUID(), idempotency_key: call.key } };
        break;
      case "mismatch_key":
        payload = { ...payload, metadata: { request_id: call.requestId, idempotency_key: randomUUID() } };
        break;
      case "mismatch_number":
        payload = { ...payload, to: "+18165559998" };
        break;
      case "mismatch_call_id":
        payload = { ...payload, call_id: `call_${randomUUID()}` };
        break;
      case "incomplete":
        payload = { ...payload, completed: false, status: "in-progress" };
        break;
      case "unmapped_token":
        payload = { ...payload, variables: { ...(payload.variables as object), call_outcome: "teleported_away" } };
        break;
      case "foreign_request": {
        // Validly signed and internally consistent, but about someone else's request.
        const other = foreign ?? call;
        payload = this.payload(other);
        break;
      }
      case "tampered_body":
        break;
    }
    const body = raw ?? JSON.stringify(payload);
    const signed = flavor === "tampered_body" ? JSON.stringify({ ...payload, summary: "altered after signing" }) : body;
    const sig = signature === undefined ? createHmac("sha256", signWith).update(signed, "utf8").digest("hex") : signature;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sig) headers["x-webhook-signature"] = sig;
    const request = new Request("http://stress.local/api/webhooks/bland/call", { method: "POST", headers, body });
    const tick = this.deps.trace.add("bland", "mark", `webhook:${flavor}`, { callId: call.callId });
    const response = await this.deps.deliver(request);
    this.webhooks.push({ tick, callId: call.callId, requestId: call.requestId, flavor, status: response.status });
    return { flavor, status: response.status, body: response.body };
  }

  callsFor(requestId: string) {
    return [...this.calls.values()].filter((c) => c.requestId === requestId);
  }
  sendsFor(requestId: string) {
    return this.sends.filter((s) => s.requestId === requestId);
  }
  /** The FIRST call placed for a number, if any. */
  callForNumber(number: string) {
    return [...this.calls.values()].find((c) => c.number === number);
  }
  /** Every call placed for a number, oldest first (a call-twice request places up to two). */
  callsForNumber(number: string) {
    return [...this.calls.values()].filter((c) => c.number === number);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const WEBHOOK_SECRET = "stress-secret";
