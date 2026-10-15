/**
 * The complete draft lifecycle matrix (PR body has the same table).
 *
 *   (A) how the draft is linked to its property      x 5
 *   (B) what changes between the snapshot and a check x 9
 *   (C) where it is checked                           x 5 (+ a variant where the property is ALSO flagged)
 *
 * Expected outcomes come from one oracle (`resolveAfter`) that applies the documented rule — a draft belongs to
 * exactly one same-org, unlocked property, or it is not shown — and then the per-check-point rule:
 *   snapshot build      -> render at the resolved property | excluded (locked, not counted) | unverifiable (counted)
 *   final checks        -> render (draft kept) | missing (draft-only hold) | render without the draft (flagged hold)
 *   60-second recheck   -> unchanged | missing (not eligible) | Updated (shown draft changed)
 *   Send / Edit         -> ok | STALE
 * Every rendered snapshot card also asserts tape sentence === card sentence (pinned reason).
 */
import { describe, expect, it, vi } from "vitest";

import { fakePostgrest } from "./fake-postgrest.test-util";
import { draftStillOn, liveStateOf } from "./hold-list";
import { editAndSendHeldDraft, sendHeldDraft, type HoldActionDeps } from "./hold-actions";
import { loadHoldsByIds, loadMessagesV2Page } from "./holds-by-activity";
import { deriveTape, holdReasonSentence } from "./tape";
import type { RunWithSteps } from "./types";

type Row = Record<string, unknown>;
const u = (n: number, ns = 0) => `${String(ns).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (sec: number) => new Date(Date.UTC(2026, 9, 1) + sec * 1000).toISOString();

const P = u(1); // the draft's property at snapshot time
const P2 = u(2); // another unlocked property in the org
const L = u(3); // a DNC-locked property in the org
const X = u(4); // a property in ANOTHER org
const DRAFT = u(1, 4);
const RUN = u(1, 5);
const MSG = u(1, 7);
const CONV = u(1, 9);

const LINKS = ["own property_id", "run_id only", "inbound_message_id only", "conversation_id only", "no link"] as const;
type Link = (typeof LINKS)[number];
const CHANGES = [
  "none",
  "property_id -> unlocked same-org",
  "property_id -> DNC-locked",
  "property_id -> other org",
  "property_id -> null",
  "draft resolved/sent",
  "draft deleted",
  "run's property changed",
  "message's property changed",
] as const;
type Change = (typeof CHANGES)[number];

function base(link: Link, flagged: boolean): Record<string, Row[]> {
  const prop = (id: string, over: Row = {}): Row => ({ id, org_id: "org", needs_human_attention: false, is_dnc_locked: false, ...over });
  const properties = [
    prop(P, flagged ? { needs_human_attention: true, last_ai_escalation_at: at(1), last_ai_escalation_reason: "model:unclear", needs_human_attention_since: at(1) } : {}),
    prop(P2),
    prop(L, { is_dnc_locked: true }),
    { id: X, org_id: "other-org", needs_human_attention: false, is_dnc_locked: false },
  ];
  const draft: Row = { id: DRAFT, org_id: "org", status: "pending", property_id: null, conversation_id: null, inbound_message_id: null, run_id: null, created_at: at(10), body: "Draft text" };
  const runs: Row[] = [];
  const messages: Row[] = [];
  if (link === "own property_id") {
    // A draft answers a seller text: tied directly to P and to that text (the only kind the hold Send path sends).
    draft.property_id = P;
    draft.inbound_message_id = MSG;
    messages.push({ id: MSG, org_id: "org", conversation_id: null, property_id: P, contact_id: u(1, 8), from_address: "+18165550001", direction: "inbound", body: "b", created_at: at(4) });
  }
  if (link === "run_id only") {
    draft.run_id = RUN;
    runs.push({ id: RUN, org_id: "org", inbound_message_id: u(9, 6), property_id: P, conversation_id: null, status: "held", mode: "automatic", reason: null, inbound_preview: "x", started_at: at(5), completed_at: null });
  }
  if (link === "inbound_message_id only") {
    draft.inbound_message_id = MSG;
    messages.push({ id: MSG, org_id: "org", conversation_id: null, property_id: P, contact_id: u(1, 8), from_address: "+18165550001", direction: "inbound", body: "b", created_at: at(4) });
  }
  if (link === "conversation_id only") {
    draft.conversation_id = CONV;
    messages.push({ id: u(2, 7), org_id: "org", conversation_id: CONV, property_id: P, direction: "inbound", body: "b", created_at: at(4) });
  }
  return { properties, ai_reply_drafts: [draft], pipeline_runs: runs, messages, pipeline_run_steps: [] };
}

function applyChange(tables: Record<string, Row[]>, change: Change) {
  const d = tables.ai_reply_drafts;
  const set = (over: Row) => (tables.ai_reply_drafts = d.map((r) => ({ ...r, ...over })));
  switch (change) {
    case "none":
      return;
    case "property_id -> unlocked same-org":
      return set({ property_id: P2 });
    case "property_id -> DNC-locked":
      return set({ property_id: L });
    case "property_id -> other org":
      return set({ property_id: X });
    case "property_id -> null":
      return set({ property_id: null });
    case "draft resolved/sent":
      return set({ status: "sent" });
    case "draft deleted":
      tables.ai_reply_drafts = [];
      return;
    case "run's property changed":
      tables.pipeline_runs = tables.pipeline_runs.map((r) => ({ ...r, property_id: P2 }));
      return;
    case "message's property changed":
      tables.messages = tables.messages.map((m) => ({ ...m, property_id: P2 }));
      return;
  }
}

type Resolved = { kind: "property"; id: string } | { kind: "locked" } | { kind: "unverifiable" } | { kind: "gone" };

/** The oracle: the draft's property after the change, by the documented rule (independent of the code under test). */
function resolveAfter(link: Link, change: Change): Resolved {
  const tables = base(link, false);
  applyChange(tables, change);
  const d = tables.ai_reply_drafts.find((r) => r.status === "pending");
  if (!d) return { kind: "gone" };
  const c = new Set<string>();
  if (d.property_id) c.add(d.property_id as string);
  if (d.run_id) for (const r of tables.pipeline_runs) if (r.id === d.run_id && r.property_id) c.add(r.property_id as string);
  if (d.inbound_message_id) for (const m of tables.messages) if (m.id === d.inbound_message_id && m.property_id) c.add(m.property_id as string);
  if (d.conversation_id) for (const m of tables.messages) if (m.conversation_id === d.conversation_id && m.property_id) c.add(m.property_id as string);
  if (c.has(L)) return { kind: "locked" };
  if (c.has(X)) return { kind: "unverifiable" };
  if (c.size !== 1) return { kind: "unverifiable" };
  return { kind: "property", id: [...c][0] };
}

const db = (tables: Record<string, Row[]>, onAlertStatus?: () => void, lease = false) =>
  fakePostgrest(tables, {
    rpc: {
      ...(lease
        ? {
            fn_reserve_ai_send: () => ({ data: true, error: null }),
            fn_release_ai_send: () => ({ data: true, error: null }),
          }
        : {}),
      pipeline_runs_latest_for_properties: (args) => {
        const ids = args.p_property_ids as string[];
        return { data: tables.pipeline_runs.filter((r) => ids.includes(r.property_id as string)), error: null };
      },
      hold_alert_latest_status: () => {
        onAlertStatus?.();
        return { data: [], error: null };
      },
    },
  }).client;

/** Expected outcome label per cell (also printed into the PR body table). */
export function expected(link: Link, change: Change, check: string, flagged: boolean): string {
  const r = resolveAfter(link, change);
  const stillP = r.kind === "property" && r.id === P;
  const atSnapshot = resolveAfter(link, "none");
  const inSnapshot = atSnapshot.kind === "property" || flagged;
  switch (check) {
    case "snapshot build":
      if (r.kind === "property") return r.id === P ? "render at P" : flagged ? "render at P (no draft) and at P2 (with the draft)" : "render at P2";
      if (r.kind === "locked") return flagged ? "render at P without the draft" : "excluded (locked, not counted)";
      if (r.kind === "unverifiable") return flagged ? "render at P + unverifiable (counted)" : "unverifiable (counted)";
      return flagged ? "render at P without the draft" : "absent (nothing pending)";
    case "first-page final check":
    case "loadHoldsByIds final check":
      if (!inSnapshot) return "not in snapshot";
      if (stillP) return "render with the draft";
      return flagged ? "render without the draft" : "missing (counted)";
    case "60-second recheck":
      if (!inSnapshot) return "not in snapshot";
      if (stillP) return "unchanged";
      // The draft was never on this card (no link at snapshot time): nothing the card shows changed.
      if (atSnapshot.kind !== "property") return "unchanged (card never showed the draft)";
      return flagged ? "Updated + actions disabled" : "missing (removed)";
    case "Send / Edit":
      // The card only enables Send/Edit for a draft tied directly to its property and seller text.
      if (link !== "own property_id") return "disabled on the card; action refuses, nothing sent";
      // Sends only while the draft is still tied DIRECTLY to P (its own property_id) and resolves to P alone.
      return stillP && change !== "property_id -> null" ? "ok (sent)" : "refused (HOLD_STALE / not sendable / not pending / not found), nothing sent";
  }
  return "?";
}

const CHECKS = ["snapshot build", "first-page final check", "loadHoldsByIds final check", "60-second recheck", "Send / Edit"] as const;

describe.each([false, true])("draft lifecycle (property also flagged: %s)", (flagged) => {
  describe.each(LINKS)("link: %s", (link) => {
    it.each(CHANGES)("change: %s", async (change) => {
      const atSnap = resolveAfter(link, "none");
      const inSnapshot = atSnap.kind === "property" || flagged;

      // C1 snapshot build (the change happened before the page loaded)
      {
        const tables = base(link, flagged);
        applyChange(tables, change);
        const page = await loadMessagesV2Page(db(tables), "org");
        const want = expected(link, change, "snapshot build", flagged);
        const ids = page.snapshot.entries.map((e) => e.id);
        if (want.startsWith("render at P (no draft) and at P2")) expect([...ids].sort()).toEqual([P, P2].sort());
        else if (want.startsWith("render at P2")) expect(ids).toEqual([P2]);
        else if (want.startsWith("render at P")) expect(ids).toEqual([P]);
        else expect(ids).toEqual([]);
        expect(page.unverified).toBe(want.includes("unverifiable") ? 1 : 0);
        expect(page.holds.length).toBe(ids.length); // counts never include missing / unverifiable
        if (want === "render at P without the draft") expect(page.holds[0].draft).toBeUndefined();
        if (want.startsWith("render at P (no draft) and at P2")) {
          expect(page.holds.find((h) => h.id === P)!.draft).toBeUndefined();
          expect(page.holds.find((h) => h.id === P2)!.draft?.id).toBe(DRAFT);
        }
        // tape sentence === card sentence for every rendered card (pinned snapshot reason)
        for (const e of page.snapshot.entries) {
          const reason = e.r >= 0 ? page.snapshot.reasons[e.r] : null;
          const card = page.holds.find((h) => h.id === e.id)!;
          const sentence = holdReasonSentence(card.run ? { ...card.run, reason } : null, reason, "Dee", true);
          if (card.run) {
            const tape = deriveTape(card.run as RunWithSteps, "Dee", reason, true);
            expect(tape.kind === "decided" && tape.sentence).toBe(sentence);
          }
        }
      }

      if (inSnapshot) {
        // C2 first-page final check (the change lands during enrichment)
        {
          const tables = base(link, flagged);
          let done = false;
          const page = await loadMessagesV2Page(
            db(tables, () => {
              if (!done) {
                done = true;
                applyChange(tables, change);
              }
            }),
            "org",
          );
          const want = expected(link, change, "first-page final check", flagged);
          expect(page.snapshot.entries.map((e) => e.id)).toEqual([P]);
          if (want === "missing (counted)") {
            expect(page.holds).toEqual([]);
            expect(page.missing).toEqual([P]);
          } else {
            expect(page.holds.map((h) => h.id)).toEqual([P]);
            expect(page.missing).toEqual([]);
            if (want === "render without the draft") expect(page.holds[0].draft).toBeUndefined();
            if (want === "render with the draft" && atSnap.kind === "property") expect(page.holds[0].draft?.id).toBe(DRAFT);
          }
        }
        // C3 loadHoldsByIds final check (the change lands after the snapshot, before "Show older")
        {
          const tables = base(link, flagged);
          await loadMessagesV2Page(db(tables), "org");
          applyChange(tables, change);
          const res = await loadHoldsByIds(db(tables), "org", [P]);
          const want = expected(link, change, "loadHoldsByIds final check", flagged);
          if (want === "missing (counted)") {
            expect(res!.holds).toEqual([]);
            expect(res!.missing).toEqual([P]);
          } else {
            expect(res!.holds.map((h) => h.id)).toEqual([P]);
            if (want === "render without the draft") expect(res!.holds[0].draft).toBeUndefined();
          }
        }
        // C4 60-second recheck
        {
          const tables = base(link, flagged);
          const page = await loadMessagesV2Page(db(tables), "org");
          const shownDraft = page.holds[0]?.draft?.id ?? null;
          applyChange(tables, change);
          const [st] = (await liveStateOf(db(tables), "org", [P]))!;
          const want = expected(link, change, "60-second recheck", flagged);
          if (want === "missing (removed)") expect(st.eligible).toBe(false);
          else if (want.startsWith("unchanged")) {
            expect(st.eligible).toBe(true);
            expect(st.draftId).toBe(shownDraft);
          } else {
            expect(st.eligible).toBe(true);
            expect(st.draftId).not.toBe(shownDraft); // the column marks Updated and disables actions
          }
        }
      }

      // C5 the REAL Send and Edit actions, with the property the clicker saw (P)
      for (const kind of ["send", "edit"] as const) {
        const tables = base(link, flagged);
        const page = await loadMessagesV2Page(db(tables), "org");
        const card = page.holds.find((h) => h.id === P);
        if (card?.draft) expect(card.draft.sendable).toBe(link === "own property_id");
        applyChange(tables, change);
        const client = db(tables, undefined, true);
        const sendHumanDraft = vi.fn().mockResolvedValue({ status: "sent", messageId: "out-1" });
        const d: HoldActionDeps = {
          admin: client as never,
          orgId: "org",
          userId: "user-1",
          sendHumanDraft,
          recordLeadEvent: vi.fn().mockResolvedValue(undefined),
          resumeRun: vi.fn().mockResolvedValue(null),
          recordStep: vi.fn().mockResolvedValue(undefined),
          updateLeadAssignee: vi.fn(),
          suppressNumber: vi.fn(),
          resolveHostileReply: vi.fn(),
          reportError: vi.fn(),
          draftOwner: (draftId, propertyId) => draftStillOn(client, "org", draftId, propertyId),
        };
        const seen = { body: "Draft text", editedAt: null };
        const result =
          kind === "send"
            ? await sendHeldDraft(d, { draftId: DRAFT, seen, expectedPropertyId: P })
            : await editAndSendHeldDraft(d, { draftId: DRAFT, body: "Edited", seen, expectedPropertyId: P });
        const want = expected(link, change, "Send / Edit", flagged);
        if (want.startsWith("ok")) {
          expect(result.ok).toBe(true);
          expect(sendHumanDraft).toHaveBeenCalledTimes(1);
          expect(sendHumanDraft.mock.calls[0][1].propertyId).toBe(P);
        } else {
          expect(result.ok).toBe(false);
          expect(sendHumanDraft).not.toHaveBeenCalled();
          const code = result.ok ? "" : result.error.code;
          expect(["HOLD_STALE", "DRAFT_NOT_SENDABLE", "DRAFT_NOT_FOUND", "DRAFT_NOT_PENDING"]).toContain(code);
        }
      }
    });
  });
});

/** Prints the matrix (used for the PR body). */
export function matrixMarkdown(): string {
  const rows: string[] = [];
  for (const flagged of [false, true]) {
    rows.push(`\n**Property ${flagged ? "also flagged" : "held only by the draft"}**\n`);
    rows.push(`| link | change | ${CHECKS.join(" | ")} |`, `|${"---|".repeat(CHECKS.length + 2)}`);
    for (const link of LINKS) for (const change of CHANGES) rows.push(`| ${link} | ${change} | ${CHECKS.map((c) => expected(link, change, c, flagged)).join(" | ")} |`);
  }
  return rows.join("\n");
}

// `PRINT_MATRIX=path vitest run draft-lifecycle` writes the table for the PR body.
if (process.env.PRINT_MATRIX) {
  it("prints the matrix", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.PRINT_MATRIX!, matrixMarkdown());
  });
}
