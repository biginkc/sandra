-- Messages v2 Phase 2 — rules mining. READ-ONLY SELECTs, run against prod (project copflsklaefwzipsrjqz)
-- on 2026-10-07 via the Supabase MCP. Window: last 180 days unless noted.
-- Nothing here writes. Output feeds .planning/messages-v2/RULES-PROPOSAL.md (proposal only, nothing approved).
-- Redaction: results are quoted in the proposal with phones/surnames removed; queries return raw bodies, do not paste them elsewhere.

begin transaction read only;
set local statement_timeout='60s';

-- Q01 volumes
select (select count(*) from messages where direction='inbound' and created_at>now()-interval '180 days') inbound_180d,
       (select count(*) from messages where direction='outbound' and created_at>now()-interval '180 days') outbound_180d,
       (select count(*) from sms_classification_runs where created_at>now()-interval '180 days') jev_runs,
       (select min(created_at) from sms_classification_runs) first_jev_run,
       (select count(*) from lead_events where event_type='dispo_set' and created_at>now()-interval '180 days') dispo_events;

-- Q02 who set dispositions (to-value x actor)
select payload->>'to' to_dispo, actor_type, count(*) from lead_events
where event_type='dispo_set' and created_at>now()-interval '180 days' group by 1,2 order by 3 desc;

-- Q03 dispo transitions (from -> to x actor)
select (payload->>'from')||' -> '||(payload->>'to') tr, actor_type, count(*) n from lead_events
where event_type='dispo_set' and created_at>now()-interval '180 days' group by 1,2 order by n desc limit 30;

-- Q04 callback_requested + nurture->needs_sequence lag + human set share
select 'to_callback_requested_180d' k, count(*)::text v from lead_events where event_type='dispo_set' and payload->>'to'='callback_requested' and created_at>now()-interval '180 days'
union all select 'from_callback_requested_180d', count(*)::text from lead_events where event_type='dispo_set' and payload->>'from'='callback_requested' and created_at>now()-interval '180 days'
union all select 'nurture_to_needs_seq_median_lag_min', (select percentile_cont(0.5) within group (order by extract(epoch from (b.created_at-a.created_at))/60)::int::text from lead_events a join lateral (select b.created_at from lead_events b where b.property_id=a.property_id and b.event_type='dispo_set' and b.payload->>'from'='nurture' and b.payload->>'to'='needs_sequence' and b.actor_type='user' and b.created_at>a.created_at order by b.created_at limit 1) b on true where a.event_type='dispo_set' and a.payload->>'to'='nurture' and a.actor_type='user' and a.created_at>now()-interval '180 days')
union all select 'human_sets_nurture_or_needs_seq_180d', count(*)::text from lead_events where event_type='dispo_set' and actor_type='user' and created_at>now()-interval '180 days' and payload->>'to' in ('nurture','needs_sequence')
union all select 'human_sets_all_180d', count(*)::text from lead_events where event_type='dispo_set' and actor_type='user' and created_at>now()-interval '180 days';

-- Q05 AI disposition reviews: human confirmation vs correction (legacy path; rows before 2026-09-24 carry no Jev run / confidence)
select r.status, coalesce(r.superseded_reason,'-') sr, r.dispo_applied, (r.classification_run_id is not null) has_run, count(*) n, min(r.created_at)::date mn, r.disposition
from ai_disposition_reviews r where r.created_at>now()-interval '180 days' group by 1,2,3,4,7 order by n desc;

-- Q06 Jev runs: outcome distribution, escalation reasons
select decision->>'outcome' o, count(*) from sms_classification_runs where created_at>now()-interval '180 days' group by 1 order by 2 desc;
select decision->>'escalationReason' er, decision->>'outcome' o, count(*) n from sms_classification_runs where created_at>now()-interval '180 days' group by 1,2 order by 1,3 desc;
select k, count(*) from sms_classification_runs r, jsonb_object_keys(r.decision) k where r.created_at>now()-interval '180 days' group by 1 order by 2 desc;  -- shows there is NO reply_intent key today

-- NOTE (section 5 of the proposal): Q07 counts Jev RUNS, not distinct properties. A property with several runs is counted once per run.
-- Q07 THRESHOLD EVIDENCE: Jev outcome x confidence cutoff x what a human then did (first user dispo_set on the property within 30 days after the run)
with runs as (
 select id, property_id, created_at, decision->>'outcome' o, (decision->>'outcomeConfidence')::numeric c from sms_classification_runs where created_at>now()-interval '180 days'),
h as (
 select r.*, (select e.payload->>'to' from lead_events e where e.property_id=r.property_id and e.event_type='dispo_set' and e.actor_type='user' and e.created_at>r.created_at and e.created_at<r.created_at+interval '30 days' order by e.created_at limit 1) human_to from runs r),
t as (select unnest(array[0.95,0.90,0.85,0.80,0.0]) thr)
select o, thr, count(*) n, count(*) filter (where human_to is null) no_human_change, count(*) filter (where human_to=o) human_same, count(*) filter (where human_to is not null and human_to<>o) human_different
from h join t on h.c>=t.thr group by 1,2 order by 1,2 desc;

-- Q08 what humans set after each Jev outcome (label confusion)
with runs as (select property_id, created_at, decision->>'outcome' o from sms_classification_runs where created_at>now()-interval '180 days')
select o, (select e.payload->>'to' from lead_events e where e.property_id=r.property_id and e.event_type='dispo_set' and e.actor_type='user' and e.created_at>r.created_at and e.created_at<r.created_at+interval '30 days' order by e.created_at limit 1) human_to, count(*)
from runs r group by 1,2 order by 1,3 desc;

-- Q09 Jev inbound bodies per outcome (short bodies, normalized)
select r.decision->>'outcome' o, regexp_replace(lower(trim(m.body)),'[0-9]{3,}','#','g') nb, count(*) n
from sms_classification_runs r join messages m on m.id=r.source_inbound_message_id
where length(m.body)<=70 and r.created_at>now()-interval '180 days' group by 1,2 having count(*)>=2 order by 1, n desc;

-- Q10 HUMAN REPLY SET. Definition: outbound sms, campaign_id null, generated_by <> 'ai_responder_v1' (or null), not a sequence_step_runs message,
-- that is the first outbound after the most recent inbound in the same conversation within the prior 48h.
with seq as (select message_id from sequence_step_runs where message_id is not null),
o as (select m.* from messages m where m.direction='outbound' and m.channel='sms' and m.created_at>now()-interval '180 days' and m.campaign_id is null and coalesce(m.metadata->>'generated_by','')<>'ai_responder_v1' and m.id not in (select message_id from seq)),
p as (select o.id, o.conversation_id, o.created_at,
 (select i.id from messages i where i.conversation_id=o.conversation_id and i.direction='inbound' and i.created_at<o.created_at and i.created_at>o.created_at-interval '48 hours' order by i.created_at desc limit 1) inb_id,
 (select max(x.created_at) from messages x where x.conversation_id=o.conversation_id and x.direction='outbound' and x.created_at<o.created_at) prev_out
 from o)
select (select count(*) from o) out_nonai_nocampaign_nonseq,
 count(*) filter (where inb_id is not null) with_inbound48h,
 count(*) filter (where inb_id is not null and (prev_out is null or prev_out < (select created_at from messages where id=inb_id))) answering_first_reply from p;

-- Q11 human reply macros: top normalized bodies (digits -> #)
with seq as (select message_id from sequence_step_runs where message_id is not null),
o as (select m.* from messages m where m.direction='outbound' and m.channel='sms' and m.created_at>now()-interval '180 days' and m.campaign_id is null and coalesce(m.metadata->>'generated_by','')<>'ai_responder_v1' and m.id not in (select message_id from seq)),
p as (select o.id, o.body ob, o.conversation_id,
 (select i.id from messages i where i.conversation_id=o.conversation_id and i.direction='inbound' and i.created_at<o.created_at and i.created_at>o.created_at-interval '48 hours' order by i.created_at desc limit 1) inb_id,
 (select max(x.created_at) from messages x where x.conversation_id=o.conversation_id and x.direction='outbound' and x.created_at<o.created_at) prev_out from o)
select regexp_replace(lower(ob),'[0-9]+','#','g') nb, count(*) n from p
where inb_id is not null and (prev_out is null or prev_out < (select created_at from messages where id=inb_id)) group by 1 order by n desc limit 40;

-- Q12 macro family x resulting disposition (first dispo_set, any actor, within 3 days after the inbound) + reply-back within 24h
with seq as (select message_id from sequence_step_runs where message_id is not null),
o as (select m.* from messages m where m.direction='outbound' and m.channel='sms' and m.created_at>now()-interval '180 days' and m.campaign_id is null and coalesce(m.metadata->>'generated_by','')<>'ai_responder_v1' and m.id not in (select message_id from seq)),
p as (select o.id, lower(o.body) ob, o.property_id, o.created_at, o.conversation_id,
 (select i.id from messages i where i.conversation_id=o.conversation_id and i.direction='inbound' and i.created_at<o.created_at and i.created_at>o.created_at-interval '48 hours' order by i.created_at desc limit 1) inb_id,
 (select max(x.created_at) from messages x where x.conversation_id=o.conversation_id and x.direction='outbound' and x.created_at<o.created_at) prev_out from o),
q as (select p.*, (select created_at from messages where id=inb_id) inb_at from p where inb_id is not null),
f as (select q.*, case
 when ob like '%have you considered selling before%' then 'A_considered_selling'
 when ob like '%good time for us to hop on a quick call%' then 'B_call_time'
 when ob like '%would you consider a cash offer%' then 'C_cash_offer_ask'
 when ob like 'understood%' or ob like 'thanks for the update%' or ob like 'sorry for the bother%' then 'D_ack_close'
 when ob like '%tlc%' then 'E_tlc_remodeled'
 when ob like '%depends a lot on condition%' then 'F_price_deflect_call'
 when ob like '%doesn''t authorize%' then 'G_no_approval_text'
 when ob like 'all good,%check back%' then 'H_checkback'
 when ob like '%spoke to jarrad%' then 'I_spoke_jarrad'
 when ob like '%seller financing%' then 'J_seller_fin'
 else 'Z_other' end fam,
 (select e.payload->>'to' from lead_events e where e.property_id=q.property_id and e.event_type='dispo_set' and e.created_at>q.inb_at and e.created_at<q.inb_at+interval '3 days' order by e.created_at limit 1) dispo
 from q where prev_out is null or prev_out<inb_at)
select fam, coalesce(dispo,'(none)') dispo, count(*) n,
 count(*) filter (where exists(select 1 from messages r where r.conversation_id=f.conversation_id and r.direction='inbound' and r.created_at>f.created_at and r.created_at<f.created_at+interval '24 hours')) replied_24h,
 round(avg(length(ob))) avg_len
from f group by 1,2 order by 1,3 desc;

-- Q13 inbound bodies by the macro family that answered them (short bodies, normalized, n>=3)
with seq as (select message_id from sequence_step_runs where message_id is not null),
o as (select m.* from messages m where m.direction='outbound' and m.channel='sms' and m.created_at>now()-interval '180 days' and m.campaign_id is null and coalesce(m.metadata->>'generated_by','')<>'ai_responder_v1' and m.id not in (select message_id from seq)),
p as (select o.id, lower(o.body) ob, o.created_at, o.conversation_id,
 (select i.id from messages i where i.conversation_id=o.conversation_id and i.direction='inbound' and i.created_at<o.created_at and i.created_at>o.created_at-interval '48 hours' order by i.created_at desc limit 1) inb_id,
 (select max(x.created_at) from messages x where x.conversation_id=o.conversation_id and x.direction='outbound' and x.created_at<o.created_at) prev_out from o),
f as (select p.*, i.body ib, case
 when ob like '%have you considered selling before%' then 'A'
 when ob like '%good time for us to hop on a quick call%' then 'B'
 when ob like '%would you consider a cash offer%' then 'C'
 when ob like 'understood%' or ob like 'thanks for the update%' or ob like 'sorry for the bother%' then 'D'
 when ob like '%tlc%' then 'E'
 when ob like '%depends a lot on condition%' then 'F'
 when ob like '%doesn''t authorize%' then 'G'
 when ob like 'all good,%check back%' then 'H'
 else 'Z' end fam from p join messages i on i.id=p.inb_id where prev_out is null or prev_out<i.created_at)
select fam, regexp_replace(lower(trim(ib)),'[0-9]{3,}','#','g') nb, count(*) n from f where length(ib)<=70 group by 1,2 having count(*)>=3 order by fam, n desc;

-- Q14 one-off macros (Library templates Mel/Jarrad used by hand) with reply-back
with seq as (select message_id from sequence_step_runs where message_id is not null),
t as (select m.*, case when lower(body) like 'my apologies, i''ll get you off the list%' then 'wrong_number_referral' when lower(body) like 'real human, promise%' then 'real_human' when lower(body) like 'fair question, there''s a lot of junk%' then 'scam_check' when lower(body) like '%i spoke to jarrad%' then 'spoke_to_jarrad' when lower(body) like '%seller financing%' then 'seller_fin' when lower(body) like '%you''re removed%' then 'removed' when lower(body) like '%not authorized to provide approvals%' then 'manager_maria' end fam
 from messages m where direction='outbound' and created_at>now()-interval '180 days' and campaign_id is null and coalesce(metadata->>'generated_by','')<>'ai_responder_v1' and id not in (select message_id from seq))
select fam, count(*) n, count(*) filter (where exists(select 1 from messages r where r.conversation_id=t.conversation_id and r.direction='inbound' and r.created_at>t.created_at and r.created_at<t.created_at+interval '24 hours')) replied_24h from t where fam is not null group by 1;

-- Q15 legacy AI responder output (what is auto-sending today)
select regexp_replace(regexp_replace(left(body,70),'Are you [A-Z][a-z]+\?','Are you X?'),'[0-9]+','#','g') nb, count(*) n from messages
where direction='outbound' and metadata->>'generated_by'='ai_responder_v1' and created_at>now()-interval '180 days' group by 1 order by n desc limit 15;
select count(*) filter (where body like 'So sorry to bug you%') sorry_bug, count(*) filter (where body like 'I''m sorry I should have mentioned that%') identity, count(*) total_ai, min(created_at)::date
from messages where direction='outbound' and metadata->>'generated_by'='ai_responder_v1' and created_at>now()-interval '180 days';

-- Q16 HOLD-RULE EVIDENCE: keyword-proxy flags on every inbound sms (regexes are crude proxies, not classifiers; "worth" also matches "not worth")
with i as (select m.id, m.conversation_id, m.property_id, m.created_at, m.body, lower(m.body) lb from messages m where m.direction='inbound' and m.channel='sms' and m.created_at>now()-interval '180 days'),
fl as (select i.*,
 (lb ~ '\$\s?[0-9]|[0-9][0-9,.]*\s?k\y|how much|your offer|what.{0,20}offer|your number|asking price|my price|worth|appraised|\y[0-9]{2,3},[0-9]{3}\y') price,
 (lb ~ 'divorc|deceased|passed away|\ydied\y|\ydeath\y|probate|inherit|foreclos|behind on|\ylien|bankrupt|back taxes|eviction|evict|hospice|nursing home|cancer|widow') distress,
 (lb ~ 'attorney|lawyer|legal|\ysue\y|\ysuing\y|\ycourt\y|code violation|cease|harass|\ytcpa\y|\yfcc\y|report you|reported|police|power of attorney') legal,
 (lb ~ 'fuck|\yscam|\yspam|leave me alone|piss|asshole|bitch|\yidiot|\ystalk|never contact|do not contact|quit texting|stop texting|stop contacting|f off|go to hell|harass') hostile,
 (lb ~ 'realtor|\yagent\y|broker|my husband|my wife|my son|my daughter|my mom|my mother|my dad|my father|my brother|my sister|landlord|tenant|property manager|listed with|\yestate\y|trustee') third,
 (lb ~ 'which (one|property|house)|other (house|propert|home)|more than one|several|a few|all of them|two (house|propert|home)|three (house|propert|home)|\yrentals\y|other places|my properties|portfolio') multi,
 (length(body)>200) long from i),
u as (select 'price' cat, id, conversation_id, property_id, created_at from fl where price union all select 'distress',id,conversation_id,property_id,created_at from fl where distress union all select 'legal',id,conversation_id,property_id,created_at from fl where legal union all select 'hostile',id,conversation_id,property_id,created_at from fl where hostile union all select 'third_party',id,conversation_id,property_id,created_at from fl where third union all select 'multi_property',id,conversation_id,property_id,created_at from fl where multi union all select 'long_gt200',id,conversation_id,property_id,created_at from fl where long),
r as (select u.*,
 exists(select 1 from messages o where o.conversation_id=u.conversation_id and o.direction='outbound' and o.metadata->>'generated_by'='ai_responder_v1' and o.created_at>u.created_at and o.created_at<u.created_at+interval '1 hour') ai_replied,
 exists(select 1 from messages o where o.conversation_id=u.conversation_id and o.direction='outbound' and o.campaign_id is null and coalesce(o.metadata->>'generated_by','')<>'ai_responder_v1' and o.created_at>u.created_at and o.created_at<u.created_at+interval '48 hours' and not exists(select 1 from sequence_step_runs s where s.message_id=o.id)) human_replied,
 (select e.payload->>'to' from lead_events e where e.property_id=u.property_id and e.event_type='dispo_set' and e.created_at>u.created_at and e.created_at<u.created_at+interval '3 days' order by e.created_at limit 1) dispo
 from u)
select cat, count(*) n, count(*) filter (where ai_replied) ai_replied, count(*) filter (where human_replied) human_replied,
 count(*) filter (where dispo='nurture') d_nurture, count(*) filter (where dispo='needs_sequence') d_needs_seq, count(*) filter (where dispo='not_interested') d_not_int,
 count(*) filter (where dispo in ('dnc','opted_out')) d_dnc_opt, count(*) filter (where dispo='wrong_number') d_wrong, count(*) filter (where dispo is null) d_none
from r group by cat order by n desc;
-- Any-rule total (de-duplicated per inbound): total inbound 180d and count flagged by at least one rule.
with i as (select m.id, m.body, lower(m.body) lb from messages m where m.direction='inbound' and m.channel='sms' and m.created_at>now()-interval '180 days'),
fl as (select i.*,
 (lb ~ '\$\s?[0-9]|[0-9][0-9,.]*\s?k\y|how much|your offer|what.{0,20}offer|your number|asking price|my price|worth|appraised|\y[0-9]{2,3},[0-9]{3}\y') price,
 (lb ~ 'divorc|deceased|passed away|\ydied\y|\ydeath\y|probate|inherit|foreclos|behind on|\ylien|bankrupt|back taxes|eviction|evict|hospice|nursing home|cancer|widow') distress,
 (lb ~ 'attorney|lawyer|legal|\ysue\y|\ysuing\y|\ycourt\y|code violation|cease|harass|\ytcpa\y|\yfcc\y|report you|reported|police|power of attorney') legal,
 (lb ~ 'fuck|\yscam|\yspam|leave me alone|piss|asshole|bitch|\yidiot|\ystalk|never contact|do not contact|quit texting|stop texting|stop contacting|f off|go to hell|harass') hostile,
 (lb ~ 'realtor|\yagent\y|broker|my husband|my wife|my son|my daughter|my mom|my mother|my dad|my father|my brother|my sister|landlord|tenant|property manager|listed with|\yestate\y|trustee') third,
 (lb ~ 'which (one|property|house)|other (house|propert|home)|more than one|several|a few|all of them|two (house|propert|home)|three (house|propert|home)|\yrentals\y|other places|my properties|portfolio') multi,
 (length(body)>200) long from i)
select count(*) total_inbound, count(*) filter (where price or distress or legal or hostile or third or multi or long) any_rule from fl;

-- Q17 hostile inbound that the legacy AI answered anyway (sample; body shown, names replaced when quoted)
select left(regexp_replace(i.body,'[0-9]{3,}','#','g'),90) inbound, left(regexp_replace(a.body,'[0-9]{3,}','#','g'),120) ai_reply
from messages i join lateral (select o.body from messages o where o.conversation_id=i.conversation_id and o.direction='outbound' and o.metadata->>'generated_by'='ai_responder_v1' and o.created_at>i.created_at and o.created_at<i.created_at+interval '1 hour' order by o.created_at limit 1) a on true
where i.direction='inbound' and i.created_at>now()-interval '180 days' and lower(i.body) ~ 'fuck|\yscam|\yspam|leave me alone|piss|asshole|bitch|harass|stop texting|f off' order by i.created_at desc limit 12;

commit;
