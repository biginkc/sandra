import {
  NEEDS_ATTENTION_CHIPS,
  WAITING_CHIPS,
  WORK_TABS,
  type WorkChip,
  type WorkQuery,
  type WorkStage,
  type WorkTab,
} from "./contract";

/** URL keys: tab, chip, stage, q, page. Defaults are omitted so the plain /my-leads URL is the default view. */
export const DEFAULT_WORK_QUERY: WorkQuery = { tab: "needs_attention", chip: "all", stage: null, search: "", page: 1 };

const STAGES: readonly WorkStage[] = ["not_contacted", "contacted", "needs_offer", "offer_sent", "under_contract"];
const MAX_SEARCH = 200;
const MAX_PAGE = 100_000;

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined> | null | undefined;

function first(source: ParamSource, key: string): string | undefined {
  if (!source) return undefined;
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const value = source[key];
  return Array.isArray(value) ? value[0] : value;
}

export function chipsForTab(tab: WorkTab): readonly WorkChip[] {
  if (tab === "needs_attention") return NEEDS_ATTENTION_CHIPS;
  if (tab === "waiting") return WAITING_CHIPS;
  return ["all"];
}

/** Reads the work-queue state from search params. Anything invalid falls back to its default. */
export function parseWorkQuery(source: ParamSource): WorkQuery {
  const rawTab = first(source, "tab");
  const tab = (WORK_TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as WorkTab) : DEFAULT_WORK_QUERY.tab;
  const rawChip = first(source, "chip");
  const chip = rawChip !== undefined && chipsForTab(tab).includes(rawChip as WorkChip) ? (rawChip as WorkChip) : "all";
  const rawStage = first(source, "stage");
  const stage = rawStage !== undefined && (STAGES as readonly string[]).includes(rawStage) ? (rawStage as WorkStage) : null;
  const search = (first(source, "q") ?? "").trim().slice(0, MAX_SEARCH).trim();
  const rawPage = first(source, "page");
  const parsed = rawPage !== undefined && /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
  const page = Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, MAX_PAGE) : 1;
  return { tab, chip, stage, search, page };
}

/** The URL form of a query; values equal to their default are left out. */
export function workQueryToSearchParams(query: WorkQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.tab !== DEFAULT_WORK_QUERY.tab) params.set("tab", query.tab);
  if (query.chip !== "all") params.set("chip", query.chip);
  if (query.stage) params.set("stage", query.stage);
  const search = query.search.trim().slice(0, MAX_SEARCH);
  if (search) params.set("q", search);
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}
