#!/usr/bin/env python3
import runpy,json
from pathlib import Path
P=Path(__file__).resolve().parent
v=runpy.run_path(str(P/'test.py'));sql=v['sql'];need=v['need'];o=v['o'];u=v['u'];prefix=v['prefix']
sql(f"UPDATE inbox_t2_bridge.worksets SET revoked=true,created_at=created_at-interval '2 seconds' WHERE user_id='{u}'; INSERT INTO inbox_t2_bridge.summaries SELECT '{o}','known_conversation',gen_random_uuid(),1,1,'Partition owned','','','','','',true,clock_timestamp(),true,false,false,true FROM generate_series(1,501)")
w=json.loads(sql(prefix+f"SELECT public.inbox_create_workset('{o}','{{\"view\":\"active\"}}',500,null)"))
need(len(w['targets'])==500 and w['handles']==[None]*5,'Partition cap violated')
for i in range(5):
 need(sql(prefix+f"SELECT public.inbox_bind_sync_handle('{w['id']}',{i},NULL,'shape-{i}')")=='t','Partition CAS failed')
 need(sql(prefix+f"SELECT public.inbox_bind_sync_handle('{w['id']}',{i},NULL,'forged')")=='f','Stale CAS succeeded')
for i in [-1,5,999]:need(sql(prefix+f"SELECT public.inbox_bind_sync_handle('{w['id']}',{i},NULL,'extra')")=='f','Extra partition accepted')
actual=json.loads(sql(prefix+f"SELECT public.inbox_get_sync_scope('{w['id']}')"));need(actual['handles']==[f'shape-{i}' for i in range(5)],'Partition handle interference')
(P/'rpc-sample.json').write_text(json.dumps({'authorize':json.loads(sql(prefix+f"SELECT public.inbox_authorize_sync('{o}')")),'scope':actual},indent=2)+'\n')
(P/'partition-evidence.json').write_text(json.dumps({'passed':True,'targets':500,'partitions':5,'cas_per_partition':True,'extra_partitions_denied':[-1,5,999],'scalar_rpc_sample':'rpc-sample.json'},indent=2)+'\n')
print('500 typed members, five independent CAS handles, forged partitions denied')
