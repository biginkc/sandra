import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { SequenceEditor } from "@/app/(dashboard)/sequences/[id]/edit/editor";
import { DripsBrandFrame } from "../_frame";
import { editorFixture } from "../_editor-fixture";

export default function BrandDripsEditor() {
  return <DripsBrandFrame><Page><PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips", href: "/sequences" }, { label: "Quiet owner check-in" }]}
    title="Quiet owner check-in" description="38 leads enrolled · 4 steps over 90 days" />
    <SequenceEditor sequence={editorFixture} initialImpact={{ total_enrolled: 38, scheduled_next_7d: 7 }} templates={[]} />
  </Page></DripsBrandFrame>;
}
