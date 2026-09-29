import { Kanban, type Lead } from "@/app/(dashboard)/leads/kanban";
import type { PropertyStatus } from "@/app/(dashboard)/leads/actions";
import { activeLeadDrip } from "../_fixtures";
import { DripPreviewShell } from "../_preview-shell";

function lead(id: string, address: string, status: Lead["status"], motivation: Lead["motivation_level"]): Lead {
  return {
    id, address, status, motivation_level: motivation,
    city: "Kansas City", state: "MO", zip: "64111", market: "Jackson County MO",
    is_vacant: false, cass_status: "verified", absentee_flag: false,
    assigned_user_id: "brand-rep", outreach_dispo: "needs_sequence",
    homeowner_sms_opted_out: false, homeowner_sms_opted_out_at: null,
    homeowner: { first_name: "Taylor", last_name: "Seller", entity_name: null },
    has_unread: false, next_task_id: null, next_task_title: null, next_task_due_at: null,
  } as Lead;
}

const leads = [
  lead("brand-lead", "12 Oak Hill Cluster", "new_lead", "warm"),
  lead("brand-new-2", "1408 E 33rd St", "new_lead", "warm"),
  lead("brand-contacted", "527 SW Shadow Glen Dr", "contacted", "hot"),
  lead("brand-interested", "421 N 9th St", "interested", "hot"),
  lead("brand-interested-2", "11912 White Oak St", "interested", "warm"),
];
const totals: Record<PropertyStatus, number> = { prospect: 0, new_lead: 2, contacted: 1, interested: 2, offer_sent: 0, offer_declined: 0, under_contract: 0, closed: 0, dead: 0 };

export default function LeadsBoardDripPreview() {
  return <DripPreviewShell title="Leads" description="Drag to move leads through the pipeline.">
    <Kanban
      initialLeads={leads} initialTotals={totals} initialBaselineTotals={totals}
      initialUrgencyCounts={{ all: 5, overdue: 0, today: 0, scheduled: 0, none: 5 }}
      initialNextCursors={{}} initialHasMore={{}} initialSnapshotGenerations={{}}
      initialFilters={{ search: "", ownership: "all", motivation: "all", urgency: "all", attention: null, hotOnly: false, noActiveSequence: false, skipTraced: null }}
      dayStart="2026-09-29T05:00:00Z" dayEnd="2026-09-30T05:00:00Z"
      unreadPropertyIds={[]} assigneeEmails={{ "brand-rep": "teammate@example.com" }}
      teamMembers={[{ id: "brand-rep", email: "teammate@example.com" }]}
      currentUserId="brand-rep" listMemberships={{}} customTags={{}} lastMessageByPropertyId={{}}
      renderedAt="2026-09-29T14:00:00Z"
      initialDripsByLead={{ "brand-lead": { ...activeLeadDrip, step: 2 }, "brand-interested-2": { ...activeLeadDrip, propertyId: "brand-interested-2", step: 3 } }}
      previewBoardData={{
        leads, totals, baselineTotals: totals,
        urgencyCounts: { all: 5, overdue: 0, today: 0, scheduled: 0, none: 5 },
        nextCursors: {}, hasMore: {}, snapshotGenerations: {},
        unreadPropertyIds: [], listMemberships: {}, customTags: {}, lastMessageByPropertyId: {}, latestContractByPropertyId: {},
      }}
    />
  </DripPreviewShell>;
}
