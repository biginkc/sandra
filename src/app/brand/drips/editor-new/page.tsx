import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { SequenceEditor } from "@/app/(dashboard)/sequences/[id]/edit/editor";
import { DripsBrandFrame } from "../_frame";
import { editorFixture } from "../_editor-fixture";

export default function BrandDripsNewEditor() {
  return <DripsBrandFrame><Page><PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips", href: "/sequences" }, { label: "New drip" }]}
    title="New drip" description="Details saved. Add your first step." />
    <SequenceEditor sequence={{ ...editorFixture, name: "New drip", description: "", steps: [] }}
      initialImpact={{ total_enrolled: 0, scheduled_next_7d: 0 }} templates={[]} isNew />
  </Page></DripsBrandFrame>;
}
