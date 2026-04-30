import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { Wizard } from "./wizard";

export const metadata = {
  title: "Import · Sandra CRM",
};

export default function ImportPage() {
  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Import" }]}
        title="Import"
        description="Bring leads in from a CSV (DealMachine, PropStream, etc.) or update existing properties in bulk. Each upload runs as a background job — once it's started you can leave this page and watch progress on /jobs."
      />
      <Wizard />
    </Page>
  );
}
