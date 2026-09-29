import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InboxWorkspace, type WorkspaceRow } from "../../../src/components/inbox-workspace/inbox-workspace";
import { workspaceId, type WorkspaceId } from "../../../src/components/inbox-workspace/selection";

const orgId = "00000000-0000-4000-8000-000000000001";
const rows: WorkspaceRow[] = Array.from({ length: 120 }, (_, index) => {
  const id = `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
  return {
    target: { kind: "conversation", orgId, conversationId: id },
    name: `Person ${index}`,
    context: `${100 + index} Example Street`,
    preview: `Synthetic message ${index}`,
    timeLabel: `${index + 1}m`,
    outcomeLabel: "No outcome",
    assignedLabel: "Unassigned",
    unread: index % 2 === 0,
  };
});

function WorkloadFixture() {
  const [selectedIds, setSelectedIds] = useState<readonly WorkspaceId[]>([]);
  const [openId, setOpenId] = useState<WorkspaceId | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const opened = rows.find((row) => workspaceId(row.target) === openId);
  const record = (event: string) => setEvents((current) => [...current, event]);

  return (
    <>
      <style>{`html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}`}</style>
      <InboxWorkspace
        scopeLabel="Local workload contract"
        rows={rows}
        selectedIds={selectedIds}
        openId={openId}
        onSelectionChange={(ids) => {
          setSelectedIds(ids);
          record(`select:${ids.length}`);
        }}
        onOpen={(id) => {
          setOpenId(id);
          record(`inspect:${id}`);
        }}
        onCloseDetail={() => {
          setOpenId(null);
          record("close");
        }}
        onBack={() => record("back")}
        onReviewSelection={() => record("review")}
        actions={[]}
        onAction={(action, ids) => record(`action:${action}:${ids.length}`)}
        connection={{ state: "live", label: "Local deterministic transport" }}
        toolbar={<span data-testid="adapter-ready">Adapter ready</span>}
        pageControl={<span data-testid="resident-count">120 local rows</span>}
        detail={opened ? {
          targetId: openId!,
          title: opened.name,
          context: opened.context,
          state: "ready",
          content: <p data-testid="inspection">Inspection for {opened.name}</p>,
        } : undefined}
        activity={<output data-testid="transport-log">{events.join("|")}</output>}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<WorkloadFixture />);
