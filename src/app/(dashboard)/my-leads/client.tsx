"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RepSmsSettings } from "./rep-sms-settings";
import { Button } from "@/components/ui/button";
import { useOptionalSoftphone } from "@/components/softphone/softphone-provider";
import { BookAppointmentPopover } from "@/components/appointments/book-appointment-popover";
import type {
  AcquisitionKpis,
  AcquisitionRoster,
  QueueSnapshot,
  QueueRow,
  MyLeadRowLookup,
} from "@/lib/my-leads/queries";
import {
  MY_LEAD_ROW_ERROR_COPY,
  MY_LEAD_ROW_REASON_COPY,
} from "@/lib/my-leads/row-reasons";
import {
  newestCopy,
  pickAuthoritative,
  type AuthoritativeLookup,
} from "@/lib/my-leads/authoritative";
import type { MyLeadDripSnapshot } from "@/lib/my-leads/drip-queries";
import { WorkflowRecoveryContext } from "./_components/workflow-form";
import { useAttemptWorkflow } from "./_components/use-attempt-workflow";
import { MyLeadsQueue } from "./_components/queue";
import { AcquisitionAttemptDialog } from "./_components/attempt-dialog";
import { AcquisitionReadinessDialog } from "./_components/readiness-dialog";
import { AcquisitionOfferDialog } from "./_components/offer-dialog";
import { AcquisitionLifecycleDialog } from "./_components/lifecycle-dialog";
import {
  DialpadPanel,
  type DialpadCallRequest,
} from "./_components/dialpad-panel";
import type { DialpadPanelBootstrap } from "@/lib/dialpad-cti/dispatch";
import type {
  MyLeadAction,
  MyLeadStage,
  AcquisitionLifecycleMode,
} from "./_components/types";
import {
  detailView,
  kpiTiles,
  queueRow as queueRowView,
  stagePages,
} from "./adapter";
import type { SelectedLeadResult } from "./deep-link";
import {
  loadMyLeadCallReferences,
  loadMyLeadRow,
  loadMyLeads,
  loadMyLeadsStage,
  loadMyLeadDetail,
  changeAcquisitionDesignation,
  changeAcquisitionSettings,
} from "./actions";

type Props = {
  viewer: { userId: string; orgId: string; isOwner: boolean };
  roster: AcquisitionRoster;
  initialMemberId: string;
  initialSnapshot: QueueSnapshot | null;
  initialKpis: AcquisitionKpis | null;
  initialDrips?: MyLeadDripSnapshot | null;
  dialpad?: DialpadPanelBootstrap | null;
  initialSearch?: string;
  focus?: MyLeadsFocus | null;
  selectedLead?: import("./deep-link").SelectedLeadResult;
};
/** A lead opened from a deep link (lead page or Messages). */
export type MyLeadsFocus = {
  propertyId: string | null;
  memberId?: string | null;
  notice: string | null;
  pin?: QueueRow | null;
  pinStatus?: "unavailable" | "failed";
  retryHref?: string;
};
/** The latest single-row lookup for the deep-linked lead; part of the read model. */
type PinRead =
  | { id: string; lookup: MyLeadRowLookup | { status: "failed" } }
  | null;

function pinReadFromFocus(
  focus: MyLeadsFocus | null,
  snapshotAt: string,
): PinRead {
  if (!focus?.propertyId) return null;
  if (focus.pinStatus === "unavailable")
    return {
      id: focus.propertyId,
      lookup: { status: "unavailable", reason: "not_found" },
    };
  if (focus.pinStatus === "failed")
    return { id: focus.propertyId, lookup: { status: "failed" } };
  return focus.pin
    ? {
        id: focus.propertyId,
        lookup: {
          status: "found",
          row: focus.pin,
          snapshotAt,
        },
      }
    : null;
}

function focusFromSelectedLead(
  result: SelectedLeadResult,
  userId: string,
): MyLeadsFocus | null {
  if (result.status === "none" || result.status === "invalid") {
    if (result.status === "invalid") {
      return {
        propertyId: null,
        memberId: userId,
        notice:
          result.reason === "duplicate"
            ? "This My Leads link contains more than one lead. Open a link with exactly one lead."
            : "This My Leads link is invalid. Open a link with a valid lead id.",
        pin: null,
      };
    }
    return null;
  }
  if (result.status === "found") {
    return {
      propertyId: result.propertyId,
      memberId: userId,
      notice: null,
      pin: result.row,
    };
  }
  return {
    propertyId: result.propertyId,
    memberId: userId,
    notice: result.message,
    pin: null,
    pinStatus: result.status === "error" ? "failed" : "unavailable",
    retryHref: result.retryHref,
  };
}

const REFRESH_INTERVAL_MS = 30_000;

type DripEntry = MyLeadDripSnapshot["active"][number];
/** Every copy of every lead, grouped by propertyId in one pass, plus how many places hold each lead. */
function indexCopies(
  snapshot: QueueSnapshot | null | undefined,
  drips: MyLeadDripSnapshot | null | undefined,
) {
  const copies = new Map<string, QueueRow[]>();
  const places = new Map<string, number>();
  const add = (id: string, row: QueueRow | null) => {
    places.set(id, (places.get(id) ?? 0) + 1);
    if (row) (copies.get(id) ?? copies.set(id, []).get(id)!).push(row);
  };
  for (const page of Object.values(snapshot?.stages ?? {}))
    for (const row of page?.rows ?? []) add(row.propertyId, row);
  for (const entry of [...(drips?.replied ?? []), ...(drips?.active ?? [])])
    add(entry.propertyId, entry.queueRow);
  return { copies, places };
}
const copiesFor = (
  snapshot: QueueSnapshot | null | undefined,
  drips: MyLeadDripSnapshot | null | undefined,
  id: string,
) => indexCopies(snapshot, drips).copies.get(id) ?? [];
const lookupOf = (pin: PinRead | undefined, id: string): AuthoritativeLookup =>
  pin?.id !== id
    ? undefined
    : pin.lookup.status === "found"
      ? { status: "found", row: pin.lookup.row }
      : pin.lookup.status === "unavailable"
        ? { status: "unavailable" }
        : { status: "failed" };

/**
 * Reconciles competing copies into what is rendered, using pickAuthoritative as the
 * one rule. The displayed snapshot can be older than the drips (a background refresh
 * keeps the visible list stable while details are open) and than the single-row
 * lookup for the deep-linked lead, so any lead with more than one copy is resolved.
 * - Unavailable target: removed from every section by propertyId (including drip
 *   entries with no queue row), and reconciliation CONTINUES for every other lead.
 * - Otherwise the winner, whatever its source, is applied to ALL copies: one stage
 *   row in the winner's section (replaced in place), wrong-section copies dropped,
 *   and every drip entry takes the winning row and stage (stagePages groups replied
 *   pins by drip.stage). If no copy remains the caller pins the row.
 * Counts are deliberately left as the server snapshot reports them until the next
 * refresh: they describe the server's view at snapshotAt, and a one-lead correction
 * must not make them disagree with their own timestamp.
 */
function reconcileWithPin(
  snapshot: QueueSnapshot,
  drips: MyLeadDripSnapshot | null,
  pin: PinRead,
  id: string | null,
) {
  const removed =
    id && pin?.id === id && pin.lookup.status === "unavailable" ? id : null;
  const stages = { ...snapshot.stages } as QueueSnapshot["stages"];
  const stageKeys = Object.keys(stages) as (keyof typeof stages)[];
  if (removed)
    for (const key of stageKeys) {
      const page = stages[key];
      if (page)
        stages[key] = {
          ...page,
          rows: page.rows.filter((row) => row.propertyId !== removed),
        };
    }
  let working = drips;
  if (removed && drips)
    working = {
      ...drips,
      active: drips.active.filter((d) => d.propertyId !== removed),
      replied: drips.replied.filter((d) => d.propertyId !== removed),
    };
  const base: QueueSnapshot = { ...snapshot, stages };
  const { copies, places } = indexCopies(base, working);
  const winners = new Map<string, QueueRow>();
  for (const [propertyId, count] of places) {
    const lookup = id === propertyId ? lookupOf(pin, propertyId) : undefined;
    if (count < 2 && !lookup) continue;
    const winner = pickAuthoritative(
      newestCopy(copies.get(propertyId) ?? []),
      lookup,
    ).row;
    if (winner) winners.set(propertyId, winner);
  }
  if (!winners.size)
    return { snapshot: removed ? base : snapshot, drips: working };
  for (const key of stageKeys) {
    const page = stages[key];
    if (!page) continue;
    const placed = new Set<string>();
    stages[key] = {
      ...page,
      rows: page.rows.flatMap((row) => {
        const winner = winners.get(row.propertyId);
        if (!winner) return [row];
        if (winner.stage !== row.stage || placed.has(row.propertyId)) return [];
        placed.add(row.propertyId);
        return [winner];
      }),
    };
  }
  const apply = (entry: DripEntry): DripEntry => {
    const winner = winners.get(entry.propertyId);
    return winner ? { ...entry, queueRow: winner, stage: winner.stage } : entry;
  };
  return {
    snapshot: { ...snapshot, stages },
    drips: working
      ? {
          ...working,
          active: working.active.map(apply),
          replied: working.replied.map(apply),
        }
      : working,
  };
}
const refreshTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "America/Chicago",
  timeZoneName: "short",
});

export function MyLeadsClient({
  viewer,
  roster,
  initialMemberId,
  initialSnapshot,
  initialKpis,
  initialDrips = null,
  dialpad = null,
  initialSearch = "",
  focus: providedFocus = null,
  selectedLead = { status: "none" },
}: Props) {
  const focus =
    providedFocus ?? focusFromSelectedLead(selectedLead, viewer.userId);
  const router = useRouter();
  const softphone = useOptionalSoftphone();
  const [member, setMember] = useState(initialMemberId);
  const [search, setSearch] = useState(initialSearch);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [kpis, setKpis] = useState(initialKpis);
  const [drips, setDrips] = useState(initialDrips);
  const tiles = useMemo(() => (kpis ? kpiTiles(kpis) : null), [kpis]);
  const [lastCheckedAt, setLastCheckedAt] = useState(
    initialSnapshot?.snapshotAt ?? null,
  );
  const reviewingDetails = useRef(false);
  const [reviewing, setReviewing] = useState(false);
  const onReviewingChange = useCallback((active: boolean) => {
    reviewingDetails.current = active;
    setReviewing(active);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [loadingStages, setLoadingStages] = useState<Set<MyLeadStage>>(
    new Set(),
  );
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [callOptions, setCallOptions] = useState<{
    propertyId: string;
    options: { id: string; label: string }[];
    error: string | null;
  } | null>(null);
  const [callRetry, setCallRetry] = useState(0);
  const [dialpadRequest, setDialpadRequest] =
    useState<DialpadCallRequest | null>(null);
  const dialpadNonce = useRef(0);
  const onCallRequestHandled = useCallback((nonce: number) => {
    setDialpadRequest((current) => (current?.nonce === nonce ? null : current));
  }, []);
  const [dialog, setDialog] = useState<{
    action: MyLeadAction;
    row: QueueRow;
    callActivityId?: string | null;
  } | null>(null);
  type Opening = {
    action: MyLeadAction;
    row: QueueRow;
    scope: string;
    focusKey: string;
    callActivityId?: string | null;
  };
  const openingScope = JSON.stringify([member, search]);
  const activeScope = useRef(openingScope);
  activeScope.current = openingScope;
  const [pinRead, setPinRead] = useState<PinRead>(() =>
    pinReadFromFocus(focus, initialSnapshot?.snapshotAt ?? ""),
  );
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  // The latest pin outcome, for reconciling a failed lookup against the next list read.
  const actionPin = useRef<PinRead>(pinRead);
  // The deep-linked lead whose single-row lookup rides along with every refresh.
  const pinWanted = useRef<string | null>(focus?.propertyId ?? null);
  const readPin = async (
    propertyId: string,
    memberId: string,
  ): Promise<PinRead | "error"> => {
    try {
      const result = await loadMyLeadRow({ memberId, propertyId });
      if (result.ok) return { id: propertyId, lookup: result.lookup };
      if (result.code === "NOT_FOUND")
        return {
          id: propertyId,
          lookup: { status: "unavailable", reason: "not_found" },
        };
      return "error";
    } catch {
      return "error";
    }
  };
  const applyPin = (pin: PinRead) => {
    setPinRead(pin);
    actionPin.current = pin;
    setPinNotice(
      pin?.lookup.status === "unavailable"
        ? MY_LEAD_ROW_REASON_COPY[pin.lookup.reason]
        : null,
    );
  };
  /**
   * The authoritative row for a lead: an unavailable single-row lookup removes it
   * everywhere; otherwise the lookup's episode wins and a newer copy of that same
   * episode (higher queueVersion) from the lists may replace it. Never a stale copy
   * from another episode.
   */
  const findRow = (
    readSnapshot: QueueSnapshot | null,
    readDrips: MyLeadDripSnapshot | null | undefined,
    id: string,
    pin?: PinRead,
  ) =>
    pickAuthoritative(
      newestCopy(copiesFor(readSnapshot, readDrips, id)),
      lookupOf(pin, id),
    ).row;
  const pendingOpening = useRef<Opening | null>(null);
  const [openingStatus, setOpeningStatus] = useState<{
    opening: Opening;
    message: string;
    busy: boolean;
  } | null>(null);
  const cancelOpening = () => {
    pendingOpening.current = null;
    setOpeningStatus(null);
  };
  const [detailRevision, setDetailRevision] = useState(0);
  const [recipient, setRecipient] = useState(roster.settings.recipientId ?? "");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const initialEffect = useRef(Boolean(initialSnapshot && initialKpis));
  const request = useRef(0);
  const serverScopeKey = member;
  const previousServerScope = useRef(serverScopeKey);
  const refresh = useCallback(
    async (background = false) => {
      if (!roster.settings.enabled) return null;
      const id = ++request.current;
      try {
        const pinId = pinWanted.current;
        const [loaded, pinResult] = await Promise.all([
          loadMyLeads({ memberId: member, search, period: "today" }),
          pinId ? readPin(pinId, member) : Promise.resolve(undefined),
        ]);
        // A newer refresh, or a cleared/changed deep-link target, supersedes this read.
        if (id !== request.current) return null;
        // A failed lookup never resurrects an old pin over a list row: if the new list
        // has the lead the pin is dropped, otherwise the last good pin is kept.
        const inList =
          loaded.ok &&
          Boolean(pinId) &&
          (Object.values(loaded.snapshot.stages).some((page) =>
            page?.rows.some((row) => row.propertyId === pinId),
          ) ||
            [...loaded.drips.active, ...loaded.drips.replied].some(
              (drip) => drip.propertyId === pinId,
            ));
        const pin: PinRead | undefined =
          pinResult === "error"
            ? inList
              ? null
              : actionPin.current?.id === pinId
                ? actionPin.current
                : null
            : pinResult;
        const result = loaded;
        if (result.ok) {
          const applied = !background || !reviewingDetails.current;
          if (pinWanted.current === pinId && pin !== undefined)
            actionPin.current = pin;
          if (pinResult && pinWanted.current === pinId) {
            if (pinResult !== "error") applyPin(pinResult);
            else {
              setPinNotice(MY_LEAD_ROW_ERROR_COPY);
              if (inList && applied) setPinRead(null);
            }
          }
          // Replacing a paginated/reordered queue can unmount its recording player.
          // Background checks may update KPIs, but must leave open lead details alone.
          if (!background || !reviewingDetails.current)
            setSnapshot(result.snapshot);
          setKpis(result.kpis);
          setDrips(result.drips);
          setLastCheckedAt(result.snapshot.snapshotAt);
          setError(null);
          setRefreshError(null);
        } else setRefreshError(result.message);
        return result;
      } catch {
        if (id === request.current) {
          if (pinWanted.current) setPinNotice(MY_LEAD_ROW_ERROR_COPY);
          setRefreshError("My Leads could not refresh.");
        }
        return null;
      }
    },
    [member, search, roster.settings.enabled],
  );
  useEffect(() => {
    if (initialEffect.current) {
      initialEffect.current = false;
      return;
    }
    const scopeChanged = previousServerScope.current !== serverScopeKey;
    previousServerScope.current = serverScopeKey;
    ++request.current;
    if (scopeChanged) {
      setSnapshot(null);
      setKpis(null);
      setDrips(null);
    }
    const timer = setTimeout(() => void refresh(), 250);
    return () => {
      clearTimeout(timer);
    };
  }, [refresh, serverScopeKey]);
  useEffect(() => {
    if (!roster.settings.enabled) return;
    const delay = Math.min(
      REFRESH_INTERVAL_MS,
      Math.max(
        1000,
        snapshot?.nextWarningAt
          ? Date.parse(snapshot.nextWarningAt) - Date.now()
          : REFRESH_INTERVAL_MS,
      ),
    );
    let cancelled = false;
    // A failed read does not replace snapshot, so it cannot re-arm this effect.
    // Keep retrying even after transport/authentication failures or hidden tabs.
    const tick = async () => {
      try {
        if (!document.hidden) await refresh(true);
      } finally {
        if (!cancelled)
          timer = setTimeout(() => void tick(), REFRESH_INTERVAL_MS);
      }
    };
    let timer = setTimeout(() => void tick(), delay);
    const onVisible = () => {
      if (!document.hidden) void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [snapshot, refresh, roster.settings.enabled]);
  // The displayed row. Only used to find what the user clicked; command preconditions come from the single-row lookup at opening time.
  const rawRow = (id: string) => findRow(snapshot, drips, id, pinRead);
  /**
   * Every workflow opening reads the lead through the single-row lookup (a database
   * statement-time read) and uses THAT row for the command's preconditions (episode,
   * version, shared status). List copies are never trusted for a command: they can
   * be stale in ways queueVersion does not reveal. A failed lookup blocks the opening
   * with a retryable error rather than falling back to a list row.
   */
  const finishOpening = async (opening: Opening) => {
    pendingOpening.current = opening;
    setOpeningStatus({ opening, message: "Loading current lead…", busy: true });
    const lookup = await readPin(opening.row.propertyId, member);
    if (
      pendingOpening.current !== opening ||
      activeScope.current !== opening.scope ||
      latestFocusKey.current !== opening.focusKey
    )
      return;
    if (lookup === "error") {
      setOpeningStatus({
        opening,
        message: "Could not load current lead details. Retry to continue.",
        busy: false,
      });
      return;
    }
    const fresh = lookup?.lookup.status === "found" ? lookup.lookup.row : null;
    // Never silently move an opening into a different assignment episode.
    if (
      !fresh ||
      fresh.assignmentEpisodeId !== opening.row.assignmentEpisodeId
    ) {
      setOpeningStatus({
        opening,
        message:
          "This lead is unavailable or its assignment changed. Refresh the queue and reopen it.",
        busy: false,
      });
      return;
    }
    pendingOpening.current = null;
    setOpeningStatus(null);
    setCallOptions(null);
    setDialog({
      action: opening.action,
      row: fresh,
      callActivityId: opening.callActivityId,
    });
  };
  const retryOpening = () => {
    const opening = pendingOpening.current;
    if (!opening || openingStatus?.busy) return;
    void finishOpening(opening);
  };
  const action = (
    kind: MyLeadAction,
    id: string,
    callActivityId?: string | null,
  ) => {
    const row = rawRow(id);
    if (!row) return;
    cancelOpening();
    if (kind === "start-call" && dialpad) {
      // An active Dialpad connection routes calls through the audited CTI flow; the server re-derives org and rep and revalidates at dispatch.
      if (member !== viewer.userId) {
        setError("Open your own queue to call with Dialpad.");
        return;
      }
      setError(null);
      setDialpadRequest({
        nonce: ++dialpadNonce.current,
        propertyId: row.propertyId,
        contactId: row.contactId ?? null,
        label: row.homeownerName ?? row.address,
      });
      return;
    }
    if (kind === "start-call") {
      if (!softphone?.callingEnabled) {
        setError("Calling is not enabled.");
        return;
      }
      softphone.openLead({
        id: row.propertyId,
        contactId: row.contactId,
        firstName: row.homeownerName?.split(" ")[0] ?? "",
        name: row.homeownerName ?? row.address,
        address: row.address,
        state: row.state,
        phones: row.phones,
        dncLocked: false,
        contactDnc: row.contactDnc,
        callable: row.phones.some((phone) => !!phone.trim()) && !row.contactDnc,
      });
      return;
    }
    void finishOpening({
      action: kind,
      row,
      scope: openingScope,
      focusKey,
      callActivityId,
    });
  };
  useEffect(() => {
    if (dialog?.action !== "log-attempt") return;
    let cancelled = false;
    const propertyId = dialog.row.propertyId;
    setCallOptions(null);
    void loadMyLeadCallReferences(propertyId, member)
      .then((result) => {
        if (!cancelled)
          setCallOptions({
            propertyId,
            options: result.ok ? result.options : [],
            error: result.ok ? null : result.message,
          });
      })
      .catch(() => {
        if (!cancelled)
          setCallOptions({
            propertyId,
            options: [],
            error: "Could not load Sandra calls.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [dialog, member, callRetry]);
  const readRecoveryRow = useCallback(
    async (opening: { row: QueueRow }) => {
      // Recovery stays blocked until the authoritative single-row lookup succeeds, and
      // the lookup row (never a list row) supplies the retried command's preconditions.
      const lookup = await readPin(opening.row.propertyId, member);
      if (lookup === "error") throw new Error("row lookup failed");
      return lookup?.lookup.status === "found" ? lookup.lookup.row : null;
    },
    [member],
  );
  const { submit, recoveryValue, onDripChanged } = useAttemptWorkflow({
    opening: dialog,
    memberId: member,
    readRow: readRecoveryRow,
    onCommitted: () => {
      const read = refresh();
      setDetailRevision((revision) => revision + 1);
      return read;
    },
    onSettled: ({ opening, dripFailure }) => {
      if (
        dripFailure &&
        (opening.action === "log-attempt" || opening.action === "handoff")
      )
        setError(dripFailure);
      router.refresh();
    },
    onClose: (opening) =>
      setDialog((current) => (current === opening ? null : current)),
    onDripChanged: () => {
      void refresh();
      router.refresh();
    },
  });
  // The deep-link target lives in client state, seeded from the URL. A user-driven
  // rep/search change clears it (and the URL, without adding history). A different
  // ?lead= value arriving later (new link, Back/Forward) is a new target; a refresh
  // that re-renders with the same value is not.
  const focusKey = `${focus?.propertyId ?? ""}|${focus?.notice ?? ""}|${focus?.memberId ?? ""}`;
  const latestFocusKey = useRef(focusKey);
  const [target, setTarget] = useState(() => ({
    propertyId: focus?.propertyId ?? null,
    notice: focus?.notice ?? null,
    retryHref: focus?.retryHref,
    nonce: 0,
  }));
  const [seenFocusKey, setSeenFocusKey] = useState(focusKey);
  const [clearedForKey, setClearedForKey] = useState<string | null>(null);
  if (seenFocusKey !== focusKey) {
    setSeenFocusKey(focusKey);
    setClearedForKey(null);
    setTarget((previous) => ({
      propertyId: focus?.propertyId ?? null,
      notice: focus?.notice ?? null,
      retryHref: focus?.retryHref,
      nonce: previous.nonce + 1,
    }));
    setOpeningStatus(null);
    setDialog(null);
    setCallOptions(null);
    setPinNotice(null);
    {
      setPinRead(pinReadFromFocus(focus, snapshot?.snapshotAt ?? ""));
    }
    if (focus?.propertyId) {
      // A deep link always opens its rep's queue unfiltered.
      if (focus.memberId && focus.memberId !== member)
        setMember(focus.memberId);
      setSearch("");
    }
  }
  useEffect(() => {
    latestFocusKey.current = focusKey;
    pendingOpening.current = null;
    setOpeningStatus(null);
  }, [openingScope, focusKey]);
  useEffect(() => {
    pinWanted.current = target.propertyId;
  }, [target.propertyId]);
  // A new deep link reseeds the displayed pin during render; the action pin follows after commit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    actionPin.current = pinRead;
  }, [seenFocusKey]);
  const clearFocus = () => {
    if (target.propertyId || target.notice)
      setTarget((previous) => ({
        propertyId: null,
        notice: null,
        retryHref: undefined,
        nonce: previous.nonce,
      }));
    // Dropping the target drops the pin, and any in-flight pin read is ignored.
    pinWanted.current = null;
    setPinRead(null);
    actionPin.current = null;
    setPinNotice(null);
    if (focusKey !== "||" && clearedForKey !== focusKey) {
      setClearedForKey(focusKey);
      router.replace("/my-leads", { scroll: false });
    }
  };
  const view = useMemo(
    () =>
      snapshot
        ? reconcileWithPin(snapshot, drips, pinRead, target.propertyId)
        : null,
    [snapshot, drips, pinRead, target.propertyId],
  );
  const pages = snapshot && view ? stagePages(view.snapshot, view.drips) : null;
  // Show the lead in place when a loaded page has it; otherwise pin it at the top of its section.
  const pinnedLookup =
    target.propertyId &&
    pinRead?.id === target.propertyId &&
    pinRead.lookup.status === "found"
      ? pinRead.lookup.row
      : null;
  const pinnedView =
    pages &&
    snapshot &&
    pinnedLookup &&
    !(
      Object.values(pages).some((page) =>
        page.rows.some((row) => row.propertyId === pinnedLookup.propertyId),
      ) ||
      view?.drips?.active.some(
        (row) => row.propertyId === pinnedLookup.propertyId,
      )
    )
      ? {
          ...queueRowView(
            findRow(snapshot, drips, pinnedLookup.propertyId, pinRead) ??
              pinnedLookup,
            snapshot.snapshotAt,
          ),
          dripReply:
            drips?.replied.find(
              (row) => row.propertyId === pinnedLookup.propertyId,
            ) ?? null,
        }
      : null;
  if (pages)
    for (const stage of loadingStages) pages[stage].isLoadingMore = true;
  const motivation =
    dialog?.row.motivationKind === "specified"
      ? { kind: "specified" as const, text: dialog.row.motivationText ?? "" }
      : dialog?.row.motivationKind === "no_motivation"
        ? { kind: "no_motivation" as const, text: null }
        : null;
  // Completion callbacks belong to one opening, even when the same lead is reopened.
  // A previous form can finish after its post-save refresh and must not close a new form.
  const common = dialog
    ? {
        open: true,
        propertyId: dialog.row.propertyId,
        propertyLabel: dialog.row.address,
        onOpenChange: (open: boolean) => {
          if (!open) {
            setDialog((current) => (current === dialog ? null : current));
          }
        },
      }
    : null;
  const canonicalRetryHref = target.propertyId
    ? `/my-leads?lead=${encodeURIComponent(target.propertyId)}`
    : null;
  const retryHref =
    canonicalRetryHref && target.retryHref === canonicalRetryHref
      ? target.retryHref
      : canonicalRetryHref;
  return (
    <>
      {openingStatus && (
        <div role="status" className="mb-4 rounded border p-3">
          {openingStatus.message}
          {!openingStatus.busy && (
            <Button type="button" variant="outline" onClick={retryOpening}>
              Retry opening
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={cancelOpening}>
            Cancel opening
          </Button>
        </div>
      )}
      {viewer.isOwner && (
        <details className="mb-4 rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">
            Manage Acquisitions
          </summary>
          <div className="mt-3 space-y-3">
            {roster.members
              .filter((m) => m.active)
              .map((m) => (
                <label key={m.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={m.acquisitionsEnabled}
                    disabled={settingsBusy}
                    onChange={async () => {
                      setSettingsBusy(true);
                      try {
                        const result = await changeAcquisitionDesignation({
                          orgId: viewer.orgId,
                          userId: m.id,
                          enabled: !m.acquisitionsEnabled,
                          expectedEnabled: m.acquisitionsEnabled,
                          idempotencyKey: crypto.randomUUID(),
                        });
                        if (!result.ok) setError(result.message);
                        else router.refresh();
                      } finally {
                        setSettingsBusy(false);
                      }
                    }}
                  />
                  {m.label}
                </label>
              ))}
            <label className="block">
              Needs drip recipient
              <select
                className="ml-2 rounded border p-2"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              >
                <option value="">Choose recipient</option>
                {roster.members
                  .filter((m) => m.active)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              disabled={!recipient || settingsBusy}
              onClick={async () => {
                setSettingsBusy(true);
                try {
                  const result = await changeAcquisitionSettings({
                    orgId: viewer.orgId,
                    needsSequenceOwnerId: recipient,
                    expectedSettingsRevision: roster.settings.revision,
                    idempotencyKey: crypto.randomUUID(),
                  });
                  if (!result.ok) setError(result.message);
                  else router.refresh();
                } finally {
                  setSettingsBusy(false);
                }
              }}
            >
              Save recipient
            </Button>
          </div>
          <RepSmsSettings orgId={viewer.orgId} members={roster.members} />
        </details>
      )}
      {(target.notice ?? pinNotice) && (
        <div role="status" className="mb-4 rounded border p-3 text-sm">
          <span>{target.notice ?? pinNotice}</span>{" "}
          {target.propertyId && (
            <a
              href={retryHref ?? undefined}
              className="font-bold underline underline-offset-4"
            >
              Retry
            </a>
          )}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-4 rounded border border-destructive p-3 text-destructive"
        >
          {error}{" "}
          <Button variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      )}
      {refreshError && (
        <div
          role="alert"
          className="mb-4 rounded border border-destructive p-3 text-destructive"
        >
          {refreshError} Displayed counts may be out of date. Retrying
          automatically.{" "}
          <Button variant="outline" onClick={() => void refresh()}>
            Retry now
          </Button>{" "}
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload and reconnect
          </Button>
        </div>
      )}
      {dialpad && roster.settings.enabled && (
        <DialpadPanel
          bootstrap={dialpad}
          callRequest={dialpadRequest}
          onCallRequestHandled={onCallRequestHandled}
          onRecordingFinalResult={() => {
            void refresh(true);
          }}
          onLogOutcome={(propertyId, callActivityId) => {
            if (!rawRow(propertyId)) {
              setError("This lead is no longer in your queue.");
              return;
            }
            action("log-attempt", propertyId, callActivityId);
          }}
        />
      )}
      {!roster.settings.enabled ? (
        <p>My Leads is not enabled yet.</p>
      ) : !pages || !kpis || !tiles ? (
        <p role="status">Loading My Leads…</p>
      ) : (
        <>
          <MyLeadsQueue
            canSelectRep={viewer.isOwner}
            stages={pages}
            drips={view?.drips ?? drips}
            kpis={tiles}
            search={search}
            selectedRepId={member}
            onReviewingChange={onReviewingChange}
            detailRevision={detailRevision}
            focusPropertyId={target.propertyId}
            focusNonce={target.nonce}
            pinnedRow={pinnedView}
            repOptions={roster.members
              .filter(
                (m) =>
                  m.acquisitionsEnabled ||
                  m.hasHistory ||
                  m.id === viewer.userId,
              )
              .map((m) => ({
                id: m.id,
                label:
                  m.label +
                  (m.acquisitionsEnabled ? "" : " — Acquisitions disabled"),
              }))}
            selectedRepLabel={
              roster.members.find((m) => m.id === member)?.label
            }
            onSearchChange={(value) => {
              clearFocus();
              setSearch(value);
            }}
            onRepChange={(value) => {
              clearFocus();
              setMember(value);
            }}
            onLoadMore={async (stage) => {
              const cursor = snapshot?.stages[stage]?.cursor;
              if (!cursor || loadingStages.has(stage)) return;
              const id = request.current;
              setLoadingStages((previous) => new Set(previous).add(stage));
              try {
                const result = await loadMyLeadsStage({
                  memberId: member,
                  search,
                  stage,
                  cursor,
                });
                if (id !== request.current) return;
                if (!result.ok) {
                  setError(result.message);
                  return;
                }
                const next = result.snapshot.stages[stage];
                if (next)
                  setSnapshot((previous) => {
                    if (!previous) return previous;
                    const rows = previous.stages[stage]?.rows ?? [];
                    const ids = new Set(rows.map((r) => r.propertyId));
                    return {
                      ...previous,
                      stages: {
                        ...previous.stages,
                        [stage]: {
                          ...next,
                          rows: [
                            ...rows,
                            ...next.rows.filter((r) => !ids.has(r.propertyId)),
                          ],
                        },
                      },
                    };
                  });
              } finally {
                setLoadingStages((previous) => {
                  const next = new Set(previous);
                  next.delete(stage);
                  return next;
                });
              }
            }}
            onLoadDetail={async (propertyId) => {
              const result = await loadMyLeadDetail({
                memberId: member,
                propertyId,
              });
              return result.ok
                ? { ok: true, detail: detailView(result.detail, roster) }
                : result;
            }}
            onLoadDetailPage={async (propertyId, group, cursor) => {
              const result = await loadMyLeadDetail({
                memberId: member,
                propertyId,
                group,
                cursor,
              });
              if (!result.ok) return result;
              const detail = detailView(result.detail, roster);
              switch (group) {
                case "messages":
                  return { ok: true, group, page: detail.messages };
                case "notes":
                  return { ok: true, group, page: detail.notes };
                case "attempts":
                  return { ok: true, group, page: detail.attempts };
                case "appointments":
                  return { ok: true, group, page: detail.appointments };
                case "offers":
                  return { ok: true, group, page: detail.offers };
                case "history":
                  return { ok: true, group, page: detail.history };
              }
            }}
            onLeadChanged={() => {
              void refresh();
              router.refresh();
            }}
            onStageAction={(kind, row) => action(kind, row.propertyId)}
          />

          {lastCheckedAt && (
            <p className="mb-2 text-sm text-muted-foreground">
              Counts update every 30 seconds while this page is visible. Last
              successful check:{" "}
              <time dateTime={lastCheckedAt}>
                {refreshTime.format(new Date(lastCheckedAt))}
              </time>
              .
              {reviewing
                ? " The lead list stays in place while details are open."
                : ""}
            </p>
          )}
          {search && (
            <p className="mb-2 text-sm text-muted-foreground">
              Section counts match your search. KPIs cover the selected rep.
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            {kpis.firstCallPending} first calls pending · {kpis.pendingOutcomes}{" "}
            call outcomes pending
            {kpis.orgAppointmentsUnattributed
              ? ` · ${kpis.orgAppointmentsUnattributed} appointments in this organization have unknown historical attribution`
              : ""}
          </p>
        </>
      )}
      <WorkflowRecoveryContext.Provider value={recoveryValue}>
        {common && dialog?.action === "log-attempt" && (
          <AcquisitionAttemptDialog
            {...common}
            onSubmit={(payload) => submit(payload)}
            onDripChanged={onDripChanged}
            key={`${dialog.row.propertyId}:${dialog.callActivityId ?? ""}`}
            initialCallActivityId={dialog.callActivityId ?? null}
            callReferenceOptions={
              callOptions?.propertyId === dialog.row.propertyId
                ? callOptions.options
                : []
            }
            callReferencesLoading={!callOptions}
            callReferencesError={callOptions?.error}
            onRetryCallReferences={() => setCallRetry((value) => value + 1)}
          />
        )}
        {common && dialog?.action === "ready-for-offer" && (
          <AcquisitionReadinessDialog
            {...common}
            onSubmit={(payload) => submit(payload)}
            initialTemperature={dialog.row.temperature}
            initialMotivationResponse={motivation}
          />
        )}
        {common && dialog?.action === "log-offer" && (
          <AcquisitionOfferDialog
            {...common}
            onSubmit={(payload) => submit(payload)}
            motivationRequired={!motivation}
            initialTemperature={dialog.row.temperature}
            initialMotivationResponse={motivation}
          />
        )}
        {common &&
          dialog &&
          ["contract-signed", "decline-offer", "handoff", "archive"].includes(
            dialog.action,
          ) && (
            <AcquisitionLifecycleDialog
              {...common}
              onSubmit={(payload) => submit(payload)}
              mode={dialog.action as AcquisitionLifecycleMode}
              pendingOfferId={
                dialog.row.offer?.outcome === "pending"
                  ? dialog.row.offer.id
                  : null
              }
              recipientOptions={
                roster.settings.recipient
                  ? [roster.settings.recipient]
                  : roster.settings.recipientId
                    ? roster.members
                        .filter((m) => m.id === roster.settings.recipientId)
                        .map((m) => ({ id: m.id, label: m.label }))
                    : []
              }
              initialRecipientUserId={
                roster.settings.recipient?.id ??
                roster.settings.recipientId ??
                ""
              }
            />
          )}
      </WorkflowRecoveryContext.Provider>
      {dialog?.action === "schedule-next-step" && (
        <div className="fixed bottom-6 right-6 z-50 rounded-xl border bg-background p-5 shadow-lg">
          <p className="mb-3 font-medium">{dialog.row.address}</p>
          <BookAppointmentPopover
            propertyId={dialog.row.propertyId}
            subjectLabel={dialog.row.address}
            currentUserId={member}
            onBooked={() => {
              setDialog((current) => (current === dialog ? null : current));
              setDetailRevision((revision) => revision + 1);
              void refresh();
            }}
          />
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Close
          </Button>
        </div>
      )}
    </>
  );
}
