import type { SequenceWithSteps } from "@/app/(dashboard)/sequences/actions";

export const editorFixture: SequenceWithSteps = {
  id: "11111111-1111-4111-8111-111111111111", name: "Quiet owner check-in",
  description: "4 texts over 90 days for leads who went quiet after a real conversation.",
  active: true, append_opt_out: true, archived_at: null,
  steps: [
    { id: "11111111-1111-4111-8111-111111111101", step_index: 0, delay_after_previous_minutes: 0,
      action_type: "send_sms", template_body: "Hi {{first_name}}, it's Jarrad with BMH. Still thinking about {{property_address}}? Happy to answer any questions, no pressure.", template_id: null, target_status: null },
    { id: "11111111-1111-4111-8111-111111111102", step_index: 1, delay_after_previous_minutes: 10080,
      action_type: "send_sms", template_body: "Hi {{first_name}}, checking back on {{property_address}}. If the timing has changed, I can put a fresh number together this week.", template_id: null, target_status: null },
    { id: "11111111-1111-4111-8111-111111111103", step_index: 2, delay_after_previous_minutes: 30240,
      action_type: "send_sms", template_body: "Still interested in talking about {{property_address}}? Reply whenever it works for you.", template_id: null, target_status: null },
    { id: "11111111-1111-4111-8111-111111111104", step_index: 3, delay_after_previous_minutes: 86400,
      action_type: "send_sms", template_body: "Last check-in from me. If you'd like to talk later, just reply here.", template_id: null, target_status: null },
  ],
};
