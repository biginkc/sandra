import { PlusIcon } from "lucide-react";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { getEsignConnectionStatus } from "@/lib/esign/actions";

import { AddTemplateDialog } from "./add-template-dialog";
import { loadPendingTemplateCopies, loadTemplateLibrary } from "./template-lane-adapter";
import { TemplateLibrary } from "./template-library";
import { PendingTemplateCopies } from "./pending-template-copies";
import { EsignModeBanner } from "./test-mode-banner";

export default async function EsignTemplatesPage() {
  const [result, pendingCopies, esignStatus] = await Promise.all([
    loadTemplateLibrary(),
    loadPendingTemplateCopies(),
    getEsignConnectionStatus(),
  ]);
  const dropboxSignStatusUnavailable =
    !esignStatus.ok || esignStatus.data.statusUnavailable === true;
  const dropboxSignDisconnected =
    !dropboxSignStatusUnavailable && !esignStatus.data.connected;
  const addTemplateDisabledReason = dropboxSignStatusUnavailable
    ? "Dropbox Sign status is temporarily unavailable."
    : dropboxSignDisconnected
    ? "Connect Dropbox Sign before adding templates."
    : result.ok && pendingCopies.ok
      ? undefined
      : "Templates and pending copies must load before another template can be added.";

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Settings", href: "/settings/integrations" },
          { label: "eSign templates" },
        ]}
        title="eSign templates"
        description="Register website-created Dropbox Sign templates for Sandra sends. Embedded editing stays off unless the server capability is enabled."
        actions={
          <AddTemplateDialog
            disabledReason={addTemplateDisabledReason}
            trigger={
              <>
                <PlusIcon data-icon="inline-start" />
                Add template
              </>
            }
          />
        }
      />

      <EsignModeBanner
        testMode={dropboxSignStatusUnavailable ? null : esignStatus.data.testMode}
      />

      <PendingTemplateCopies result={pendingCopies} />
      <TemplateLibrary
        result={result}
        actions={pendingCopies.ok ? undefined : null}
        dropboxSignConnected={
          !dropboxSignStatusUnavailable && !dropboxSignDisconnected
        }
        templateCreationDisabledReason={addTemplateDisabledReason}
      />
    </Page>
  );
}
