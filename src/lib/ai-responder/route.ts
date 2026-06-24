import type {
  AiEscalationReason,
  AiStructuredOutput,
  AiWrongScope,
} from "./types";

export type ResponderRoute =
  | {
      kind: "send_reply";
      body: string;
    }
  | {
      kind: "escalate";
      reason: `model:${AiEscalationReason}`;
    }
  | {
      kind: "opt_out";
      reason: "model:opt_out";
    }
  | {
      kind: "auto_close_wrong_number";
      reason: "model:wrong_number";
      scope: AiWrongScope;
    }
  | {
      kind: "auto_close";
      dispo: "not_interested";
      reason: "model:not_interested";
    }
  | {
      kind: "deescalate_close";
      reason: "model:deescalate_close";
    };

const ESCALATION_REASONS = new Set<AiEscalationReason>([
  "hot_lead",
  "price_or_offer",
  "distress",
  "multi_property",
  "call_request",
  "third_party",
  "needs_review",
]);

export function resolveResponderOutcome(
  signal: AiStructuredOutput,
): ResponderRoute {
  switch (signal.action) {
    case "send_reply":
      return { kind: "send_reply", body: signal.body };
    case "escalate":
      if (!ESCALATION_REASONS.has(signal.escalation_reason)) {
        return { kind: "escalate", reason: "model:needs_review" };
      }
      return { kind: "escalate", reason: `model:${signal.escalation_reason}` };
    case "opt_out":
      return { kind: "opt_out", reason: "model:opt_out" };
    case "close_wrong_number":
      return {
        kind: "auto_close_wrong_number",
        reason: "model:wrong_number",
        scope: signal.wrong_scope,
      };
    case "close_not_interested":
      return {
        kind: "auto_close",
        dispo: "not_interested",
        reason: "model:not_interested",
      };
    case "deescalate_close":
      return { kind: "deescalate_close", reason: "model:deescalate_close" };
    default:
      return assertNever(signal);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled AI responder action: ${JSON.stringify(value)}`);
}
