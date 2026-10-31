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

Apply carries out the exact decision classify-only recorded (no second model call). If a run
stops partway, run the same command again (or `--resume <run id>`): texts already applied or
superseded are never routed twice. `--limit N` caps one run.

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
  `response_kind = 'sms_ai_responder_v1:backfill_prior:<run id>'`, so the re-dispatch can claim it.
- Everything the live path writes for that text (decision, transition, outbox, enrollment, spend
  ledger) is keyed by the text's id. Find a run's rows with:

```sql
select id from messages where metadata->'routingV2Backfill'->'apply'->>'runId' = 'bf-2026-11-01';
```

No database migration is needed.
