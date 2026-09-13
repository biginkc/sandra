#!/usr/bin/env python3
import runpy,json,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
v=runpy.run_path(str(P/'parity-test.py'));sql=v['sql'];need=v['need'];o=v['o'];u=v['u'];prefix=v['prefix'];ids=v['ids'];contact=str(uuid.uuid4())
sql(f"INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{contact}','{o}','Zephyr Literal%Token','+15551234567','mobile');UPDATE inbox_t2_maintained.rows SET summary=summary||jsonb_build_object('contact_id','{contact}'),revision=revision+1 WHERE org_id='{o}' AND target_id='{ids[0]}'")
sql(f"INSERT INTO messages(id,org_id,conversation_id,contact_id,channel,direction,status,body,created_at) VALUES('{uuid.uuid4()}','{o}','{ids[2]}','{contact}','sms','inbound','received','quartzprefix ancient body',clock_timestamp()-interval '500 days')")
def matches(q):
 f=json.dumps({'view':'all','hide_noise':False,'search':q}).replace("'","''")
 return json.loads(sql(f"SELECT coalesce(jsonb_agg(target_id),'[]') FROM inbox_t2_bridge.matching('{o}','{u}',inbox_t2_bridge.normalize_filter('{f}'))"))
need(matches('Zephyr')==[ids[0]],'contact search')
need(matches('555123')==[ids[0]],'phone digits search')
need(matches('quartzpref')==[ids[2]],'deep canonical FTS outside resident page')
need(matches('Literal%Token')==[ids[0]] and matches('Literal_Token')==[],'wildcards escaped')
need(len(matches('qu'))==3,'short search no filter')
need(sql("SELECT length(inbox_t2_bridge.normalize_filter(jsonb_build_object('view','all','search',repeat('z',150)))->>'search')")=='100','search cap')
counts=json.loads(sql(prefix+f"SELECT public.inbox_counts_v2('{o}','{{\"view\":\"all\",\"hide_noise\":false}}')"))
need(counts['counts']['all']==3 and counts['counts']['mine']==1 and counts['counts']['unread']==1,'independent overlapping counts')
(P/'search-evidence.json').write_text(json.dumps({'passed':True,'checks':['canonical contact search','phone digits','SMS full history FTS older than 500 days outside first page','literal wildcard escaping','short search disabled','100 character cap','overlapping independent counts'],'limitations':['Small synthetic fixture, no realistic-volume performance claim']},indent=2)+'\n')
(P/'v2-rpc-sample.json').write_text(json.dumps({'scope':v['w2'],'counts':counts},indent=2)+'\n')
print('Canonical search and independent count checks passed')
