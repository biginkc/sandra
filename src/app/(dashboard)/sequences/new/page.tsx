import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { getSequenceAdminStatus } from "../admin";
import { CreateSequenceForm } from "./form";

export default async function NewSequencePage() {
  if (!(await getSequenceAdminStatus())) redirect("/leads");

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Sequences", href: "/sequences" },
          { label: "New" },
        ]}
        title="New sequence"
        description="Name it and describe what it's for. You'll add steps on the next screen."
      />
      <CreateSequenceForm />
    </Page>
  );
}
