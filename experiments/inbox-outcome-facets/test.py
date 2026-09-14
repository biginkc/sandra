#!/usr/bin/env python3
import runpy,json,sys
from pathlib import Path
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit fixture grant required')
P=Path(__file__).resolve().parent
v=runpy.run_path(str(P.parent/'inbox-workset-bridge/search-test.py'));sql=v['sql'];need=v['need'];o=v['o'];prefix=v['prefix'];ids=v['ids']
def counts(f=None):
 return json.loads(sql(prefix+f"SET ROLE authenticated; SELECT public.inbox_outcome_counts_v1('{o}','{json.dumps(f or {'view':'all','hide_noise':False})}')"))
values=['wrong_number','bad_number','not_interested','opted_out','dnc','nurture','callback_requested','needs_sequence','booked_appointment']
for outcome in values:
 sql(f"UPDATE inbox_t2_maintained.rows SET summary=summary||jsonb_build_object('outreach_dispo','{outcome}'),revision=revision+1 WHERE org_id='{o}' AND target_id='{ids[0]}'")
 c=counts();need(c['outcome_counts'][outcome]==1 and c['outcome_counts']['no_outcome']==2 and c['known_total']==3,'Display taxonomy '+outcome)
need(sum(c['outcome_counts'].values())==c['known_total'],'Outcomes partition known conversations')
search=counts({'view':'mine','hide_noise':False,'search':'Zephyr'})
need(search['known_total']==1 and search['outcome_counts']['booked_appointment']==1,'Known search; work filter intentionally ignored')
need(search['semantics']['view']=='all' and search['semantics']['unit']=='conversation','Explicit semantics')
need(search['unknown_count']==c['unknown_count'],'Unknown does not inherit known search')
sql(f"UPDATE inbox_t2_maintained.rows SET summary=summary||jsonb_build_object('is_noise',true),revision=revision+1 WHERE org_id='{o}' AND target_id='{ids[0]}'")
need(counts({'view':'all','hide_noise':True})['outcome_counts']['booked_appointment']==0,'Hide noise')
for role in ['anon','service_role']:
 try:sql(prefix+f"SET ROLE {role}; SELECT public.inbox_outcome_counts_v1('{o}','{{\"view\":\"all\"}}')")
 except RuntimeError:pass
 else:raise AssertionError('Forbidden role '+role)
try:sql(prefix+"SET ROLE authenticated; SELECT public.inbox_outcome_counts_v1('00000000-0000-0000-0000-000000000001','{\"view\":\"all\"}')")
except RuntimeError:pass
else:raise AssertionError('Cross-org accepted')
(P/'evidence.json').write_text(json.dumps({'passed':True,'display_outcomes':values,'checks':['known conservation','search','explicit all-view semantics','unknown isolation','noise','anon/service denial'],'sample':search},indent=2)+'\n')
print('Outcome taxonomy and scope tests passed')
