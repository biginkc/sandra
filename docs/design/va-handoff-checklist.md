# VA Handoff Checklist

What to walk through in the live UI before handing the CRM to a VA. Each tier escalates in stakes — Tier 1 is daily blocking; Tier 4 is "the deals these protect are big".

The **must-pass-five** subset is at the bottom — if you only have time for the gold standard, that's it.

## Tier 1 — Daily VA workflow (must be airtight)

### 1. Sign-in → Overview → first action
- Sign in as the VA
- Confirm `/dashboard` is the landing page
- "Good morning, [name]" greeting is correct
- Needs Attention strip surfaces actionable counts
- Click an alert row → lands on a filtered worklist

### 2. Read a conversation thread
- From Messages cockpit, click into a thread with at least 1 inbound + 1 outbound
- Timeline reads top-to-bottom in correct order
- Seller's name + property address are visible without hunting

### 3. Send a manual SMS reply
- From a lead's detail page, type a reply, hit send
- Message appears in thread; seller's phone receives the send
- **Use test phone +13107540662 — never a real seller**
- If quiet hours are active, send is blocked with a clear "outside business hours" message

### 4. Clear an "AI needs attention" escalation
- Find a lead where `needs_human_attention=true`
- VA reads the thread, takes over (or dismisses)
- Click the "clear flag" affordance
- Lead drops off the threads-needing-attention rail
- Dashboard count decrements
- The next escalation creates a fresh flag

### 5. Move a lead through the pipeline
- Drag a lead from "Contacted" → "Interested" on the kanban
- Refresh → confirm the move persisted
- Edge case: drag while another tab has a stale view, confirm no overwrite

### 6. Tag a lead, add a note
- Apply a custom tag (e.g., "called Tuesday")
- Add a free-text note
- Both persist after refresh and surface on the lead detail

## Tier 2 — Weekly / batch ops

### 7. Import a CSV
- Skip Genie aliases auto-detect on the mapping screen
- `PROP: Address Full` splits cleanly into address/city/state/zip
- Validation surface flags junk rows before import
- Property count after import matches expected
- Properties land as **Prospects** (not Leads)

### 8. Bulk skip-trace
- Select ~20 prospects (small batch first), request skip-trace
- Admin gets the approval prompt; admin approves
- Job runs, status surfaces in `/jobs`
- Phone numbers populate on prospect rows
- Credit balance on Overview decrements correctly

### 9. Create a list, add prospects, enroll in a sequence
- Make a list, drop selected prospects in
- Create or pick a sequence
- Enroll the list
- First step fires (or schedules) immediately
- "Not in a drip" count on Overview drops by enrollment size

### 10. Inbound reply hits the cockpit
- Test receiver phone (+18148097074) sends a reply to a sequence-touched property
- Reply appears in `/messages` cockpit
- AI either drafts/sends or escalates per config
- Lead's status auto-bumps to "contacted" / "interested" appropriately

## Tier 3 — Onboarding the VA (one-time, you only)

### 11. Add a VA user
- From `/admin/users`, invite a VA email
- Invite email arrives, set-password flow works
- VA logs in, lands on Overview
- Sidebar shows VA-appropriate items (no Team / no AI responder)

### 12. Permissions sanity
As a VA (non-admin), confirm:
- ✓ Can read leads, send messages, update statuses
- ✗ Cannot see `/admin/users`
- ✗ Cannot edit AI responder settings
- ✗ Cannot reach skip-trace settings (or only as a request, not approve)

## Tier 4 — Safety nets

### 13. STOP keyword stops the bot
- From test phone, send "STOP" inbound to a sequence-active property
- Seller's consent is revoked
- All queued sends to that property are killed
- Property status reflects the opt-out
- Try to send an outbound manually → blocked with consent-revoked message

### 14. Quiet hours block outbound
- At ≥21:00 in property's local time, try to send SMS
- Send is blocked with clear "quiet hours" reason
- An inbound during quiet hours still gets logged
- AI escalates instead of replying (because `business_hours_only=true`)

### 15. AI daily cap fires
- Default cap = 100/day; hard to fake without a real day
- Worth knowing the cap is set and that you'd notice exhaustion (escalation surge)

### 16. Property merge / dedup
- Import a row that matches an existing property by APN or normalized address
- Wizard's Update Mode (or merge dialog) handles cleanly, no duplicate

## Tier 5 — Polish

### 17. Search/filter on /leads
- Type an address, owner name, market — narrowing works

### 18. Sequence stats
- Open a running sequence, sends/replies counts look right

### 19. Notification bell
- New escalations / completed jobs ring the bell

### 20. Mobile
- Pull up dashboard on phone — VA may use mobile occasionally

---

## Must-pass-five — minimum bar before VA handoff

If you only have time for these, you're shippable:

- ✅ **#1** — Sign in lands on Overview, work is visible
- ✅ **#4** — VA can clear an AI escalation
- ✅ **#5** — VA can move a deal forward
- ✅ **#10** — Inbound reply flows through the system
- ✅ **#13** — STOP actually stops sending

All five must pass with real data + real phone before the VA gets the keys.
