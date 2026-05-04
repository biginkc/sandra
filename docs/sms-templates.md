# SMS Template Library: Sandra CRM

Curated SMS templates for two audiences: **distressed homeowners** (cold outreach + reply handlers) and **listing agents** (acquisition + reply handlers). Patterns synthesized from publicly-available scripts and frameworks used by Brent Daniels (TTP), Pace Morby (SubTo), Jerry Norton, Steve Trang (Objection Proof), Zack Boothe (DFD Mastery), Max Maxwell, King Khang, Kyle Krason, Lili Thompson, Danny B., plus platform-published templates from BatchLeads, Launch Control, REI Reply, REI/kit, DealMachine, SimpleTexting, RealEstateSkills, PropertyLeads, and Carrot. Compliance guidance reflects the carrier and FCC landscape as of mid-2025.

Source URLs are listed in the "References" section at the end so any template can be traced back to the pattern it's based on.

---

## How these templates use the Sandra variable system

The renderer in `src/lib/templates/render.ts` supports three things:

1. **Variable substitution:** `{{first_name}}`, pulls from the contact/property record. Missing or null variables render as blank.
2. **Pipe fallback:** `{{first_name | there}}`, substitutes the fallback when the variable is null, missing, or empty. **Use this for every greeting** so cold lists with bad name data don't render "Hi ,".
3. **Conditional blocks:** `{{#if first_name}}Hi {{first_name}}, {{/if}}hello`, drops an entire block if the variable is falsy. Useful when surrounding punctuation would look weird without the variable.

**Variables actually wired up** (from `src/lib/templates/variables.ts`):

| Group   | Name                | Example value         |
| ------- | ------------------- | --------------------- |
| Contact | `first_name`        | John                  |
| Contact | `last_name`         | Smith                 |
| Property| `property_address`  | 123 Main St           |
| Property| `city`              | Dallas                |
| Property| `state`             | TX                    |
| Property| `property_zip`      | 75201                 |
| Property| `market`            | DFW                   |
| Account | `my_first_name`     | Sarah                 |
| Account | `company_name`      | Big Ink Consulting    |

If you need anything beyond these (e.g. an `agent_first_name` distinct from `first_name`, or a `street_only` variant), add it to `TEMPLATE_VARIABLES` first, unknown variables silently render as blank, which is a footgun for cold-list templates.

---

## The single most important finding before you write any cold opener

The carrier rules changed materially in 2025 and most "guru" content predates the change.

- **A2P 10DLC registration is mandatory.** Since Feb 1, 2025, US carriers (Verizon, T-Mobile, AT&T) block, not throttle, 100% of unregistered traffic. Brand + each campaign use-case must be registered with The Campaign Registry.
- **Touch-1 cold openers cannot contain filtered keywords.** BatchLeads' published filter list (and broadly accurate across the major carriers): _interested, selling, offer, property, cash, local investor, purchase, looking, mortgage, loan, insurance, debt, lend, buy, buying, sell._ Templates containing any of these in touch 1 will be filtered. Once the recipient **replies**, you're "in conversation" and these words become safe.
- **TCPA "express written consent" is required for marketing messages** sent through any platform that qualifies as an autodialer. The Sandra composer already gates on `blocked_no_consent` and supports operator-attested consent capture, that's the right pattern. A cold list without consent should never be sent into; capture consent at the form/landing-page/recorded-call stage and record it via the existing `captureConsent` action before any template ships.
- **FCC revocation rule (effective April 11, 2025):** any common opt-out word, STOP, CANCEL, UNSUBSCRIBE, REMOVE, QUIT, END, OPT OUT, "stop texting," "leave me alone," "take me off the list", must be honored within 10 business days, with at most a single confirmation reply within 5 minutes. After that, no marketing to that number across any campaign.
- **Quiet hours:** no sends before 8am or after 9pm recipient-local time (CTIA standard, carrier-enforced).
- **Template variation:** rotate at least 10-20 variants of every recurring template so the carrier doesn't fingerprint your account as a bot. The duplicates below in each section are intentional, they're the variant pool, not "pick the best one."

---

## Patterns the top wholesalers converge on

These nine patterns showed up across 6+ independent sources:

1. **Lead with curiosity, not a pitch.** The dominant 2024-2025 cold opener is one ownership question and nothing else.
2. **Confirm ownership in touch 1, never pitch.** No "cash," no "offer," no "sell" until they reply.
3. **Acknowledge the awkwardness.** "Sorry to bother," "I know this is random," "out of the blue", softens the cold contact and is in nearly every coach's script.
4. **One question per text.** Multi-question texts get ignored. Yes/no or simple-answer questions get reply rates.
5. **Deflect price questions with condition questions** (Jerry Norton, Steve Trang). Quoting a number by text anchors the seller against you and kills the call.
6. **Wrong-number replies are referral opportunities** (King Khang, Call Porter). About 10-15% become referrals or turn out to be the right person.
7. **Persistence over 6-12 months.** Most deals close on touches 5-12. SalesMessage industry data: 80% of closed sales need 5+ follow-ups.
8. **SMS is the spark, the call is the close.** RealEstateSkills, REI Reply, Launch Control all converge: SMS reply → call within 60 minutes → email recap.
9. **For agents, present as INVESTOR-BUYER, not "wholesaler."** RealEstateSkills' agent playbook is explicit: leading with "wholesaler" kills the call. Lead with "active cash buyer in [area]" and offer dual-agency.

---

# Template Library

Each entry below is structured as `Name | Category | Content` so it can be imported directly into the templates table (`TemplateRow` in `src/app/(dashboard)/templates/actions.ts`). Names are kept under 120 characters per the validator. Categories use a small controlled vocabulary so the existing category Select stays clean.

## Category 1: `Outreach - Homeowner` (Initial cold openers, touch 1)

These are the touch-1 templates. **Every one of them is engineered to contain zero filtered keywords** so they get past carrier filters. Variation matters, rotate them, don't pick a favorite.

### Ownership confirm (BatchLeads consensus pattern)

> Are you the owner of {{property_address}}?

Why it works: pure curiosity, single yes/no, zero filtered words, under 60 characters with sample data. Highest-deliverability opener in the 2024-2025 carrier environment.

### Awkward + ownership (Brent Daniels / Kyle Krason pattern adapted to SMS)

> {{first_name | Hey there}}, sorry to bother. I think you might own {{property_address}}? - {{my_first_name}}

Why it works: "I think you might" is mildly assumptive without being aggressive. Self-identifies the sender. "Sorry to bother" disarms.

### Random acknowledgment (Lili Thompson / Danny B. pattern)

> Hi {{first_name | there}}, I know this is random. Looking for the owner of {{property_address}}. That you?

Why it works: "Random" is the highest-frequency disarmer across the top-10 cold scripts.

### Local + named sender

> {{first_name | Hi}}, {{my_first_name}} here in {{city | your area}}. Quick question: still own the place at {{property_address}}?

Why it works: Hyperlocal anchor builds credibility. "Still own" implies you've done research without being creepy.

### Soft owner-check

> Hey {{first_name | there}}, quick one - are you still tied to {{property_address}}? - {{my_first_name}}

Why it works: "Tied to" is intentionally vague and works for owners, executors, heirs, ex-spouses on title.

## Category 2: `Outreach - Homeowner` (Follow-up sequence)

Cadence (consensus across Launch Control, REI Reply, REI/kit, BatchLeads): **Day 0, Day 3, Day 8, Day 25, Day 50.** After that, recycle to a quarterly drip for up to 12 months.

### Touch 2, bump (Day 2-4)

> Hey {{first_name | there}}, didn't want my last text to get buried. Still you on {{property_address}}?

### Touch 3, soft close (Day 7-10)

> {{first_name | Hi}}, last try from me on {{property_address}}. Even a "wrong house" helps me close the loop.

### Touch 4, re-engage (Day 21-30)

> {{first_name | Hey}}, circling back on {{property_address}}. Anything change on your end? No pressure either way.

### Touch 5, break-up with opt-out (Day 45-60)

> {{first_name | Hi}}, I'll stop reaching out unless I hear back. Reply STOP to opt out anytime. - {{my_first_name}}

The break-up text is the **only** template that should mention STOP explicitly, including STOP in every text reduces deliverability. The auto-reply handler covers all the other revocation phrases.

## Category 3: `Reply - Homeowner` (Objection / question handlers)

Once the recipient has replied, the carrier "in-conversation" status relaxes filtering and you can use `cash`, `offer`, `sell`, etc.

### "Who are you?" / "Why are you texting me?"

> {{my_first_name}} here, local in {{city | your area}}. Small team that buys homes directly. Pulled your address from public records.

Pattern source: BatchLeads + RealEstateSkills. Identify, locate, intent, short. Transparency disarms.

### "Where did you get my number?"

> Fair question. Your number came up tied to {{property_address}} in public records. Want me to take you off the list?

Pattern source: Steve Trang's Objection Proof framework. Honesty + immediate offer to remove builds trust.

### "What's your offer?" / "How much?"

> Honestly depends a lot on condition. If you give me 2 min, beds/baths, any updates, I can usually get a ballpark same day.

Pattern source: Jerry Norton. Never quote a number by text. Pivot to discovery.

### "What's your offer?", creative-finance variant

> Depends on what works for you. Are you open to flexibility on terms, or strictly looking at a cash number?

Pattern source: Pace Morby SubTo angle. Useful when the lead source flagged underwater / behind on payments.

### "Wrong number" / "I don't own that"

> My apologies, I'll get you off the list right away. Quick favor though, any chance you know who owns {{property_address}}?

Pattern source: King Khang / Call Porter. Wrong-number replies are referral opportunities, not failures.

### "Not interested"

> All good, {{first_name | thanks for letting me know}}. If anything changes in the next 6-12 months, mind if I check back?

Pattern source: DealMachine + Tom Ferry adapted. Acknowledge, leave a date hook, never argue.

### "Not interested", discovery variant

> Got it. Out of curiosity, what would have to be true for you to consider an offer? No pressure, just helpful for me to know.

Pattern source: Steve Trang. Surfaces the real objection without re-pitching.

### "Stop" / "Take me off your list", auto-confirmation (one-time only)

> You're removed, sorry for the bother. Have a good one.

**Critical:** this should be the only message ever sent to this number after a STOP. The composer already supports per-channel consent state, make sure the SMS provider sets the contact's consent record to revoked the moment any STOP variant is detected, across all campaigns.

### "Are you a real person?" / "Is this a bot?"

> Real human, promise. {{my_first_name}} here. Want to hop on a quick call instead? Easier than texting.

Pattern source: emerging 2024-2025, no single coach owns this. Offering to switch to a call is the strongest scam-killer.

### "Is this a scam?"

> Fair question, there's a lot of junk out there. {{my_first_name}} with {{company_name}}, local to {{city | your area}}. Happy to talk first.

### "I already have a Realtor" / "It's listed"

> Got it, open to me sending a cash offer through your agent? Want to pass along their info?

Pattern source: DealMachine #10 + RealEstateSkills agent playbook. Don't fight the agent, work with them. Agent-listed homes are still wholesalable via dual-agency.

### "Send me something in writing"

> Happy to. To put a real number on paper I'd need a few details, what kind of condition is the place in?

Pattern source: Jerry Norton, Wholesaling Inc. "Send in writing" is often a stall, force discovery before you generate paper.

### "I owe more than it's worth"

> That's actually where creative options can help. Open to a quick call to see what'd work?

Pattern source: Pace Morby SubTo frame. Underwater sellers are highly motivated and often best fit for SubTo / seller financing.

### "It needs too much work"

> That's a plus on my end, I buy as-is, no repairs on you. Care if I take a quick look this week?

Pattern source: Jerry Norton. Reset their model: "needs work" qualifies the home, not disqualifies it.

### "I need to talk to my spouse / family"

> Of course, take the time you need. Has selling come up between you two before? Curious what they said.

Pattern source: Jennie Hudspeth (DealMachine). Surfaces whether the spouse is the real gatekeeper or the objection is polite-no.

### "Maybe, what kind of price?"

> Depends on condition + recent comps, usually a range until I see it. Got 5 min for a quick call so I can be specific?

Pattern source: Brent Daniels phone framework. Range, never a number. Force the call.

### "How fast can you close?"

> 7-14 days, all cash. Title sets the actual date but we don't drag our feet.

Pattern source: Jerry Norton value-prop. Speed is the #1 differentiator vs. agent listing, say it with a real number.

### "Send me email instead"

> Will do, what's the best email? I'll send a one-pager and details before we talk.

### "Can you call me?" / "Call me later"

> Absolutely, what's a good time today or tomorrow? I'll keep it under 5 minutes.

---

## Category 4: `Outreach - Agent` (Initial agent outreach)

Phone is the right first channel for listing agents (Brent Daniels' 2025 agent script + RealEstateSkills agent playbook), text is excellent for **follow-up after a missed call**. None of these should be the first attempt.

### Active listing, after missed call

> Hi {{first_name | there}}, {{my_first_name}} here, left you a VM on your listing at {{property_address}}. Active cash buyer locally, got 2 min?

### Expired listing

> Hi {{first_name}}, saw {{property_address}} expired. Active cash buyer in {{market | the area}}, interested if your seller is still open.

### Bump (Day 3)

> Hey {{first_name}}, circling back on {{property_address}}. Worth a quick chat? - {{my_first_name}}

### Break-up with opt-out

> Last bump on {{property_address}}, {{first_name}}. If it's not a fit, no worries, happy to be on your buyer list. Reply STOP to opt out.

---

## Category 5: `Reply - Agent` (Agent objection / question handlers)

### "Who are you with?" / "What brokerage?"

> {{my_first_name}} with {{company_name}}, active cash buyer in {{market | your area}}. Close fast, full co-op to listing side.

### "What's your buy box?"

> {{market | Local}} SFR + 2-4 unit, any condition. POF available. {{property_address}} caught my eye, still active?

### "Are you an agent? Are you licensed?"

> Principal buyer, not licensed. Open to dual-agency on this if you want, happy to do a buyer rep agreement either way.

Pattern source: RealEstateSkills 15-step framework. Dual-agency offer unlocks more agent deals than any other tactic.

### "Send me an email"

> Sure, what's the best address? I'll send POF, recent closings, and a number on {{property_address}}.

### "I already have multiple offers / cash buyers"

> Understood. Worth being a backup? I close fast and don't fall out. Either way, would love to be on your list for future inventory.

### "Proof of funds?"

> Sending now, what email is best? Bank letter or platform statement, your call.

### "How fast can you close? What contingencies?"

> 7-14 days, no financing or appraisal contingency. Brief inspection (3-5 days) for our records, no re-trade unless something major.

### "What about commission?"

> Full co-op to listing side, paid at close per the MLS. No haggling on your fee.

### "Not interested"

> All good, appreciate the reply. If anything comes across that needs a fast cash close, keep me in mind.

### "What's the offer on this one?"

> Need to see condition + run comps. Can I get inside this week? Same-day written offer once I've walked it.

---

## Category 6: `Compliance` (System-level / required)

### STOP confirmation (auto-fire from provider)

> You're removed, sorry for the bother. Have a good one.

### Identification (first message of every new conversation, if not in opener)

> {{my_first_name}} with {{company_name}}. Reply STOP to opt out.

Use this only as a postscript on the **first** outbound message in a new conversation, including it on every text reduces engagement and isn't required by the rule.

---

# Importable seed format

If you want to bulk-load these via a script (or paste them into a CSV) the rows below are the structured form. Pipe-delimited so it's diff-friendly:

```
NAME | CATEGORY | CONTENT
Owner check (consensus) | Outreach - Homeowner | Are you the owner of {{property_address}}?
Awkward owner check | Outreach - Homeowner | {{first_name | Hey there}}, sorry to bother. I think you might own {{property_address}}? - {{my_first_name}}
Random + owner check | Outreach - Homeowner | Hi {{first_name | there}}, I know this is random. Looking for the owner of {{property_address}}. That you?
Local sender + still own | Outreach - Homeowner | {{first_name | Hi}}, {{my_first_name}} here in {{city | your area}}. Quick question: still own the place at {{property_address}}?
Soft tied-to check | Outreach - Homeowner | Hey {{first_name | there}}, quick one - are you still tied to {{property_address}}? - {{my_first_name}}
Touch 2, bump | Outreach - Homeowner | Hey {{first_name | there}}, didn't want my last text to get buried. Still you on {{property_address}}?
Touch 3, soft close | Outreach - Homeowner | {{first_name | Hi}}, last try from me on {{property_address}}. Even a "wrong house" helps me close the loop.
Touch 4, re-engage | Outreach - Homeowner | {{first_name | Hey}}, circling back on {{property_address}}. Anything change on your end? No pressure either way.
Touch 5, break-up | Outreach - Homeowner | {{first_name | Hi}}, I'll stop reaching out unless I hear back. Reply STOP to opt out anytime. - {{my_first_name}}
Reply: Who are you | Reply - Homeowner | {{my_first_name}} here, local in {{city | your area}}. Small team that buys homes directly. Pulled your address from public records.
Reply: Where did you get my number | Reply - Homeowner | Fair question. Your number came up tied to {{property_address}} in public records. Want me to take you off the list?
Reply: What's your offer (deflect to condition) | Reply - Homeowner | Honestly depends a lot on condition. If you give me 2 min, beds/baths, any updates, I can usually get a ballpark same day.
Reply: What's your offer (terms variant) | Reply - Homeowner | Depends on what works for you. Are you open to flexibility on terms, or strictly looking at a cash number?
Reply: Wrong number / referral ask | Reply - Homeowner | My apologies, I'll get you off the list right away. Quick favor though, any chance you know who owns {{property_address}}?
Reply: Not interested (date hook) | Reply - Homeowner | All good, {{first_name | thanks for letting me know}}. If anything changes in the next 6-12 months, mind if I check back?
Reply: Not interested (discovery) | Reply - Homeowner | Got it. Out of curiosity, what would have to be true for you to consider an offer? No pressure, just helpful for me to know.
Reply: STOP confirmation | Compliance | You're removed, sorry for the bother. Have a good one.
Reply: Real person check | Reply - Homeowner | Real human, promise. {{my_first_name}} here. Want to hop on a quick call instead? Easier than texting.
Reply: Scam check | Reply - Homeowner | Fair question, there's a lot of junk out there. {{my_first_name}} with {{company_name}}, local to {{city | your area}}. Happy to talk first.
Reply: Already listed | Reply - Homeowner | Got it, open to me sending a cash offer through your agent? Want to pass along their info?
Reply: Send in writing (force discovery) | Reply - Homeowner | Happy to. To put a real number on paper I'd need a few details, what kind of condition is the place in?
Reply: Owe more than worth | Reply - Homeowner | That's actually where creative options can help. Open to a quick call to see what'd work?
Reply: Needs work | Reply - Homeowner | That's a plus on my end, I buy as-is, no repairs on you. Care if I take a quick look this week?
Reply: Need to talk to spouse | Reply - Homeowner | Of course, take the time you need. Has selling come up between you two before? Curious what they said.
Reply: Maybe what price (range pivot) | Reply - Homeowner | Depends on condition + recent comps, usually a range until I see it. Got 5 min for a quick call so I can be specific?
Reply: How fast | Reply - Homeowner | 7-14 days, all cash. Title sets the actual date but we don't drag our feet.
Reply: Send email | Reply - Homeowner | Will do, what's the best email? I'll send a one-pager and details before we talk.
Reply: Call me | Reply - Homeowner | Absolutely, what's a good time today or tomorrow? I'll keep it under 5 minutes.
Agent: Active listing post-VM | Outreach - Agent | Hi {{first_name | there}}, {{my_first_name}} here, left you a VM on your listing at {{property_address}}. Active cash buyer locally, got 2 min?
Agent: Expired listing | Outreach - Agent | Hi {{first_name}}, saw {{property_address}} expired. Active cash buyer in {{market | the area}}, interested if your seller is still open.
Agent: Bump | Outreach - Agent | Hey {{first_name}}, circling back on {{property_address}}. Worth a quick chat? - {{my_first_name}}
Agent: Break-up | Outreach - Agent | Last bump on {{property_address}}, {{first_name}}. If it's not a fit, no worries, happy to be on your buyer list. Reply STOP to opt out.
Agent reply: Who are you with | Reply - Agent | {{my_first_name}} with {{company_name}}, active cash buyer in {{market | your area}}. Close fast, full co-op to listing side.
Agent reply: Buy box | Reply - Agent | {{market | Local}} SFR + 2-4 unit, any condition. POF available. {{property_address}} caught my eye, still active?
Agent reply: Are you licensed | Reply - Agent | Principal buyer, not licensed. Open to dual-agency on this if you want, happy to do a buyer rep agreement either way.
Agent reply: Send email | Reply - Agent | Sure, what's the best address? I'll send POF, recent closings, and a number on {{property_address}}.
Agent reply: Multiple offers / backup | Reply - Agent | Understood. Worth being a backup? I close fast and don't fall out. Either way, would love to be on your list for future inventory.
Agent reply: POF | Reply - Agent | Sending now, what email is best? Bank letter or platform statement, your call.
Agent reply: Speed + contingencies | Reply - Agent | 7-14 days, no financing or appraisal contingency. Brief inspection (3-5 days) for our records, no re-trade unless something major.
Agent reply: Commission | Reply - Agent | Full co-op to listing side, paid at close per the MLS. No haggling on your fee.
Agent reply: Not interested | Reply - Agent | All good, appreciate the reply. If anything comes across that needs a fast cash close, keep me in mind.
Agent reply: Offer on this one | Reply - Agent | Need to see condition + run comps. Can I get inside this week? Same-day written offer once I've walked it.
First-message identification | Compliance | {{my_first_name}} with {{company_name}}. Reply STOP to opt out.
```

---

# References

Coaches / programs:
- Brent Daniels, TTP / Wholesaling Inc: <https://www.wholesalinginc.com/ttp/>
- Brent Daniels, "Perfect Script for Cold Calling Agents in 2025": <https://www.podcastics.com/podcast/episode/the-perfect-script-for-cold-calling-agents-in-2025-new-improved-flipping-mastery-show-329192/>
- Pace Morby, "How to Text a Motivated Seller for Creative Financing": <https://www.subto.com/post/how-to-text-a-motivated-seller-for-creative-financing>
- Jerry Norton, "The Perfect Motivated Seller Script": <https://www.youtube.com/watch?v=k23JGm60grM>
- Steve Trang, Objection Proof Selling: <https://salesdisruptors.com/> and <https://www.disruptors.com/salesmasterclass>
- Zack Boothe, Driving for Dollars Mastery seller script: <https://dfdmastery.clickfunnels.com/sellerscript>
- King Khang, Kyle Krason, Lili Thompson, Max Maxwell, Danny B. Collected in Call Porter's transcribed analysis: <https://callporter.com/blog/wholesale-cold-calling-script/>

Platforms:
- BatchLeads, Real Estate Text Scripts: <https://batchleads.io/blog/real-estate-text-scripts-to-bring-your-sms-marketing-to-life>
- Launch Control, 10 Most Effective Text Scripts: <https://launchcontrol.us/blogs/10-most-effective-text-messaging-scripts-for-real-estate-agents/>
- REI/kit, Top 15 Seller Objections: <https://www.reikit.com/overcome-objections-real-estate-wholesaling>
- DealMachine, Top 10 Seller Objections: <https://www.dealmachine.com/blog/top-10-seller-objections-in-real-estate-wholesaling>
- DealMachine, 10 Real Estate Text Message Scripts: <https://www.dealmachine.com/blog/10-real-estate-text-message-scripts>
- SimpleTexting, 13 Cold Texting Tips and Templates: <https://simpletexting.com/real-estate-text-message-marketing/scripts-templates/cold-texting/>
- Carrot, Mastering Cold Calling: <https://carrot.com/blog/guide-to-cold-calling-motivated-sellers/>
- RealEstateSkills, Wholesaling text scripts: <https://www.realestateskills.com/blog/wholesaling-real-estate-text-message-scripts>
- RealEstateSkills, Wholesaling with agents: <https://www.realestateskills.com/blog/wholesaling-with-real-estate-agents>
- PropertyLeads, Wholesale text message scripts: <https://www.propertyleads.com/wholesale-text-message-script/>

Compliance (verify directly with your SMS provider before launching campaigns):
- A2P 10DLC compliance overview (Apten): <https://www.apten.ai/blog/a2p-dlc-compliance-2026>
- DMText TCPA + 10DLC compliance checklist: <https://www.dmtext.com/blog/sms-compliance-checklist-2025>
- CloudContact 10DLC update 2025: <https://cloudcontactai.com/10dlc-registration-and-regulation-recent-update/>
- Telnyx SMS compliance: <https://telnyx.com/resources/sms-compliance>
- TALK-Q TCPA + FCC guidelines: <https://talk-q.com/sms-messaging-regulation-in-the-us>

Caveat on sourcing: Several of the highest-value sources (Pace Morby's full texting PDF, Jerry Norton's FreeSellerScripts.com cheat sheet, Zack Boothe's full DFD script, Steve Trang's complete Objection Proof framework, InvestorLift's internal dispo templates) are gated behind paid programs or email opt-ins. The patterns above were synthesized from publicly-available secondary sources (interviews, podcast transcripts, blog summaries). If you want to ship templates citing the gated programs directly, opt in or buy in, that also gives you the legal cover of "adapted from our paid coaching" rather than third-party paraphrase.
