#!/usr/bin/env tsx

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  parseOptions,
  runTemplateExport,
  TemplateExportRunError,
  type TemplateExportDependencies,
} from "@/lib/esign/template-export";
import { safeProviderFailure } from "@/lib/esign/provider-failure";
import type { TemplateSnapshotDatabaseClient } from "@/lib/esign/database-adapter";

export { parseOptions, runTemplateExport, TemplateExportRunError } from "@/lib/esign/template-export";

async function productionDependencies(): Promise<TemplateExportDependencies> {
  const [{ createAdminClient }, { createEsignTemplateSnapshotDatabaseAdapter }, { getEsignCredentials }, { createDropboxSignProvider }] =
    await Promise.all([
      import("@/lib/supabase/admin"),
      import("@/lib/esign/database-adapter"),
      import("@/lib/esign/credentials"),
      import("@/lib/esign/dropbox-sign"),
    ]);
  const admin = createAdminClient();
  const persistence = createEsignTemplateSnapshotDatabaseAdapter(
    admin as unknown as TemplateSnapshotDatabaseClient,
  );
  return {
    async listOrganizationIds() {
      const { data, error } = await admin
        .from("org_esign_integrations")
        .select("org_id")
        .eq("provider", "dropbox_sign")
        .not("api_key_encrypted", "is", null)
        .not("client_id", "is", null)
        .not("provider_account_id", "is", null)
        .order("org_id", { ascending: true });
      if (error) {
        throw new Error("Failed to list organizations with eSign credentials.");
      }
      return (data ?? []).map((row) => row.org_id);
    },
    getCredentials: getEsignCredentials,
    async listTemplates(orgId) {
      const { data, error } = await admin
        .from("esign_templates")
        .select("id,name,sign_template_id")
        .eq("org_id", orgId)
        .eq("lifecycle_state", "finalized")
        .not("finalized_at", "is", null)
        .is("deleted_at", null)
        .is("layout_exported_at", null)
        .not("sign_template_id", "is", null)
        .order("updated_at", { ascending: true });
      if (error) throw new Error("Failed to list finalized eSign templates.");
      return (data ?? []).flatMap((row) =>
        row.sign_template_id
          ? [{
              id: row.id,
              name: row.name,
              providerTemplateId: row.sign_template_id,
            }]
          : [],
      );
    },
    createProvider(credentials) {
      return createDropboxSignProvider({
        apiKey: credentials.apiKey,
        clientId: credentials.clientId,
      });
    },
    storeSnapshot: persistence.storeTemplateSnapshot,
    write(line) {
      console.log(line);
    },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseOptions(argv);
    if ("help" in parsed) {
      console.log(
        "Usage: npm run esign:export-templates -- [--dry-run] [--org <uuid>]",
      );
      return 0;
    }
    await runTemplateExport({
      options: parsed,
      dependencies: await productionDependencies(),
    });
    return 0;
  } catch (error) {
    if (error instanceof TemplateExportRunError) {
      console.error(
        JSON.stringify({
          outcome: "export_failed",
          message: "One or more eSign template exports failed.",
          failures: error.failures,
        }),
      );
    } else {
      console.error(JSON.stringify(safeProviderFailure(error)));
    }
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
