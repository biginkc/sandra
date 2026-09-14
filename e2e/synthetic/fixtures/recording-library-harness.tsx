import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RecordingLibrary } from '@/components/recordings/library';
function Harness() {
 const [scope,setScope]=useState<'owner'|'mine'>('owner');
 const result={viewerId:'synthetic-viewer',nextCursor:null,total:1,availability:{available:1,external:1,failed:0},sources:['sandra_softphone','manual'],outcomes:['connected_human'],users:[{id:'synthetic-user',name:'Example acquisitions member'}],rows:[{id:'call:example',at:'2026-09-14T16:30:00Z',actor_id:'synthetic-user',actor_name:'Example acquisitions member',conflicting:false,source:'sandra_softphone',outcome:'connected_human',direction:'outbound',purpose:'customer',contact:'Example contact',address:'123 Example Street, Kansas City, MO',phone:'+15555550100',property_id:null,missing_association:false,transcript:true,summary:true,status:'available',files:[{id:'example-file-a',duration:155,status:'available',kind:'stored'},{id:'example-file-b',duration:45,status:'available',kind:'stored'}]}]};
 return <><aside className="border-b bg-muted p-4 text-sm">Synthetic visual preview · <button onClick={()=>setScope(scope==='owner'?'mine':'owner')} className="underline">Switch to {scope==='owner'?'My Recordings':'Recordings'}</button><output id="last-navigation" className="block break-all"/></aside><RecordingLibrary key={scope} scope={scope} values={{}} result={result}/></>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
