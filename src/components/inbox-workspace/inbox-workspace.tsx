"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { finishGesture, moveGesture, rectangle, toggleSelection, workspaceId, type Gesture, type WorkspaceId, type WorkspaceTarget } from "./selection";
import { useVirtualizer } from "@tanstack/react-virtual";
import styles from "./workspace.module.css";

export interface WorkspaceRow {
  target: WorkspaceTarget; name: string; context: string; preview: string;
  timeLabel: string; outcomeLabel: string; assignedLabel: string;
  unread?: boolean; pendingLabel?: string; error?: string;
}
export interface WorkspaceAction {
  id: string; label: string; description?: string; prominent?: boolean;
  disabledReason?: string; pending?: boolean; error?: string;
}
export interface InboxWorkspaceProps {
  scopeLabel: string;
  /** Bounded resident slice only; maximum 500. The data adapter owns working-set paging. */
  rows: readonly WorkspaceRow[];
  selectedIds: readonly WorkspaceId[];
  openId: WorkspaceId | null;
  /** Authoritative removals only; absence from resident rows is not revocation. */
  invalidatedIds?: readonly WorkspaceId[];
  onSelectionChange: (ids: readonly WorkspaceId[]) => void;
  onOpen: (id: WorkspaceId) => void;
  onCloseDetail: () => void;
  onBack: () => void;
  onReviewSelection: () => void;
  actions: readonly WorkspaceAction[];
  /** Both click and drop request the SAME preparation/review flow; never direct dispatch. */
  onAction: (actionId: string, ids: readonly WorkspaceId[]) => void;
  connection: { state: "live" | "updating" | "offline" | "permission_lost"; label: string };
  toolbar?: ReactNode;
  listState?: "ready" | "loading";
  listError?: string;
  onRetryList?: () => void;
  pageControl?: ReactNode;
  detail?: { targetId: WorkspaceId; title: string; context?: string; state: "ready" | "loading" | "error"; content?: ReactNode; error?: string; onRetry?: () => void; headerActions?: ReactNode };
  activity?: ReactNode;
  newMessagesLabel?: string;
  onRefreshRows?: () => void;
  /** Adapter must apply deferred row reordering after this returns false. */
  onGestureChange?: (active: boolean) => void;
}

/** Controlled client presentation. Mount from a client adapter; callbacks are not RSC-serializable. */
export function InboxWorkspace(props: InboxWorkspaceProps) {
  "use no memo"; // TanStack Virtual exposes a mutable virtualizer; do not compiler-memoize it.
  const [frozenRows,setFrozenRows]=useState<readonly WorkspaceRow[]|null>(null);
  const selectedIds=props.selectedIds.filter((id)=>!props.invalidatedIds?.includes(id));
  const openId=props.openId && !props.invalidatedIds?.includes(props.openId) ? props.openId : null;
  const detail=props.detail?.targetId===openId?props.detail:undefined;
  const currentRows=new Map(props.rows.map((row)=>[workspaceId(row.target),row]));
  const rows=(frozenRows??props.rows).map((row)=>currentRows.get(workspaceId(row.target))??row).filter((row)=>!props.invalidatedIds?.includes(workspaceId(row.target)));
  if(props.rows.length>500) throw new Error("InboxWorkspace accepts at most 500 resident rows; page the working set first.");
  const hintId=useId();
  const list=useRef<HTMLDivElement>(null);
  const gesture=useRef<Gesture|null>(null);
  const closeButton=useRef<HTMLButtonElement>(null);
  const actionRail=useRef<HTMLElement>(null);
  const openButtons=useRef(new Map<WorkspaceId,HTMLButtonElement>());
  // eslint-disable-next-line react-hooks/incompatible-library -- Explicit compiler opt-out above; mutable virtualizer never leaves this component.
  const virtualizer=useVirtualizer({count:rows.length,getScrollElement:()=>list.current,estimateSize:()=>72,getItemKey:(index)=>workspaceId(rows[index].target),overscan:5,initialRect:{width:900,height:600}});
  const pointer=useRef({x:0,y:0});
  const latest=useRef(props); latest.current=props;
  const suppressClick=useRef(false);
  const [visual,setVisual]=useState<Gesture|null>(null);
  const [dropId,setDropId]=useState<string|null>(null);
  const resident=new Set(rows.map((row)=>workspaceId(row.target)));
  const hidden=selectedIds.filter((id)=>!resident.has(id)).length;
  const blocked=props.connection.state==="permission_lost";
  const interactive=(target: EventTarget|null)=>target instanceof Element && !!target.closest("button,input,a,textarea,select,[contenteditable=true],[data-no-selection]");
  function allowed(ids:readonly WorkspaceId[]){return ids.filter((id)=>!latest.current.invalidatedIds?.includes(id));}
  function select(ids:readonly WorkspaceId[]){if(latest.current.connection.state!=="permission_lost")latest.current.onSelectionChange(allowed(ids));}
  function closeDetail(){props.onCloseDetail();requestAnimationFrame(()=>{(openId?openButtons.current.get(openId):null)?.focus();if(!openId||!openButtons.current.has(openId))list.current?.focus();});}
  useEffect(()=>{if(openId)closeButton.current?.focus();},[openId]);
  useEffect(()=>{if(blocked){gesture.current=null;setVisual(null);setFrozenRows(null);setDropId(null);latest.current.onGestureChange?.(false);}},[blocked]);
  function hitAction(x:number,y:number){const node=document.elementFromPoint?.(x,y)?.closest<HTMLElement>("[data-workspace-action]");return node&&actionRail.current?.contains(node)?node.dataset.workspaceAction:undefined;}
  function point(x:number,y:number){const el=list.current!;const r=el.getBoundingClientRect();return {x:x-r.left+el.scrollLeft,y:y-r.top+el.scrollTop};}
  function move(x:number,y:number){
    const el=list.current; const g=gesture.current;if(!el||!g)return;
    const viewport=el.getBoundingClientRect();
    const bounds=[...el.querySelectorAll<HTMLElement>("[data-workspace-row]")].filter((node)=>{
      const r=node.getBoundingClientRect();return r.bottom>viewport.top && r.top<viewport.bottom;
    }).map((node)=>{const r=node.getBoundingClientRect();const a=point(r.left,r.top);const b=point(r.right,r.bottom);return {id:node.dataset.workspaceRow as WorkspaceId,left:a.x,top:a.y,right:b.x,bottom:b.y};});
    const next=moveGesture(g,point(x,y),bounds);gesture.current=next;if(next!==g)setVisual(next);
    if(next.selected!==g.selected)select(next.selected);
    if(next.mode==="action")setDropId(hitAction(x,y)??null);
  }
  function end(cancel:boolean,x?:number,y?:number){
    const g=gesture.current;if(!g)return;
    gesture.current=null;setVisual(null);setFrozenRows(null);setDropId(null);latest.current.onGestureChange?.(false);
    const el=list.current;if(el?.hasPointerCapture?.(g.pointerId))el.releasePointerCapture(g.pointerId);
    if(cancel){suppressClick.current=true;select(g.baseline);return;}
    select(finishGesture(g));
    if(g.mode==="action" && x!==undefined && y!==undefined){
      const actionId=hitAction(x,y);
      const action=latest.current.actions.find((a)=>a.id===actionId);
      if(action && !action.pending && !action.disabledReason && allowed(g.selected).length && latest.current.connection.state!=="permission_lost")latest.current.onAction(action.id,allowed(g.selected));
    }
  }
  useEffect(()=>{
    function escape(e:KeyboardEvent){if(e.key==="Escape" && !e.defaultPrevented && gesture.current){e.preventDefault();end(true);}}
    function blur(){end(true);}
    window.addEventListener("keydown",escape);window.addEventListener("blur",blur);
    return ()=>{window.removeEventListener("keydown",escape);window.removeEventListener("blur",blur);if(gesture.current){latest.current.onGestureChange?.(false);gesture.current=null;}};
    // Handlers intentionally read current controlled callbacks through latest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>{
    if(!visual || visual.mode!=="rectangle")return;
    let frame:number;
    const tick=()=>{const el=list.current;if(!el||!gesture.current)return;const r=el.getBoundingClientRect();const y=pointer.current.y;const step=y<r.top+28?-12:y>r.bottom-28?12:0;
      if(step)el.scrollTop+=step;move(pointer.current.x,y);frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);return ()=>cancelAnimationFrame(frame);
    // Active gesture refs keep geometry/current callbacks fresh without restarting each frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[visual?.mode]);
  function down(e:ReactPointerEvent<HTMLDivElement>){
    if(e.button!==0 || e.pointerType==="touch" || interactive(e.target) || gesture.current || blocked)return;
    const node=(e.target as Element).closest<HTMLElement>("[data-workspace-row]");if(!node&&!e.shiftKey)return;
    suppressClick.current=false;
    const start=point(e.clientX,e.clientY);pointer.current={x:e.clientX,y:e.clientY};
    gesture.current={origin:start,current:start,pointerId:e.pointerId,target:node?.dataset.workspaceRow as WorkspaceId ?? null,shift:e.shiftKey,baseline:[...selectedIds],selected:[...selectedIds],eligible:rows.map((r)=>workspaceId(r.target)),mode:"pending"};
    setFrozenRows(rows);setVisual(gesture.current);
    e.currentTarget.setPointerCapture?.(e.pointerId);props.onGestureChange?.(true);
  }
  function clickAction(action:WorkspaceAction){if(!action.pending&&!action.disabledReason&&allowed(selectedIds).length&&!blocked)props.onAction(action.id,allowed(selectedIds));}
  const box=visual?.mode==="rectangle"?rectangle(visual.origin,visual.current):null;
  return <section className={styles.workspace} aria-label={`Inbox workspace: ${props.scopeLabel}`}>
    <header className={styles.header}><strong>SANDRA</strong><button type="button" onClick={props.onBack}>← Back to Inbox overview</button><h1>Inbox workspace</h1><span>{props.scopeLabel}</span></header>
    {blocked?<div className={styles.access} role="alert">{props.connection.label}</div>:<>
    <div className={styles.toolbar}><div>{props.toolbar}</div><span className={styles.connection} role="status">{props.connection.label}</span></div>
    <div className={`${styles.body} ${openId?styles.withDetail:""}`}>
      <section className={styles.listPane} aria-label="Conversation selection">
        <div className={styles.selection}><strong aria-live="polite">{selectedIds.length} selected{hidden?` · ${hidden} not loaded here`:""}</strong><button type="button" onClick={props.onReviewSelection} disabled={!selectedIds.length}>Review selection</button><button type="button" onClick={()=>select([])} disabled={!selectedIds.length}>Clear</button></div>
        <p className={styles.hint} id={hintId}>Click selects one · Shift-click adds/removes · Shift-drag draws a box. Or use checkboxes.</p>
        {props.newMessagesLabel&&<button className={styles.arrivals} type="button" disabled={!!visual||!props.onRefreshRows} onClick={props.onRefreshRows}>{props.newMessagesLabel}</button>}
        {props.listError&&<div role="alert" className={styles.error}>{props.listError}{props.onRetryList&&<button type="button" onClick={props.onRetryList}>Retry list</button>}</div>}
        <div ref={list} className={styles.list} role="list" tabIndex={-1} aria-label="Inbox conversations" aria-describedby={hintId} aria-busy={props.listState==="loading"}
          onPointerDown={down} onPointerMove={(e)=>{if(gesture.current?.pointerId===e.pointerId){pointer.current={x:e.clientX,y:e.clientY};move(e.clientX,e.clientY);if(gesture.current?.mode!=="pending")e.preventDefault();}}}
          onPointerUp={(e)=>{if(gesture.current?.pointerId===e.pointerId){suppressClick.current=true;move(e.clientX,e.clientY);end(false,e.clientX,e.clientY);setTimeout(()=>{suppressClick.current=false;},0);}}}
          onPointerCancel={()=>end(true)} onLostPointerCapture={()=>end(true)}>
          {props.listState==="loading"&&!rows.length?<p className={styles.empty} role="status">Loading conversations…</p>:!rows.length?<p className={styles.empty}>No conversations in this view.</p>:<div className={styles.canvas} style={{height:virtualizer.getTotalSize()}}>{virtualizer.getVirtualItems().map((item)=>{const row=rows[item.index];const id=workspaceId(row.target);const selected=selectedIds.includes(id);const opened=id===openId;return <div role="listitem" tabIndex={0} aria-label={`${row.name}${selected?", selected":""}${opened?", open":""}. Enter opens conversation.`} aria-posinset={item.index+1} aria-setsize={rows.length} onKeyDown={(e)=>{if(e.key==="Enter"&&e.target===e.currentTarget){e.preventDefault();props.onOpen(id);}}} style={{position:"absolute",top:item.start,left:0,width:"100%",height:item.size}} data-workspace-row={id} key={id} className={`${styles.row} ${selected?styles.selected:""} ${opened?styles.opened:""}`}
            onClick={(e)=>{if(suppressClick.current||interactive(e.target))return;select(e.shiftKey?toggleSelection(selectedIds,id):[id]);}}>
            <input type="checkbox" checked={selected} aria-label={`Select ${row.name}`} onChange={()=>select(toggleSelection(selectedIds,id))}/>
            <div className={styles.person}><strong>{row.name}</strong>{opened&&<span className={styles.openBadge}>Open</span>}{row.unread&&<span className={styles.unread}>Unread</span>}<small>{row.context}</small></div>
            <div className={styles.preview}>{row.preview}{row.pendingLabel&&<small role="status">{row.pendingLabel}</small>}{row.error&&<small className={styles.error}>{row.error}</small>}</div>
            <span className={styles.outcome}>{row.outcomeLabel}</span><span className={styles.assignee}>{row.assignedLabel}</span><span className={styles.time}>{row.timeLabel}</span>
            <button ref={(node)=>{if(node)openButtons.current.set(id,node);else openButtons.current.delete(id);}} type="button" onClick={()=>props.onOpen(id)} aria-label={`Open ${row.name}`}>Open ›</button>
          </div>;})}</div>}
          {box&&<div aria-hidden="true" className={styles.rectangle} style={{left:box.left,top:box.top,width:box.right-box.left,height:box.bottom-box.top}}/>}
        </div><footer className={styles.page}>{props.pageControl}</footer>
      </section>
      {openId&&<aside className={styles.detail} aria-label="Open conversation"><header><div><h2>{detail?.title??"Conversation"}</h2><p>{detail?.context}</p>{detail?.headerActions&&<div className="mt-2 flex flex-wrap gap-2">{detail.headerActions}</div>}</div><button ref={closeButton} type="button" onClick={closeDetail} aria-label="Close conversation details">Close</button></header><div className={styles.detailContent}>{!detail||detail.state==="loading"?<p role="status">Loading conversation…</p>:detail.state==="error"?<div role="alert">{detail.error??"Conversation unavailable."}{detail.onRetry&&<button type="button" onClick={detail.onRetry}>Retry conversation</button>}</div>:detail.content}</div></aside>}
      <aside ref={actionRail} className={styles.actions} aria-label="Actions for selection"><h2>Actions · click or drop</h2><p className={styles.dragStatus} role="status">{visual?.mode==="action"?`Dragging ${visual.selected.length} selected · Escape to cancel`:selectedIds.length?`${selectedIds.length} selected · click or drag`:"Select conversations to act"}</p>{props.actions.map((action)=><div key={action.id}><button type="button" data-workspace-action={action.id} className={`${styles.action} ${action.prominent?styles.prominent:""} ${dropId===action.id?styles.drop:""}`} disabled={!selectedIds.length||action.pending||!!action.disabledReason} onClick={()=>clickAction(action)}><span>{action.label}</span>{action.pending&&<small>In progress…</small>}</button>{(action.disabledReason||action.description)&&<small>{action.disabledReason??action.description}</small>}{action.error&&<p role="alert" className={styles.error}>{action.error}</p>}</div>)}{!props.actions.length&&<p>No actions available.</p>}{props.activity&&<div className={styles.activity}>{props.activity}</div>}</aside>
    </div></>}
  </section>;
}
