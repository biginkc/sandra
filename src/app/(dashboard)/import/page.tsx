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
        description="Bring leads in from a CSV (DealMachine, Zillow, MLS, generic) or update existing properties in bulk. Each upload runs as a background job — close the tab and come back; the queue picks up where it left off."
      />
      <Wizard />
    </Page>
  );
}
