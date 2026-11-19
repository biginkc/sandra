/**
 * Jarrad-approved drip texts, copied VERBATIM (original fixed times included) from the vault note
 * "2026-10-29 — Sandra SMS reply routing plan (Jev + Haiku).md", section "Approved drips".
 * This file is the pin source for the routing v2 drip seed (PR-C). Never edit a string here
 * without Jarrad's verbatim approval of the exact new text.
 *
 * Approved change (SELF-APPROVED-TEXT-LOG row 6, Master A-003 under Jarrad's delegation,
 * 2026-10-30): Price too high #2 (day 75) shortened to its approved new text below.
 */
export const APPROVED_DRIPS = {
  price_too_high: [
    "Hey, it's Mel. We discussed {{property_address}} in today's meeting. Bummer the numbers didn't work. Okay to stay in touch in case anything changes?",
    "Hi {{first_name | there}}, Mel with BMH. Any flexibility on your price for {{property_address}}?",
    "Hey, Mel again. We're still buying in your area. Would you be open to revisiting an offer on {{property_address}}?",
    "Hi {{first_name | there}}, we've set aside funds for a couple more purchases. Is your number on {{property_address}} still firm?",
    "Hey, Mel here. Checking back on {{property_address}}. Has anything changed on your price?",
    "Hi {{first_name | there}}, we just added capital for new purchases. Open to talking numbers on {{property_address}} again?",
    "Hey, Mel at BMH Group. Last check-in for now on {{property_address}}. Any wiggle room on price, or should I check back later?",
  ],
  book_appointment_first6: [
    // Steps 1, 2 and 4: approved replacement texts (SELF-APPROVED-TEXT-LOG row 8, Master A-005,
    // Jarrad-delegated). They carry {{slot_time}} directly.
    "Hey, Mel here. Can we talk about {{property_address}} at {{slot_time}}?",
    "Hi {{first_name | there}}, can I hold {{slot_time}} for a call about {{property_address}}?",
    "Hey, Mel here. We're booked solid today, but I can squeeze you in at 11:30 this morning. Should I put you down?",
    "Hi {{first_name | there}}, want to talk about {{property_address}} at {{slot_time}}?",
    "Hey, just had a 1:30 cancel today. Want me to grab it for a quick call about {{property_address}}?",
    "Hi {{first_name | there}}, last open spot I have today is 3:00. Want it for a quick call about {{property_address}}?",
  ],
  said_theyd_call: [
    "Hey, it's Mel. Our calendar is pretty full, but I can squeeze in a quick call about {{property_address}} at 2:30 today. Would that work?",
    "Hi {{first_name | there}}, Mel again. We had an opening come up at 1:15 today. Want me to grab it for a quick call about {{property_address}}?",
    "Hey, I can squeeze you in at 4:45 this afternoon before we wrap up. Want that spot?",
    "Hi {{first_name | there}}, schedule's tight today, but I can hold 4:15 this afternoon for a quick call about {{property_address}}. Should I hold it?",
    "Hey, Mel here. Just had a 3:30 cancel today. Want me to put you in that spot for a quick call?",
    "Hi {{first_name | there}}, we're booked most of today, but I saved one afternoon slot at 2:45 for {{property_address}}. Want it?",
  ],
  vacant_land: [
    "Hey, it's Mel. Thanks for clearing that up. I'll let acquisitions know {{property_address}} is a vacant lot. Would you sell it for the right price?",
    "Hey, it's Mel. Acquisitions is looking at vacant lots near {{property_address}}. Is yours still available?",
    "Hey, it's Mel. Still interested in the vacant lot at {{property_address}}. Do you have a price in mind?",
    "Hey, it's Mel. Checking back on the vacant lot at {{property_address}}. Has anything changed on your end?",
    "Hey, it's Mel at BMH Group. Still happy to make a cash offer on the vacant lot at {{property_address}} if it makes sense.",
  ],
  listed_not_selling_day2: "Hey, I just heard back from underwriting. It came in lower than you and I were hoping. I'm going to keep poking them to see if I can get them up on the offer.",
} as const;
