/** Test-only: an in-memory stand-in for fn_my_leads_work_page / fn_my_leads_work_facts. */
import type { QueueRow } from "@/lib/my-leads/queries";
import type { UnifiedInitial, WorkFacts, WorkPage, WorkQuery, WorkTab, WorkReason, WorkStage } from "./contract";
import { placementMatches } from "./work-queue-state";

export function mkFacts(id: string, over: Partial<WorkFacts> = {}): WorkFacts {
  return {
    propertyId: id,
    stage: "contacted",
    place: "your_move",
    reason: "new_reply",
    rowNo: "5",
    reasonAt: null,
    headline: {},
    drip: null,
    nextStep: null,
    lastTouchAt: null,
    attemptsCount: 0,
    assignedAt: null,
    latestInbound: null,
    hasPhone: true,
    contactDnc: false,
    broken: [],
    aiDraftId: null,
    labels: [],
    zip: null,
    contractSignedAt: null,
    lastTouch: null,
    row: { propertyId: id } as QueueRow,
    ...over,
  };
}

export const Q = (over: Partial<WorkQuery> = {}): WorkQuery => ({
  tab: "needs_attention",
  chip: "all",
  stage: null,
  search: "",
  page: 1,
  ...over,
});

type FakeLead = { id: string; base: Partial<WorkFacts>; flipAt?: number; flipTo?: Partial<WorkFacts> };

export function makeServer(size = 25, now: () => number = Date.now) {
  let leads: FakeLead[] = [];
  const factsOf = (l: FakeLead): WorkFacts =>
    mkFacts(l.id, l.flipAt !== undefined && now() >= l.flipAt ? { ...l.base, ...l.flipTo } : l.base);

  const server = {
    size,
    add(id: string, base: Partial<WorkFacts> = {}, at?: number, extra: Partial<FakeLead> = {}) {
      const lead: FakeLead = { id, base, ...extra };
      if (at === undefined) leads.push(lead);
      else leads.splice(at, 0, lead);
      return server;
    },
    addMany(prefix: string, n: number, base: Partial<WorkFacts> = {}) {
      for (let i = 1; i <= n; i++) server.add(`${prefix}${i}`, base);
      return server;
    },
    set(id: string, patch: Partial<WorkFacts>) {
      const l = leads.find((x) => x.id === id)!;
      l.base = { ...l.base, ...patch };
    },
    flip(id: string, flipAt: number, flipTo: Partial<WorkFacts>) {
      const l = leads.find((x) => x.id === id)!;
      l.flipAt = flipAt;
      l.flipTo = flipTo;
    },
    remove(id: string) {
      leads = leads.filter((l) => l.id !== id);
    },
    page(query: WorkQuery): WorkPage {
      const all = leads.map(factsOf);
      const eligible = all.filter((f) => placementMatches(f, query));
      const pages = Math.max(1, Math.ceil(eligible.length / size));
      const page = Math.min(Math.max(1, query.page), pages);
      const slice = eligible.slice((page - 1) * size, page * size);
      const inTab = (tab: WorkTab) => all.filter((f) => placementMatches(f, { ...query, tab, chip: "all", stage: null }));
      const chipCounts: Partial<Record<WorkReason, number>> = {};
      for (const f of all.filter((x) => placementMatches(x, { ...query, chip: "all", stage: null })))
        chipCounts[f.reason] = (chipCounts[f.reason] ?? 0) + 1;
      const stageCounts: Partial<Record<WorkStage, number>> = {};
      for (const f of all.filter((x) => placementMatches(x, { ...query, stage: null })))
        stageCounts[f.stage] = (stageCounts[f.stage] ?? 0) + 1;
      const future = leads.map((l) => l.flipAt).filter((t): t is number => t !== undefined && t > now());
      return {
        rows: slice,
        ids: slice.map((f) => f.propertyId),
        total: eligible.length,
        page,
        pageSize: size,
        tabCounts: {
          needs_attention: inTab("needs_attention").length,
          waiting: inTab("waiting").length,
          all: inTab("all").length,
        },
        chipCounts,
        stageCounts,
        revision: eligible.map((f) => f.propertyId).join("|"),
        nextChangeAt: future.length ? new Date(Math.min(...future)).toISOString() : null,
        snapshotAt: new Date(now()).toISOString(),
      };
    },
    facts(ids: string[]) {
      const all = new Map(leads.map((l) => [l.id, factsOf(l)]));
      return {
        rows: ids.filter((i) => all.has(i)).map((i) => all.get(i)!),
        missing: ids.filter((i) => !all.has(i)),
        snapshotAt: new Date(now()).toISOString(),
      };
    },
    initial(query: WorkQuery, pinned: WorkFacts | null = null): UnifiedInitial {
      return { query, page: server.page(query), error: null, kpis: null, pinned };
    },
  };
  return server;
}
