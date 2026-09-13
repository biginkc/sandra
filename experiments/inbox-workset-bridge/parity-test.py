#!/usr/bin/env python3
"""Candidate predicate/keyset tests; requires installed parity-v2.sql and T2 grant."""
import runpy,json,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
v=runpy.run_path(str(P/'test.py'));sql=v['sql'];need=v['need'];o=v['o'];u=v['u'];prefix=v['prefix']
ids=[str(uuid.uuid4()) for _ in range(3)];checks=[]
for i,c in enumerate(ids):
 s={'exists':True,'contact_name':'Parity','has_recent':True,'is_noise':i==2,'property_status':'new_lead','assigned_user_id':u if i==0 else None,'unread_count':1 if i==0 else 0,'last_message_at':f'2026-09-13T10:00:00.00000{3-i}+00:00','visible_all_hide_noise':i!=2,'visible_all_show_noise':True}
 sql(f"INSERT INTO inbox_t2_maintained.rows VALUES('{o}','known_conversation','{c}',1,1,'{json.dumps(s)}',null)")
def count(view,hide=True):
 f=json.dumps({'view':view,'hide_noise':hide})
 return int(sql(f"SELECT count(*) FROM inbox_t2_bridge.matching('{o}','{u}',inbox_t2_bridge.normalize_filter('{f}'))"))
need(count('all')==2 and count('all',False)==3,'hide noise parity')
need(count('mine')==1 and count('unassigned')==1 and count('unread')==1,'assignment/unread predicates');checks.append('mine, unassigned, unread and noise predicates')
def create(cursor=None,view='all'):
 sql(f"UPDATE inbox_t2_bridge.worksets SET created_at=created_at-interval '2 seconds',revoked=true WHERE user_id='{u}' AND id NOT IN(SELECT scope_id FROM inbox_t2_bridge.cursors)")
 sql(f"UPDATE inbox_t2_bridge.worksets SET created_at=created_at-interval '2 seconds' WHERE user_id='{u}'")
 return json.loads(sql(prefix+f"SELECT public.inbox_create_workset_v2('{o}','{{\"view\":\"{view}\",\"hide_noise\":false}}',1,null,"+(f"'{cursor}'" if cursor else 'null')+")"))
w=create();need(w['targets'][0]['id']==ids[0] and w['next_cursor'],'first precision page')
w2=create(w['next_cursor']);need(w2['targets'][0]['id']==ids[1],'microsecond precision skipped row');checks.append('opaque cursor preserves microseconds')
# Preserve cursor source, release other active scope so cap is not the rejection reason.
sql(f"UPDATE inbox_t2_bridge.worksets SET revoked=true WHERE id='{w['id']}'; UPDATE inbox_t2_bridge.worksets SET created_at=created_at-interval '2 seconds' WHERE user_id='{u}'")
r=sql(prefix+f"SELECT public.inbox_create_workset_v2('{o}','{{\"view\":\"unread\",\"hide_noise\":false}}',1,null,'{w2['next_cursor']}')",False)
need(r.returncode!=0 and 'INBOX_CURSOR_DENIED' in r.stderr,'filter cursor mismatch');checks.append('cursor filter binding')
# Unknown cursor and expired originating scope must fail closed, with rate gate clear.
for cursor in [str(uuid.uuid4()),w2['next_cursor']]:
 if cursor==w2['next_cursor']:sql(f"UPDATE inbox_t2_bridge.worksets SET expires_at=clock_timestamp()-interval '1 second' WHERE id='{w2['id']}'")
 r=sql(prefix+f"SELECT public.inbox_create_workset_v2('{o}','{{\"view\":\"all\",\"hide_noise\":false}}',1,null,'{cursor}')",False)
 need(r.returncode!=0 and 'INBOX_CURSOR_DENIED' in r.stderr,'unknown or expired cursor accepted')
checks.append('unknown and expired cursors denied')
(P/'parity-evidence.json').write_text(json.dumps({'passed':True,'checks':checks,'limitations':['Synthetic maintained rows test predicates; not full canonical source parity','Search cases and realistic plans still required']},indent=2)+'\n')
print('Candidate parity/keyset cases passed')
