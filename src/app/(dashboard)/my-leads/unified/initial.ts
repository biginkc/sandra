import { reportError } from "@/lib/errors/report";
import {
  MY_LEAD_ROW_ERROR_COPY,
  MY_LEAD_ROW_FORBIDDEN_COPY,
  MY_LEAD_ROW_REASON_COPY,
} from "@/lib/my-leads/row-reasons";
import { getAcquisitionKpis, getMyLeadsQueueRow, MyLeadsReadError } from "@/lib/my-leads/queries";
import { getWorkFacts, getWorkPage } from "@/lib/my-leads/work-queue";

import type { MyLeadsFocus } from "../client";
import {
  selectedLeadUnavailableMessage,
  type MyLeadsSearchParams,
  type SelectedLeadResult,
} from "../deep-link";
import type { WorkFacts, WorkPage, WorkPlace, WorkQuery, WorkTab, UnifiedInitial } from "./contract";
import { parseWorkQuery } from "./query-params";

type SelectedLeadLink = { status: "none" } | { status: "invalid"; reason: "malformed" | "duplicate" } | { status: "requested"; propertyId: string };

/** The tab a deep-linked lead opens on, from where its move sits. */
export function tabForPlace(place: WorkPlace): WorkTab {
  return place === "your_move" ? "needs_attention" : place === "their_move" ? "waiting" : "all";
}

function report(operation: string, error: unknown) {
  reportError(error instanceof Error ? error : new Error(`${operation} failed`), {
    errorClass: "database",
    tags: { surface: "database", operation },
  });
}

const PAGE_ERROR = "My Leads could not load. Please retry.";

/**
 * The server read behind the first paint of the unified page: the WorkQuery from the URL, its first page,
 * today's KPIs and, for a valid ?lead= link, that lead's facts (which also choose the tab to open). Never
 * throws; a failed page read comes back as `page: null` plus an error string for the client's banner.
 */
export async function loadUnifiedInitial(input: {
  userId: string;
  searchParams: MyLeadsSearchParams;
  selectedLeadLink: SelectedLeadLink;
  retryHref: string;
}): Promise<{ unified: UnifiedInitial; selectedLead: SelectedLeadResult; focus: MyLeadsFocus | null }> {
  const { userId, selectedLeadLink, retryHref } = input;
  let query: WorkQuery = parseWorkQuery(input.searchParams);

  const kpisRead = getAcquisitionKpis({ memberId: userId, period: "today" }).catch((error) => {
    report("my_leads_unified_kpis", error);
    return null;
  });

  let selectedLead: SelectedLeadResult =
    selectedLeadLink.status === "none"
      ? { status: "none" }
      : selectedLeadLink.status === "invalid"
        ? selectedLeadLink
        : { status: "unavailable", propertyId: selectedLeadLink.propertyId, message: "This lead is unavailable in your My Leads queue.", retryHref };
  let focus: MyLeadsFocus | null =
    selectedLeadLink.status === "invalid"
      ? {
          propertyId: null,
          memberId: userId,
          notice:
            selectedLeadLink.reason === "duplicate"
              ? "This My Leads link contains more than one lead. Open a link with exactly one lead."
              : "This My Leads link is invalid. Open a link with a valid lead id.",
          pin: null,
        }
      : null;
  let pinned: WorkFacts | null = null;

  if (selectedLeadLink.status === "requested") {
    const id = selectedLeadLink.propertyId;
    try {
      const result = await getWorkFacts(userId, [id]);
      const facts = result.rows.find((row) => row.propertyId.toLowerCase() === id) ?? null;
      if (facts) {
        pinned = facts;
        query = { tab: tabForPlace(facts.place), chip: "all", stage: null, search: "", page: 1 };
        selectedLead = { status: "found", propertyId: id, row: facts.row, snapshotAt: result.snapshotAt };
        focus = { propertyId: id, memberId: userId, notice: null, pin: facts.row };
      } else {
        ({ selectedLead, focus } = await explainMissingLead(userId, id, retryHref));
      }
    } catch (error) {
      ({ selectedLead, focus } = leadReadFailure(userId, id, retryHref, error));
    }
  }

  let page: WorkPage | null = null;
  let error: string | null = null;
  try {
    page = await getWorkPage({ memberId: userId, query });
    // A requested page past the end comes back clamped; keep the URL state honest.
    if (page.page !== query.page) query = { ...query, page: page.page };
  } catch (readError) {
    report("my_leads_unified_page", readError);
    error = readError instanceof MyLeadsReadError && readError.code !== "READ_FAILED" ? readError.message : PAGE_ERROR;
  }

  return { unified: { query, page, error, kpis: await kpisRead, pinned }, selectedLead, focus };
}

/** The lead is not in the unified read: say why, with the same copy the old page uses. */
async function explainMissingLead(userId: string, id: string, retryHref: string) {
  try {
    const lookup = await getMyLeadsQueueRow({ memberId: userId, propertyId: id });
    if (lookup.status === "found" && lookup.row.propertyId.toLowerCase() === id) {
      const selectedLead: SelectedLeadResult = { status: "found", propertyId: id, row: lookup.row, snapshotAt: lookup.snapshotAt };
      const focus: MyLeadsFocus = { propertyId: id, memberId: userId, notice: null, pin: lookup.row };
      return { selectedLead, focus };
    }
    if (lookup.status === "unavailable") {
      const selectedLead: SelectedLeadResult = {
        status: ["archived", "no_active_episode"].includes(lookup.reason) ? "terminal" : "unavailable",
        propertyId: id,
        message: selectedLeadUnavailableMessage(lookup.reason),
        retryHref,
      };
      const focus: MyLeadsFocus = {
        propertyId: id, memberId: userId, notice: MY_LEAD_ROW_REASON_COPY[lookup.reason], pin: null, pinStatus: "unavailable", retryHref,
      };
      return { selectedLead, focus };
    }
    return leadReadFailure(userId, id, retryHref, new Error("unexpected lookup"));
  } catch (error) {
    return leadReadFailure(userId, id, retryHref, error);
  }
}

function leadReadFailure(userId: string, id: string, retryHref: string, error: unknown) {
  if (error instanceof MyLeadsReadError && ["FORBIDDEN", "INVALID_INPUT", "NOT_FOUND", "UNAUTHENTICATED"].includes(error.code)) {
    const selectedLead: SelectedLeadResult = { status: "unavailable", propertyId: id, message: "This lead is unavailable in your My Leads queue.", retryHref };
    const focus: MyLeadsFocus = {
      propertyId: id,
      memberId: userId,
      notice: error.code === "FORBIDDEN" ? MY_LEAD_ROW_FORBIDDEN_COPY : MY_LEAD_ROW_REASON_COPY.not_found,
      pin: null,
      pinStatus: "unavailable",
      retryHref,
    };
    return { selectedLead, focus };
  }
  report("my_leads_unified_lead", error);
  const selectedLead: SelectedLeadResult = { status: "error", propertyId: id, message: "We couldn't check this lead right now.", retryHref };
  const focus: MyLeadsFocus = { propertyId: id, memberId: userId, notice: MY_LEAD_ROW_ERROR_COPY, pin: null, pinStatus: "failed", retryHref };
  return { selectedLead, focus };
}
