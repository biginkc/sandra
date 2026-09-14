import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InboxWorkspace, type WorkspaceRow } from '../../src/components/inbox-workspace/inbox-workspace';
import { workspaceId, type WorkspaceId } from '../../src/components/inbox-workspace/selection';
import './preview.css';

const orgId = '00000000-0000-4000-8000-000000000001';
const rows: WorkspaceRow[] = Array.from({ length: 80 }, (_, index) => ({
  target: { kind: 'conversation', orgId, conversationId: `00000000-0000-4000-8000-${String(index+100).padStart(12,'0')}` },
  name: `Sample person ${String(index+1).padStart(2,'0')}`,
  context: `${100+index} Example Street · synthetic record`,
  preview: ['Could you send me more information?', 'Thanks. Next week would work for me.', 'I have a question about the property.', 'Let me think about it and get back to you.'][index%4],
  timeLabel: `${index+1}m`, outcomeLabel: index%3 ? 'No outcome' : 'Follow-up', assignedLabel: index%2 ? 'Unassigned' : 'Sample teammate', unread: index%3!==0,
}));
function Preview() {
  const [selectedIds, setSelected] = useState<readonly WorkspaceId[]>([]);
  const [openId, setOpen] = useState<WorkspaceId|null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [review, setReview] = useState(false);
  const [notice, setNotice] = useState('Synthetic preview. No customer data, messages, or updates.');
  const opened = rows.find(row=>workspaceId(row.target)===openId);
  const visible = unreadOnly ? rows.filter(row=>row.unread) : rows;
  return <><InboxWorkspace scopeLabel="Synthetic design preview" rows={visible} selectedIds={selectedIds} openId={openId}
    onSelectionChange={setSelected} onOpen={setOpen} onCloseDetail={()=>setOpen(null)}
    onBack={()=>setNotice('Overview navigation is not connected in this presentation preview.')}
    onReviewSelection={()=>setReview(true)} connection={{state:'offline',label:'Preview · no live connection'}}
    toolbar={<label className="preview-filter"><input type="checkbox" checked={unreadOnly} onChange={e=>setUnreadOnly(e.target.checked)}/> Unread only</label>}
    pageControl={<span>{visible.length} synthetic conversations · 80 total in this preview</span>}
    actions={[{id:'outcome',label:'Apply outcome',description:'Preview the selection passed to an action.'}, {id:'assign',label:'Assign',description:'A real action would review the eligible selection.'}, {id:'reply',label:'Prepare bulk reply',description:'Opens preparation in the completed product; this preview sends nothing.'}]}
    onAction={(action, ids)=>setNotice(`Preview action: ${action} · ${ids.length} selected. No operation was submitted.`)}
    detail={opened?{targetId:workspaceId(opened.target),title:opened.name,context:opened.context,state:'ready',content:<div className="preview-thread"><p className="preview-message">{opened.preview}</p><p>This is synthetic conversation content. Opening it does not mark anything read.</p><p>The real history adapter, reply composer, and read acknowledgment are not connected here.</p></div>}:undefined}
    activity={<p data-preview-notice>{notice}</p>}/>
    {review&&<dialog open className="preview-review" aria-label="Review selected conversations"><h2>{selectedIds.length} selected</h2><p>Remove individual conversations without losing the rest.</p><div>{selectedIds.map(id=><label key={id}><input type="checkbox" checked onChange={()=>setSelected(current=>current.filter(value=>value!==id))}/>{rows.find(row=>workspaceId(row.target)===id)?.name??'Selected conversation'}</label>)}</div><button type="button" onClick={()=>setReview(false)}>Close review</button></dialog>}
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
