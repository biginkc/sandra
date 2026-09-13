import { describe,it,expect } from "vitest";
import { finishGesture,moveGesture,toggleSelection,workspaceId,type Gesture } from "./selection";
const id=(n:string)=>workspaceId({kind:"conversation",orgId:"org",conversationId:n});
const a=id("a"),b=id("b"),hidden=id("hidden"),arrival=id("arrival");
const start=(extra:Partial<Gesture>={}):Gesture=>({origin:{x:0,y:0},current:{x:0,y:0},pointerId:1,target:a,shift:false,baseline:[a,b,hidden],eligible:[a,b],selected:[a,b,hidden],mode:"pending",...extra});
describe("workspace gesture identity",()=>{
 it("plain release collapses a group, Shift toggles without range selection",()=>{expect(finishGesture(start())).toEqual([a]);expect(finishGesture(start({shift:true}))).toEqual([b,hidden]);expect(toggleSelection([a],b)).toEqual([a,b]);});
 it("movement, not a hold delay, initiates dragging and retains a selected group",()=>{expect(moveGesture(start(),{x:3,y:0},[]).mode).toBe("pending");expect(moveGesture(start(),{x:4,y:0},[]).selected).toEqual([a,b,hidden]);expect(moveGesture(start({target:arrival}),{x:5,y:0},[]).selected).toEqual([arrival]);});
 it("rectangle adds encountered eligible IDs without admitting new arrivals or hidden rows",()=>{const g=start({shift:true,selected:[hidden],baseline:[hidden]});const rows=[a,arrival].map((id)=>({id,left:1,right:10,top:1,bottom:10}));const next=moveGesture(g,{x:12,y:12},rows);expect(next.mode).toBe("rectangle");expect(next.selected).toEqual([hidden,a]);expect(moveGesture(next,{x:30,y:30},[{id:b,left:20,right:25,top:20,bottom:25}]).selected).toEqual([hidden,a,b]);expect(g.baseline).toEqual([hidden]);});
 it("keeps tenant and target kind inside stable identity",()=>{expect(a).not.toBe(workspaceId({kind:"conversation",orgId:"other",conversationId:"a"}));expect(a).not.toBe(workspaceId({kind:"unknown_sender_group",orgId:"org",senderGroupId:"a"}));});
});
