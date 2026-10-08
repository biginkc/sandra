"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { teamMemberOptionLabel, teamMemberPrimaryLabel, type TeamMember } from "@/lib/auth/team-member";
import type { Result } from "@/lib/errors/result";

import type { HoldActionsApi, SeenDraft } from "./hold-action-types";
import { LUNA_HUMAN_CONFIRM_OUTCOMES, lunaOutcomeLabel } from "./luna-labels";
import type { HoldSeen, LunaHoldSuggestion, OpenHold, RunWithSteps } from "./types";

type Status = { text: string; pending: boolean; href?: string };
type Mode = "idle" | "editing" | "dismissing" | "assigning";

const ACTIONS = ["Send", "Edit", "Take over ↗", "Assign", "Dismiss"] as const;

/** Disabled stand-ins, used when the page supplies no handlers. */
export function DisabledHoldActions({ title }: { title: string }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {ACTIONS.map((action) => (
        <span key={action} title={title}>
          <Button type="button" size="xs" variant="outline" disabled>
            {action}
          </Button>
        </span>
      ))}
    </div>
  );
}

/** What the draft would send: the human's last edit if there is one. */
export function effectiveDraftBody(hold: OpenHold<RunWithSteps>): string | null {
  const draft = hold.draft;
  if (!draft || draft.body === undefined) return null;
  return draft.edited_body ?? draft.body;
}

function errorText<T>(result: Result<T>): string {
  return result.ok ? "" : result.error.message || "That did not work.";
}

const LUNA_RELOAD_CODES = new Set(["LUNA_ALREADY_RESOLVED", "LUNA_NO_PENDING_ITEM"]);

/**
 * Luna's pick for this hold. A suggestion only: Apply is the human's click, and
 * opt-out outcomes (opted_out, dnc) have no Apply, only the existing review flow.
 */
function LunaSuggestionBlock({
  luna,
  actions,
  onReload,
}: {
  luna: LunaHoldSuggestion;
  actions: HoldActionsApi;
  onReload?: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const label = lunaOutcomeLabel(luna.outcome);
  const humanConfirm = LUNA_HUMAN_CONFIRM_OUTCOMES.has(luna.outcome);

  async function run<T>(call: () => Promise<Result<T>>, onOk: (data: T) => string, reloadOnOk: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    let result: Result<T>;
    try {
      result = await call();
    } catch {
      result = { ok: false, error: { code: "NETWORK", message: "Could not confirm: the server did not answer. Check before retrying." } };
    }
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setStatus(onOk(result.data));
      if (reloadOnOk) onReload?.();
    } else {
      setError(errorText(result));
      if (LUNA_RELOAD_CODES.has(result.error.code)) onReload?.();
    }
  }

  const apply = () =>
    actions.lunaApply &&
    run(
      () => actions.lunaApply!({ suggestionId: luna.id }),
      (data) => `Applied Luna's pick: ${label}${data.warning ? ` (${data.warning})` : ""}`,
      true,
    );
  const reject = () =>
    actions.lunaReject &&
    run(() => actions.lunaReject!({ suggestionId: luna.id }), () => "Dismissed Luna's suggestion", false);

  if (status) {
    return (
      <p data-testid="luna-status" aria-live="polite" className="text-xs font-medium">
        {status}
      </p>
    );
  }

  return (
    <div data-testid="luna-suggestion" className="flex flex-col gap-2 rounded-lg border p-2 text-sm">
      <p>
        Luna suggests: {label} ({Math.round(luna.confidence * 100)}%)
      </p>
      {error && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {humanConfirm ? (
          <a href="/jev/needs-decision" className="text-xs text-sky-700 underline dark:text-sky-300">
            Review opt-out
          </a>
        ) : (
          actions.lunaApply && (
            <Button type="button" size="xs" disabled={pending} onClick={apply}>
              Apply
            </Button>
          )
        )}
        {actions.lunaReject && (
          <Button type="button" size="xs" variant="outline" disabled={pending} onClick={reject}>
            Not this
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The five hold actions. State is optimistic: the card flips to its new
 * status the moment you click, and rolls back (with the reason) if the server
 * refuses. A refusal is shown as-is; nothing is retried in the background.
 */
export function HoldActionControls({
  hold,
  actions,
  onReload,
}: {
  hold: OpenHold<RunWithSteps>;
  actions: HoldActionsApi;
  /** Re-fetch the page data; called when the server says the card is out of date. */
  onReload?: () => void;
}) {
  const propertyId = hold.property_id;
  const draft = hold.draft ?? null;
  const [mode, setMode] = useState<Mode>("idle");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editText, setEditText] = useState(() => effectiveDraftBody(hold) ?? "");
  const [reason, setReason] = useState("");
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const busy = useRef(false);
  // A provider timeout means the text may have gone out: Send stays off until the card reloads.
  const [sendLocked, setSendLocked] = useState(false);
  const seenHold: HoldSeen = hold.seen ?? { through: null, flagReason: null, flagAt: null };
  const seenDraft: SeenDraft | null = draft && draft.body !== undefined
    ? { body: draft.edited_body ?? draft.body, editedAt: draft.edited_at ?? null }
    : null;

  // Runs one action: flip to `pending` text now, settle or roll back after.
  async function perform<T>(
    pendingText: string,
    call: () => Promise<Result<T>>,
    settled: (data: T) => { text: string; href?: string },
    after?: () => void,
  ) {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setStatus({ text: pendingText, pending: true });
    let result: Result<T>;
    try {
      result = await call();
    } catch {
      result = { ok: false, error: { code: "NETWORK", message: "Could not confirm: the server did not answer. Check the thread before retrying." } };
    }
    busy.current = false;
    if (result.ok) {
      setStatus({ ...settled(result.data), pending: false });
      setMode("idle");
      after?.();
    } else {
      setStatus(null);
      setError(errorText(result));
      const code = result.error.code;
      if (code === "SEND_TIMEOUT") setSendLocked(true);
      // The card is out of date: show why, then pull fresh data.
      if (code === "DRAFT_CHANGED" || code === "HOLD_STALE" || code === "DRAFT_NOT_PENDING") onReload?.();
    }
  }

  const sendDraft = () =>
    draft &&
    seenDraft &&
    perform(
      "Sending…",
      () => actions.send({ draftId: draft.id, seen: seenDraft }),
      () => ({ text: "Sent" }),
    );

  const sendEdit = () =>
    draft &&
    seenDraft &&
    perform(
      "Sending…",
      () => actions.editAndSend({ draftId: draft.id, body: editText, seen: seenDraft }),
      () => ({ text: "Sent (edited)" }),
    );

  const suppressionIncomplete =
    hold.flag_reason === "suppression_incomplete" || !!hold.flag_reason?.startsWith("suppression_incomplete:");

  const retrySuppression = () =>
    propertyId &&
    actions.retrySuppression &&
    perform(
      "Retrying suppression…",
      () => actions.retrySuppression!({ propertyId }),
      (data) => ({
        text: data.cleared
          ? "Suppression complete: the hold is cleared"
          : `Suppression still incomplete: ${data.remaining} opt-out${data.remaining === 1 ? "" : "s"} left`,
      }),
      onReload,
    );

  const hostileNeedsConfirm = !!hold.flag_reason?.startsWith("hostile_needs_confirm");
  const [confirmingDnc, setConfirmingDnc] = useState(false);

  const confirmDnc = () =>
    propertyId &&
    actions.confirmDoNotContact &&
    perform(
      "Confirming do-not-contact…",
      () => actions.confirmDoNotContact!({ propertyId, seen: seenHold }),
      (data) => ({
        text: data.replySent
          ? "Do-not-contact confirmed: reply sent, number suppressed"
          : `Do-not-contact confirmed: number suppressed${data.replyNote ? ` (${data.replyNote})` : ""}`,
      }),
      onReload,
    );

  const takeOver = () =>
    propertyId &&
    perform(
      "Taking over…",
      () => actions.takeOver({ propertyId, seen: seenHold }),
      (data) => ({ text: "Taken over: the AI is off for this lead", href: data.leadHref }),
    );

  const dismiss = () =>
    propertyId &&
    perform(
      "Dismissing…",
      () => actions.dismiss({ propertyId, reason, seen: seenHold }),
      () => ({ text: "Dismissed" }),
    );

  async function openAssign() {
    setMode("assigning");
    setError(null);
    if (members || !propertyId) return;
    let result: Result<TeamMember[]>;
    try {
      result = await actions.listAssignees({ propertyId });
    } catch {
      result = { ok: false, error: { code: "NETWORK", message: "x" } };
    }
    if (result.ok) setMembers(result.data);
    else {
      setMode("idle");
      setError("Could not load the team list. Try again.");
    }
  }

  async function assignTo(value: string) {
    if (!propertyId || busy.current) return;
    const next = value === "" ? null : value;
    const previous = assignee;
    const member = members?.find((m) => m.id === next);
    busy.current = true;
    setError(null);
    setAssignee(member ? teamMemberPrimaryLabel(member) : null);
    let result: Result<null>;
    try {
      result = await actions.assign({ propertyId, assigneeId: next });
    } catch {
      result = { ok: false, error: { code: "NETWORK", message: "Could not confirm: the server did not answer. Check before retrying." } };
    }
    busy.current = false;
    if (result.ok) {
      setMode("idle");
    } else {
      setAssignee(previous);
      setError(errorText(result));
    }
  }

  if (status) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span data-testid="hold-status" aria-live="polite" className="font-medium">
          {status.text}
        </span>
        {status.href && (
          <a href={status.href} target="_blank" rel="noreferrer" className="text-sky-700 underline dark:text-sky-300">
            Open lead ↗
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {assignee && (
        <p data-testid="hold-assignee" className="text-xs text-muted-foreground">
          Assigned to {assignee}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {hold.luna && <LunaSuggestionBlock key={hold.luna.id} luna={hold.luna} actions={actions} onReload={onReload} />}

      {suppressionIncomplete && (
        <div
          data-testid="suppression-incomplete-warning"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 p-2 text-xs font-semibold text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          <span>Suppression is incomplete: this number may still be texted. Retry suppression before dismissing.</span>
          {actions.retrySuppression && (
            <Button type="button" size="xs" disabled={!propertyId} onClick={retrySuppression}>
              Retry suppression
            </Button>
          )}
        </div>
      )}

      {hostileNeedsConfirm && (
        <div
          data-testid="hostile-confirm"
          className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <span>
            Hostile wording. Nothing was sent and the number is still active. Confirming stops all future texts to
            this number and sends the approved hostile reply, if one is set up. Dismiss leaves the number active.
          </span>
          {actions.confirmDoNotContact &&
            (confirmingDnc ? (
              <div className="flex gap-2">
                <Button type="button" size="xs" disabled={!propertyId} onClick={confirmDnc}>
                  Yes, stop all texts to this number
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmingDnc(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div>
                <Button type="button" size="xs" disabled={!propertyId} onClick={() => setConfirmingDnc(true)}>
                  Confirm do-not-contact
                </Button>
              </div>
            ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="xs" variant="outline" disabled={!draft || !seenDraft || sendLocked} onClick={sendDraft} title={draft ? undefined : "No reply draft to send"}>
          Send
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!draft || !seenDraft || sendLocked}
          onClick={() => {
            setEditText(effectiveDraftBody(hold) ?? "");
            setMode("editing");
            setError(null);
          }}
          title={draft ? undefined : "No reply draft to edit"}
        >
          Edit
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={!propertyId} onClick={takeOver}>
          Take over ↗
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={!propertyId} onClick={openAssign}>
          Assign
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!propertyId}
          onClick={() => {
            setMode("dismissing");
            setError(null);
          }}
        >
          Dismiss
        </Button>
      </div>

      {mode === "editing" && (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Edit reply"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={4}
          />
          <div className="flex gap-2">
            <Button type="button" size="xs" disabled={editText.trim() === "" || sendLocked} onClick={sendEdit}>
              Send edit
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === "dismissing" && (
        <div className="flex flex-col gap-2">
          <p data-testid="dismiss-warning" className="text-xs text-amber-800 dark:text-amber-200">
            The AI won&apos;t pick this thread up again until you dismiss — dismissing re-arms automation for this lead.
          </p>
          <Textarea
            aria-label="Reason for dismissing"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
          />
          <div className="flex gap-2">
            <Button type="button" size="xs" disabled={reason.trim() === ""} onClick={dismiss}>
              Confirm dismiss
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === "assigning" && members && (
        <label className="flex items-center gap-2 text-xs">
          Assign to
          <select
            aria-label="Assign to"
            className="rounded-md border bg-background px-2 py-1 text-sm"
            defaultValue=""
            onChange={(e) => assignTo(e.target.value)}
          >
            <option value="" disabled>
              Choose a teammate…
            </option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {teamMemberOptionLabel(m)}
              </option>
            ))}
            <option value="">Unassign</option>
          </select>
        </label>
      )}
    </div>
  );
}
