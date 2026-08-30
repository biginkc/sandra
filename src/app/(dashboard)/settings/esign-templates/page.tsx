import { PlusIcon } from "lucide-react";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { AddTemplateDialog } from "./add-template-dialog";
import { loadPendingTemplateCopies, loadTemplateLibrary } from "./template-lane-adapter";
import { TemplateLibrary } from "./template-library";
import { PendingTemplateCopies } from "./pending-template-copies";
import { TestModeBanner } from "./test-mode-banner";

export default async function EsignTemplatesPage() {
  const [result, pendingCopies] = await Promise.all([
    loadTemplateLibrary(),
    loadPendingTemplateCopies(),
  ]);

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Settings", href: "/settings/integrations" },
          { label: "eSign templates" },
        ]}
        title="eSign templates"
        description="Manage the test-mode Dropbox Sign templates used to prepare offers and agreements."
        actions={
          <AddTemplateDialog
            disabledReason={
              result.ok && pendingCopies.ok
                ? undefined
                : "Templates and pending copies must load before another template can be added."
            }
            trigger={
              <>
                <PlusIcon data-icon="inline-start" />
                Add template
              </>
            }
          />
        }
      />

      <TestModeBanner />

      <PendingTemplateCopies result={pendingCopies} />
      <TemplateLibrary result={result} actions={pendingCopies.ok ? undefined : null} />
    </Page>
  );
}
