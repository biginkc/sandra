# Sandra "Messages v2" redesign brief

Date: 2026-10-14. Owner: Jarrad Henry. Status: decisions locked, nothing built yet.

## 1. What this page is

Mel, the VA who answered every seller text, left. Jev (an AI sorter) is the new Mel. This page is where Jarrad watches Jev work and checks up on her. It is not an inbox for a team member.

Jarrad's words: "I want to see Jev working like a stock ticker. Boxes of incoming messages, and I actively see Jev deciding on them in real time, almost like it's running the page with a mouse and keyboard."

Today about 30 seller texts a day come in. Once campaigns are turned on it will be far more. The page must still make sense on a quiet day: a scrollable "today's tape" so it is never a blank screen.

## 2. The vocabulary (use these words, nothing else)

Jev answers nine yes/no questions about each seller text. These are Jarrad's approved words. The page shows these, never code labels.

| # | Seller reply type | Jev alone? | What happens |
|---|---|---|---|
| 1 | Open to selling / wants an offer | No, goes to Jarrad | Becomes a lead on My Leads, assigned to Jarrad Henry. Slack + text message to Jarrad. |
| 2 | Maybe later | Yes | Approved reply, then the "Maybe later" drip |
| 3 | Asked who is texting | Yes | Approved reply, then the "Asked who is texting" drip |
| 4 | Not interested | Yes | Approved reply, then the "Not interested" drip (long-term check-ins) |
| 5 | Wrong person | Yes | Approved reply, closed |
| 6 | Asked to stop | No, waits for a person | Sits on the page for a once-a-day look. No ping. |
| 7 | Hostile | No, waits for a person | Sits on the page for a once-a-day look. No ping. |
| 8 | Confirmed owner | Yes | Approved reply, then the "Confirmed owner" drip |
| 9 | Talked price | No, goes to Jarrad | Same as #1: lead on My Leads, assigned to Jarrad, Slack + text. |

Texts Jev cannot read go to "Needs a person", once-a-day look, no ping.

Rules Jarrad set:
- Jev only does things that can be undone: start a drip, mark a reply type, send a pre-approved text. Do-not-contact is one-way, so a person always does it.
- Jev only ever sends texts Jarrad approved word for word. Never her own words. If no approved text fits, she waits.
- Hot sellers (1 and 9) interrupt Jarrad. Nothing else does.

Approved drips that exist in Sandra today: Confirmed owner, Asked who is texting, Not interested, Maybe later, Talking price, Book appointment, Curious. Jev does not start "Talking price", "Book appointment" or "Curious" on her own.

## 3. What the page must show

1. **The ticker.** Newest text at the top. One box per seller text: who, address, what they said, our last text to them, and Jev's decision in a plain sentence ("Sue wants an offer. Handed to Jarrad." / "Martha said no. Sent the thank-you, closed."). Then what Jev did (reply sent, drip started, lead made). Jarrad should be able to watch the decision appear live.
2. **Today's tape.** The same boxes, scrollable back through the day and earlier days, so a quiet hour isn't a blank page.
3. **Waiting for a person.** Stop requests, hostile texts, and texts Jev couldn't read. Newest first. One-click actions: approve stop, send an approved reply, dismiss. Checked once a day. Never oldest-first; never mixed with hot sellers.
4. **Jev's controls.** A clear settings panel (not badges in the title bar) that says in plain English what Jev may do alone for each of the nine reply types, and lets Jarrad switch each one. Must look like controls.
5. **One accuracy line.** "Jev was right N% of the time this week." No report card grid.

Hot sellers do not need a special section here: they go to My Leads. The ticker just shows "Handed to Jarrad."

## 4. What to throw away from the current page

- The header badges (new_lead [HELD], nurture [AUTO ≥0.95], etc.). Jarrad: "horrendous presentation." They are controls that look like a legend.
- The step-log cards (reply_delay_scheduled, claim, resolve_threshold, needs_attention, "6 gates passed"). Jarrad: "the UI is terrible for this." Engineer words; never says what Jev decided.
- "LEGACY / already_terminal (block)" cards that say nothing.
- The holds rail as built: oldest first, codes like "model:price_or_offer · already_terminal", greyed buttons, "alert: sent".
- The Shadow scorecard grid and Luna suggestions.
- The app's 8-answer set (new_lead, nurture, not_interested, wrong_number, bad_number, opted_out, dnc, unclear). Replaced by the nine questions above.
- The one-Slack-ping-per-hold alerts (263 last week). Only hot sellers ping.

## 5. Things already done or known

- 2,400 old "needs attention" flags were cleared on 2026-10-14 at Jarrad's request. 63 remain only because those properties are permanently do-not-contact locked; the page should never show those.
- The text-message alert for hot sellers exists in code but has never fired; its "what counts as hot" list doesn't match the labels Sandra writes. Must be fixed in the build.
- Nine approved question texts, the 0.6 cutoff, and the drip texts are recorded word for word and must be used character for character.

## 6. Not decided yet

- Exact visual style. Jarrad is taking this brief to Claude Design for the look.
- Whether "gave a time to call" (e.g. "Anytime", "noon is best") needs its own question. Today it falls into "wants an offer" via the hot-lead path.
