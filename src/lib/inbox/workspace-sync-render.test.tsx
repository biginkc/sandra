import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { InboxWorkspace } from "@/components/inbox-workspace/inbox-workspace";
import { summaryRow } from "./workspace-sync";
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("shows Unread only for known unread rows and does not invent a label for unknown null",()=>{
  vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockReturnValue(new DOMRect(0,0,900,600));
  vi.spyOn(HTMLElement.prototype,"offsetHeight","get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype,"offsetWidth","get").mockReturnValue(900);
  const shared={org_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",target_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",context:"Context",preview:"Message",time_label:"Now",outcome_label:"New",assigned_label:"Unassigned"};
  const rows=[summaryRow({...shared,target_kind:"known_conversation",name:"Known",unread:true}),summaryRow({...shared,target_kind:"unknown_sender",name:"Unknown",unread:null})];
  render(<InboxWorkspace scopeLabel="Test" rows={rows} selectedIds={[]} openId={null} onSelectionChange={vi.fn()} onOpen={vi.fn()} onCloseDetail={vi.fn()} onBack={vi.fn()} onReviewSelection={vi.fn()} actions={[]} onAction={vi.fn()} connection={{state:"live",label:"Live"}}/>);
  expect(screen.getAllByText("Unread")).toHaveLength(1);
  const unknown=screen.getByText("Unknown").closest('[role="listitem"]') as HTMLElement;
  expect(within(unknown).queryByText("Unread")).not.toBeInTheDocument();
  expect(within(unknown).queryByText("Read")).not.toBeInTheDocument();
});
