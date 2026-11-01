# Routing v2 backfill: the old unanswered seller texts

What it does: takes seller texts from the last 60 days that nobody answered and runs each one
through the same routing v2 path a new text takes. Only texts already on
`REPLY-APPROVAL-SHEET.md` (Jarrad approved 2026-10-31) can be sent. Nothing new is written for the
backlog.

## The two age groups (Jarrad, 2026-10-31)

| Age of the seller's text | What happens |
|---|---|
| 0–14 days (`--text-max-age-days`, default 14) | **Full treatment**, same as a live reply: reply, drip, alerts, holds, suppression. |
| 15–60 days (`--max-age-days`, default 60) | **Sort only**: no auto reply, no drip. Stops are handled (suppressed or held), legal / needs-a-person texts are held, wrong person / sold / tenant and not interested are closed on that property, bad numbers are marked, and hot texts (yes, offer, okay, price, call me, said they'd call, any alert road) raise their alert and go to Jarrad's queue (held for a person). Everything else is recorded only. |

`--text-max-age-days` above 14 is refused unless `--i-know-this-widens-texting` is also passed.
Age is measured on the database clock in whole days (14.9 days is still day 14, full treatment),
and the group is decided when each text is dispatched, so a text that turns 15 days old during a
long run gets sort only.

**Pending Jarrad:** in the sort-only group, every price text (including "price too high", which
has no alert of its own live) goes to Jarrad's queue with the existing "Named a price" alert. That
is the builder's reading of "alert hot roads"; the report repeats this note.

One road is held for a person even in the 0–14 day group, because its approved reply only makes
sense right after the seller's message:

- **Driving auto-reply** ("Okay, thank you for letting me know. I'll reach out to you later."):
  held for a person with its hot alert; no reply, no drip.

## Which texts are picked

- Only the **newest** seller text on each property. Older unanswered texts on the same property are
  marked `backfill_superseded:<run id>` in the routing audit and never routed.
- Skipped, and counted in the report: anything answered after the text (a person or an automated
  text went out later), leads already waiting on a person, closed / booked / nurture leads,
  DNC-locked, suppressed or opted-out phones and contacts, test-tagged leads, a person took over
  after the text, the responder switched off for the lead, the webhook already handled a keyword
  (STOP etc.), routing v2 not live for that lead, and anything a backfill run or the live engine
  already routed.

## Safety

- Default mode is `--dry-run`: reads only, writes nothing.
- `--classify-only` writes no decision row, hold, drip pause, reply cancel, alert, obligation,
  reply or drip, on any road (stop, legal, needs-a-person and Jev failures included). It stores the
  decision on the seller text (`messages.metadata.routingV2Backfill.classify.decision`) and the
  report shows what apply WOULD do, plus "holds actually written by classify-only (must be 0)".
  What classify-only DOES write, all bookkeeping that no seller or lead state reads:
  - the backfill marker on the seller text (with the decision);
  - the spend ledger (one Jev row per text, plus Haiku if on);
  - nothing on the responder claim in the end: classify-only moves the text's claim aside for
    its dispatch, then removes the claim that dispatch created and puts the original back, so a
    live workflow that still owns the text is never told "already replied";
  - trace / pipeline-run rows for the dispatch;
  - for price texts with the price check on: the DealMachine value lookup (a provider call) and
    its value-cache row, exactly as live.
  A rare error or race that would otherwise flag the lead (an unreadable consent / turn check, a
  send-gate flag, an unreadable engine) skips the text and counts it instead
  (`routing_v2:backfill_classify_only_unavailable`). A text that would take the up-front keyword
  hold is skipped and reported as `keyword_hold`; this is enforced inside the dispatch with the
  keyword list it reads, so a keyword added mid-run is honoured.
- A text whose delayed live reply is still pending (the webhook's `delayed` stamp, under a day
  old) belongs to the live path: skipped and counted as `live_pending`.
- A text whose responder claim is in an error state (for example `v2_safety_hold_failed`, a live
  safety barrier) is never touched: skipped and counted as `claim_error_state`.
- No backfill text acts once a newer seller text exists on the lead. This is checked before the
  keyword hold and again before anything is recorded: skipped as `routing_v2:backfill_newer_inbound`.
  A backfill keyword hold never runs the old engine's follow-up classification.
- `--rate` is capped at 60 per minute. The production check uses the URL the admin client
  actually connects to.
- If routing v2 is not live for a text when it is dispatched (flags, canary or engine are checked
  again for every text, so turning `questions_live` off stops the run), the text is skipped and
  counted as `routing_v2:backfill_v2_not_live`. The old engine never answers a backfill text.
- A non-local database is refused unless `--i-know-this-is-prod` **and** `--run-id` are given.
- The org must be on Jev automatic + nine questions with `questions_live` on, never forceable
  (otherwise the old engine would answer). `replies` and `drips` must be on, or `--force-flags`
  (written in the report; those roads then hold exactly as live).
- Every send goes through the routing v2 outbox and its send guard: quiet hours, newest-reply
  check, takeover fence, suppression and test-lead refusal all apply exactly as live. Run apply
  during the sellers' daytime window, otherwise replies become holds.
- A lead a person took over after the text gets nothing.
- No phone number, message text or secret is printed or written; ids and counts only.
- Rate: `--rate` dispatches per minute (default 60). Sends are paced by the outbox.

## Run sequence for Jarrad

Set the production env first (`vercel env pull --environment=production <scratch>/.env.sandra-prod`),
then prefix each command with `env $(grep -v '^#' <scratch>/.env.sandra-prod | xargs)`.
`BMH` below is the org id `00000000-0000-0000-0000-000000000bbb`.

```bash
S="node --conditions=react-server --import tsx scripts/routing-v2-backfill.ts --org 00000000-0000-0000-0000-000000000bbb --i-know-this-is-prod"

# 1. Dry run: counts only, no model calls, no writes.
$S --dry-run --run-id bf-2026-11-01 --out ~/routing-v2-backfill

# 2. Classify only: Jev (and Haiku if on) decide every picked text; NOTHING is sent, started,
#    alerted or held. Costs one Jev call per text.
$S --classify-only --run-id bf-2026-11-01 --out ~/routing-v2-backfill

# 3. Jarrad reads ~/routing-v2-backfill/classify_only/report.md: roads per age group, and what
#    apply would do (reply / drip / alert / hold / close) for each road.

# 4. Apply in batches, newest first, watching replies between batches.
$S --apply --run-id bf-2026-11-01 --batch-max-age-days 7  --out ~/routing-v2-backfill
$S --apply --run-id bf-2026-11-01 --batch-max-age-days 14 --out ~/routing-v2-backfill
$S --apply --run-id bf-2026-11-01 --out ~/routing-v2-backfill      # 15–60 days: sort only
```

The apply report counts texts whose group changed since classify-only (crossed day 14) and
texts applied without a stored decision (classified fresh, so Jarrad never reviewed them).
Apply records the exact decision classify-only stored (a stop / hold decision through the same
atomic recorder as live) and carries it out, with no second model call. If the lead changed in
between (a person acted, a text went out), the transition holds for a person instead of acting.
Use ONE run id for the whole sequence. If a run stops partway, run the same command again (or
`--resume <run id>`): texts already applied or superseded are never routed twice, and a text
whose apply stopped after its decision was recorded is finished from that recorded decision,
including a stop / needs-a-person decision whose hold was already written (its suppression or
alerts are completed on the rerun; only when the lead's hold is the one written for that text).
The live sweep does not finish those remaining effects for backfill texts, so keep rerunning
until the report shows 0 "interrupted texts". If
the run crashed mid-text, wait 5 minutes first (the crashed claim's lease); until then that text
reports `claim_in_progress` and is left alone. `--limit N` caps one run. An error after a text
was dispatched still reports what was really queued or sent for it (read back from the database).

## Report

Each run writes `<out>/<mode>/report.md`, `candidates.csv` (property id + last inbound age +
group), `skipped.csv` (reason per text) and `items.csv` (one row per dispatched text). Line 1 of
every file is the git SHA the script ran at. The report shows the two age groups separately:
counts per road and age bucket (0–7, 8–14, 15–30, 31–60 days), skip reasons, Jev calls, Haiku calls
and dollars, sends queued and delivered, drips started, alerts queued, holds created and
suppressions created.

## Where the run leaves its marks

- `messages.metadata.routingV2Backfill` on each touched seller text: `classify` / `apply` /
  `superseded` with the run id, time and outcome.
- The text's earlier completed responder claim is kept, renamed to
  `response_kind = 'sms_ai_responder_v1:backfill_prior:<run id>:<claim id>'` (unique per claim, so
  one run id can be reused across classify-only, apply batches and resumes), so the re-dispatch
  can claim it. A claim still being worked on (live lease) is never moved.
- Everything the live path writes for that text (decision, transition, outbox, enrollment, spend
  ledger) is keyed by the text's id. Find a run's rows with:

```sql
select id from messages where metadata->'routingV2Backfill'->'apply'->>'runId' = 'bf-2026-11-01';
```

No database migration is needed.

### Undoing a classify-only run for one text

Classify-only already puts the responder claim back as it found it. To forget its stored
decision for a text (only when no apply has started or finished on it, and never while an apply
run is going):

```sql
begin;
do $$ begin
  if not exists (
    select 1 from messages m
    where m.id = '<id>'
      and m.metadata->'routingV2Backfill' ? 'classify'
      and not (m.metadata->'routingV2Backfill' ? 'apply')
      and not (m.metadata->'routingV2Backfill' ? 'applyStarted'))
  then raise exception 'not undoable: apply started or finished, or never classified';
  end if;
end $$;
update messages set metadata = metadata - 'routingV2Backfill' where id = '<id>';
commit;
```

An applied text's claim stays renamed `sms_ai_responder_v1:backfill_prior:<run id>:<claim id>`
on purpose: the apply produced a real outcome with its own claim.
