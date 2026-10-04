/**
 * Durable call state for /my-leads (Phase 2 UI, 2.5/2.6/2.8): the shapes the poll action returns
 * and the parsers that turn the RPC jsonb into them. Pure, shared by the server action and the
 * client hook. Anything that fails to parse is dropped (the poll keeps the last good data).
 */

export type CallPromptOutcomeGuess = "reached" | "no_answer" | "voicemail";

/** One ended, outcome-less, unacknowledged Dialpad call of the signed-in rep (fn_list_unacknowledged_call_prompts). */
export type CallPromptItem = {
  attemptId: string;
  propertyId: string;
  callActivityId: string;
  endedAt: string;
  durationSeconds: number | null;
  talkDurationSeconds: number | null;
  origin: "sandra" | "native";
  outcomeGuess: CallPromptOutcomeGuess | null;
  voicemail: boolean;
};

/** One phone appointment due now (fn_my_leads_callbacks_due). */
export type CallbackDueItem = {
  taskId: string;
  propertyId: string;
  dueAt: string;
  title: string;
  minutesLate: number;
};

/** One natively dialed call that matched several leads (fn_list_ambiguous_native_calls, 2.5). */
export type AmbiguousCallItem = {
  providerCallId: string;
  startedAtMs: number;
  direction: string;
  candidates: { propertyId: string; contactId: string; slot: number; address: string; city: string | null; homeownerName: string | null; stage: string | null }[];
};

export type CallStateSnapshot = {
  prompts: CallPromptItem[];
  /** Present only when the first page was full; the hook requests the next page lazily. */
  promptsCursor: { beforeEnded: string; beforeId: string } | null;
  ambiguous: AmbiguousCallItem[];
  callbacksDue: CallbackDueItem[];
  /** What the server-side flags and schema allow; the client never auto-opens when autoPrompt is false. */
  features: { autoPrompt: boolean; callbackAlert: boolean };
};

export type CallPromptAckVia = "saved" | "skipped" | "dismissed";

export const EMPTY_CALL_STATE: CallStateSnapshot = {
  prompts: [],
  promptsCursor: null,
  ambiguous: [],
  callbacksDue: [],
  features: { autoPrompt: false, callbackAlert: false },
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseCallPromptItem(value: unknown): CallPromptItem | null {
  if (!isRec(value)) return null;
  const attemptId = str(value.attemptId);
  const propertyId = str(value.propertyId);
  const callActivityId = str(value.callActivityId);
  const endedAt = str(value.endedAt);
  if (!attemptId || !propertyId || !callActivityId || !endedAt) return null;
  const guess = value.outcomeGuess;
  return {
    attemptId,
    propertyId,
    callActivityId,
    endedAt,
    durationSeconds: num(value.durationSeconds),
    talkDurationSeconds: num(value.talkDurationSeconds),
    origin: value.origin === "native" ? "native" : "sandra",
    outcomeGuess: guess === "reached" || guess === "no_answer" || guess === "voicemail" ? guess : null,
    voicemail: value.voicemail === true,
  };
}

export function parseCallPromptPage(value: unknown): { items: CallPromptItem[]; nextCursor: CallStateSnapshot["promptsCursor"] } {
  if (!isRec(value) || !Array.isArray(value.items)) return { items: [], nextCursor: null };
  const items = value.items.map(parseCallPromptItem).filter((item): item is CallPromptItem => item !== null);
  const cursor = isRec(value.nextCursor) ? value.nextCursor : null;
  const beforeEnded = cursor ? str(cursor.beforeEnded) : null;
  const beforeId = cursor ? str(cursor.beforeId) : null;
  return { items, nextCursor: beforeEnded && beforeId ? { beforeEnded, beforeId } : null };
}

export function parseCallbackDueItems(value: unknown): CallbackDueItem[] {
  if (!Array.isArray(value)) return [];
  const out: CallbackDueItem[] = [];
  for (const row of value) {
    if (!isRec(row)) continue;
    const taskId = str(row.taskId);
    const propertyId = str(row.propertyId);
    const dueAt = str(row.dueAt);
    if (!taskId || !propertyId || !dueAt) continue;
    out.push({ taskId, propertyId, dueAt, title: str(row.title) ?? "Callback", minutesLate: Math.max(0, num(row.minutesLate) ?? 0) });
  }
  return out;
}

export function parseAmbiguousCallItems(value: unknown): AmbiguousCallItem[] {
  if (!Array.isArray(value)) return [];
  const out: AmbiguousCallItem[] = [];
  for (const row of value) {
    if (!isRec(row)) continue;
    const providerCallId = str(row.providerCallId);
    if (!providerCallId) continue;
    const candidates = Array.isArray(row.candidates)
      ? row.candidates.flatMap((c) => {
          if (!isRec(c)) return [];
          const propertyId = str(c.propertyId);
          const contactId = str(c.contactId);
          if (!propertyId || !contactId) return [];
          return [{
            propertyId,
            contactId,
            slot: num(c.slot) ?? 1,
            address: str(c.address) ?? "",
            city: str(c.city),
            homeownerName: str(c.homeownerName),
            stage: str(c.stage),
          }];
        })
      : [];
    out.push({ providerCallId, startedAtMs: num(row.startedAtMs) ?? 0, direction: str(row.direction) ?? "outbound", candidates });
  }
  return out;
}

/** Oldest unacknowledged call first: the one the auto-open prompt shows. */
export function oldestPrompt(prompts: readonly CallPromptItem[]): CallPromptItem | null {
  let best: CallPromptItem | null = null;
  for (const item of prompts) {
    if (!best || Date.parse(item.endedAt) < Date.parse(best.endedAt)) best = item;
  }
  return best;
}
