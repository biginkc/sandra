#!/usr/bin/env python3
"""Run bounded worker rounds in the owned candidate DB, with durable claims between transactions."""
import argparse,json
from fixture_db import guard,sql,literal
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');ap.add_argument('--rounds',type=int,default=1);a=ap.parse_args()
if not a.owned_fixture or not 1<=a.rounds<=100:raise SystemExit('Explicit fixture and1..100 rounds required')
guard();counts={'baseline':0,'backfill':0,'parent':0,'summary':0,'expiry':0}
for _ in range(a.rounds):
 sql('SELECT inbox_control.seed_baseline_batch(100)',retry=True);counts['baseline']+=1
 jobs=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(j)),'[]') FROM inbox_backfill.claim(2,300)j",retry=True))
 for j in jobs:
  sql(f"SELECT inbox_backfill.batch({literal(j['org_id'])},{literal(j['claim_token'])},100)",retry=True);counts['backfill']+=1
 parents=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(j)),'[]') FROM inbox_parent.claim(2,300)j",retry=True))
 for j in parents:
  sql(f"SELECT inbox_parent.batch({literal(j['org_id'])},{literal(j['kind'])},{literal(j['entity_id'])},{literal(j['claim_token'])},100)",retry=True);counts['parent']+=1
 counts['expiry']+=int(sql('SELECT inbox_control.wake_due_expiries(20)',retry=True))
 claims=json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(j)),'[]') FROM inbox_maintained.claim_work(10,300)j",retry=True))
 for j in claims:
  # Compute outside the claim transaction; publish independently fences lease/generation.
  raw=sql(f"SELECT inbox_maintained.snapshot({literal(j['org_id'])},{literal(j['target_kind'])},{literal(j['target_id'])},statement_timestamp())")
  if not raw:raise RuntimeError('Missing worker candidate, retain durable lease for investigation')
  sql(f"SELECT inbox_maintained.finish_work({literal(j['claim_token'])},{literal(raw)}::jsonb)",retry=True);counts['summary']+=1
print(json.dumps({'rounds':a.rounds,'processed':counts,'readiness':json.loads(sql('SELECT inbox_control.readiness()'))}))
