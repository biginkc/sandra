import type { DripDetail } from "@/app/(dashboard)/sequences/[id]/detail-data";
import { sampleSequences } from "./_sample";

const steps = Array.from({ length: 6 }, (_, index) => ({
  id: `step-${index + 1}`, step_index: index, delay_after_previous_minutes: index === 0 ? 0 : 10080,
  action_type: "send_sms" as const, template_body: [
    "Hi {{first_name}}, it's Jarrad with BMH. Still thinking about selling?",
    "Checking back on {{property_address}}. Happy to talk when you're ready.",
    "Quick note: we just closed on a house nearby. Want to compare options?",
    "Is now a better time to talk about your plans for the property?",
    "Just checking whether the timing has changed for you.",
    "Last check-in from me. Reply any time if you'd like to revisit this.",
  ][index], template_id: null, template_category: null, target_status: null,
}));
const names = ["Marisol Vega", "Terrence Okafor", "Beverly Hanks", "Ray Delacroix", "June Castellano", "Harold Nkemelu", "Angela Whitcomb", "Dwayne Ferris"];
const addresses = ["4127 Hollister Ave", "918 Linwood Blvd", "2203 S 47th St", "7011 Ward Pkwy", "510 E 31st St", "1440 Quindaro Blvd", "3320 Gillham Rd", "85 N Elmwood Ave"];
const statuses = ["Waiting", "Replied", "Waiting", "Finished, no reply", "Stopped", "Couldn’t send", "Waiting", "Stopped"];

export const sampleDetail: DripDetail = {
  sequence: { id: sampleSequences[0].id, name: "Quiet owner check-in", description: "A thoughtful check-in over six weeks.", active: true, append_opt_out: true, archived_at: null, steps },
  stats: steps.map((step, index) => ({ step_id: step.id, sent: [77, 51, 36, 24, 17, 9][index], replied: [4, 3, 1, 1, 0, 0][index], waiting: [20, 10, 8, 4, 2, 0][index] })),
  peopleCount: 77,
  people: names.map((name, index) => ({ enrollmentId: `enrollment-${index}`, propertyId: `property-${index}`, threadId: `contact-${index}`, name, address: addresses[index], status: statuses[index],
    detail: index === 1 ? "Lead replied to a drip text." : index === 5 ? "Text provider could not send this step." : null,
    step: [2, 1, 1, 6, 3, 2, 3, 2][index], nextRunAt: statuses[index] === "Waiting" ? "2026-10-16T14:00:00.000Z" : null,
    canAct: ["Waiting", "Replied", "Couldn’t send"].includes(statuses[index]) })),
};
