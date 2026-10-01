import { DripCard } from "@/app/(dashboard)/leads/[id]/drip-card";
import { MessageBubble, type Message } from "@/app/(dashboard)/leads/[id]/messages-thread";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { activeLeadDrip } from "./_fixtures";
import { DripPreviewShell } from "./_preview-shell";

const texts = [
  "Hi Kaylem, Mel with BMH. Thanks for chatting about the house today. I'll check back in a couple weeks. Reply STOP to opt out.",
  "Hi Kaylem, still here if the timing on White Oak changes. Any questions I can answer? Reply STOP anytime and I'll stop.",
  "Quick check-in on White Oak — happy to put a number together whenever you're ready. Say STOP if this isn't a fit.",
];

export function LeadFixture({ inDrip }: { inDrip: boolean }) {
  return <DripPreviewShell title="11912 White Oak St" description="MO · Mel Luce · Street view unavailable" actions={<div className="flex gap-1"><Button size="sm">Call</Button><Button variant="outline" size="sm">Send SMS</Button><Button variant="outline" size="sm">Book appt</Button><Button variant="outline" size="sm">Zillow</Button><Button variant="outline" size="sm">Send for signature</Button></div>}>
    <div className="mb-3 rounded-xl border bg-card p-3">
      <div className="grid grid-cols-5 gap-2">{["Equity (est.)", "ARV", "Repair est.", "Mortgage bal.", "Property"].map((name) => <div key={name} className="rounded-lg border p-3"><div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{name}</div><div className="text-xl">—</div></div>)}</div>
      <div className="mt-3 flex gap-2"><Badge variant="outline">Contacted</Badge><Badge variant="outline">Motivation</Badge><Badge variant="outline">Mel Luce</Badge><Badge variant="outline">No next action</Badge></div>
    </div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-h-[680px] border-l border-border pl-5 pt-1">
        {texts.map((body, index) => {
          const message = { id: `brand-message-${index}`, direction: "outbound", body, created_at: `2026-09-${index === 0 ? "17" : index === 1 ? "24" : "29"}T14:02:00Z`, status: "sent" } as Message;
          return <div key={message.id} className="mb-5"><MessageBubble message={message} isContinuation={false} isLastInGroup isMostRecentOutbound={index === 2} presentation="timeline" dripLabel={inDrip ? `Drip · 90-day follow-up · text ${index + 1} of 4` : null} /></div>;
        })}
      </div>
      <div className="space-y-3">
        <DripCard propertyId="brand-lead" initialProgress={inDrip ? activeLeadDrip : null} />
        <section className="rounded-xl border bg-card p-3 text-xs"><h2 className="mb-2 font-bold">Files</h2><p className="text-muted-foreground">Documents saved for this lead.</p><p className="mt-2 text-muted-foreground">No files yet.</p></section>
        <section className="rounded-xl border bg-card p-3 text-xs"><div className="flex items-center justify-between"><h2 className="font-bold">Calculations</h2><Button variant="outline" size="sm">New calculation</Button></div><p className="mt-2 text-muted-foreground">No saved calculations yet.</p></section>
        <section className="rounded-xl border bg-card p-3 text-xs"><h2 className="mb-3 font-bold uppercase tracking-wider text-muted-foreground">Homeowner</h2><div className="flex justify-between"><span>Name</span><span>Kaylem Quinn</span></div><div className="mt-2 flex justify-between"><span>Phone</span><span>(555) 010-4477</span></div><p className="mt-3 text-muted-foreground">SMS consent · Informational only</p></section>
      </div>
    </div>
  </DripPreviewShell>;
}
