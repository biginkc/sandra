#!/usr/bin/env python3
import runpy,json
from pathlib import Path
P=Path(__file__).resolve().parent
v=runpy.run_path(str(P.parent/'inbox-workset-bridge/search-test.py'));sql=v['sql'];need=v['need'];o=v['o'];u=v['u'];ids=v['ids']
cases=0
for view in ['active','all','mine','unassigned','unread','escalated','dispo','needs_outcome','unknown','dismissed']:
 for hide in [True,False]:
  for search in ['', 'Zephyr','quartzpref','Literal%Token']:
   f=json.dumps({'view':view,'hide_noise':hide,'search':search}).replace("'","''");nf=f"inbox_t2_bridge.normalize_filter('{f}')"
   old=json.loads(sql(f"SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM(SELECT * FROM inbox_t2_bridge.matching('{o}','{u}',{nf}) ORDER BY latest_at DESC NULLS LAST,target_kind,target_id LIMIT 500)x"))
   new=json.loads(sql(f"SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM inbox_t2_bridge.page('{o}','{u}',{nf},NULL,NULL,NULL,false,500)x"))
   need(old==new,'Typed predicate mismatch '+f);cases+=1
# Owner classification and time-expiry/tombstone publication are actual maintained writes.
sql(f"UPDATE inbox_t2_maintained.rows SET summary=summary||jsonb_build_object('assigned_user_id',NULL,'has_recent',false),revision=revision+1 WHERE org_id='{o}' AND target_id='{ids[0]}'")
need(sql(f"SELECT NOT has_recent AND assigned_user_id IS NULL FROM inbox_t2_bridge.filter_rows WHERE org_id='{o}' AND target_id='{ids[0]}'")=='t','Changed owner/expiry not projected')
sql(f"UPDATE inbox_t2_maintained.rows SET summary='{{\"exists\":false}}',revision=revision+1 WHERE org_id='{o}' AND target_id='{ids[1]}'")
need(sql(f"SELECT count(*) FROM inbox_t2_bridge.filter_rows WHERE org_id='{o}' AND target_id='{ids[1]}'")=='0','Tombstone not removed')
(P/'parity-evidence.json').write_text(json.dumps({'passed':True,'ordered_page_comparisons':cases,'maintained_owner_expiry_tombstone':True,'limitations':['Does not yet prove parent-property writer through entire asynchronous projection pipeline','Human name propagation unresolved']},indent=2)+'\n')
print(f'{cases} typed page parity cases and maintained changes passed')
