import type { DecryptedEsignCredentials } from "./credentials";
import type {
  DropboxSignProvider,
  TemplateSnapshot,
} from "./contracts";
import { safeProviderFailure, type SafeProviderFailure } from "./provider-failure";
import type { StoreTemplateSnapshotInput } from "./database-adapter";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EsignExportOptions = {
  dryRun: boolean;
  orgId?: string;
};

export type ExportTemplateRow = {
  id: string;
  name: string;
  providerTemplateId: string;
};

export type TemplateExportCredentials = Pick<
  DecryptedEsignCredentials,
  "apiKey" | "clientId"
>;

export type TemplateExportProvider = Pick<
  DropboxSignProvider,
  "exportTemplateSnapshot"
>;

export type TemplateExportDependencies = {
  listOrganizationIds(): Promise<readonly string[]>;
  getCredentials(orgId: string): Promise<TemplateExportCredentials | null>;
  listTemplates(orgId: string): Promise<readonly ExportTemplateRow[]>;
  createProvider(credentials: TemplateExportCredentials): TemplateExportProvider;
  storeSnapshot(input: StoreTemplateSnapshotInput): Promise<void>;
  write(line: string): void;
};

export type TemplateExportSummary = {
  attempted: number;
  stored: number;
  dryRun: boolean;
  rows: number;
};

export type TemplateExportFailure = {
  orgId: string;
  templateId: string | null;
  templateName: string | null;
  error: SafeProviderFailure;
};

export class TemplateExportRunError extends Error {
  constructor(public readonly failures: readonly TemplateExportFailure[]) {
    super("One or more eSign template exports failed.");
    this.name = "TemplateExportRunError";
  }
}

export function parseOptions(
  argv: readonly string[],
): EsignExportOptions | { help: true } {
  let dryRun = false;
  let orgId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--org") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--org requires an organization UUID.");
      }
      orgId = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--org=")) {
      orgId = argument.slice("--org=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (orgId !== undefined && !UUID_PATTERN.test(orgId)) {
    throw new Error("--org requires an organization UUID.");
  }
  return { dryRun, ...(orgId ? { orgId } : {}) };
}

export async function runTemplateExport(input: {
  options: EsignExportOptions;
  dependencies: TemplateExportDependencies;
}): Promise<TemplateExportSummary> {
  const { options, dependencies } = input;
  const orgIds = options.orgId
    ? [options.orgId]
    : await dependencies.listOrganizationIds();
  const rows: Array<{
    orgId: string;
    templateName: string;
    providerTemplateId: string;
    pages: number;
    signerFields: number;
    mergeFields: number;
    sha256: string;
  }> = [];
  const failures: TemplateExportFailure[] = [];
  let attempted = 0;
  let stored = 0;

  for (const orgId of orgIds) {
    try {
      const credentials = await dependencies.getCredentials(orgId);
      if (!credentials) continue;
      const provider = dependencies.createProvider(credentials);
      const templates = await dependencies.listTemplates(orgId);
      for (const template of templates) {
        attempted += 1;
        try {
          const snapshot = await provider.exportTemplateSnapshot(
            template.providerTemplateId,
          );
          rows.push(
            exportRow(
              orgId,
              template.name,
              template.providerTemplateId,
              snapshot,
            ),
          );
          if (!options.dryRun) {
            await dependencies.storeSnapshot({
              orgId,
              templateId: template.id,
              pdf: snapshot.pdf,
              sha256: snapshot.sha256,
              layout: snapshot.layout,
            });
            stored += 1;
          }
        } catch (error) {
          failures.push({
            orgId,
            templateId: template.id,
            templateName: template.name,
            error: safeProviderFailure(error),
          });
        }
      }
    } catch (error) {
      failures.push({
        orgId,
        templateId: null,
        templateName: null,
        error: safeProviderFailure(error),
      });
    }
  }

  dependencies.write(formatTable(rows));
  if (failures.length > 0) {
    dependencies.write(
      JSON.stringify({ outcome: "export_failed", failures }),
    );
    throw new TemplateExportRunError(failures);
  }
  return { attempted, stored, dryRun: options.dryRun, rows: rows.length };
}

function exportRow(
  orgId: string,
  templateName: string,
  providerTemplateId: string,
  snapshot: TemplateSnapshot,
) {
  return {
    orgId,
    templateName,
    providerTemplateId,
    pages: pageCount(snapshot.layout),
    signerFields: snapshot.layout.documents.reduce(
      (count, document) =>
        count +
        document.fields.filter((field) => field.signer !== "sender").length,
      0,
    ),
    mergeFields: snapshot.layout.mergeFieldNames.length,
    sha256: snapshot.sha256,
  };
}

function pageCount(layout: TemplateSnapshot["layout"]): number {
  return layout.documents.reduce((total, document) => {
    const pages = new Set(document.fields.map((field) => field.page));
    return total + pages.size;
  }, 0);
}

function formatTable(rows: ReturnType<typeof exportRow>[]): string {
  const header =
    "org | template name | provider id | pages | signer fields | merge fields | sha256";
  if (rows.length === 0) return header;
  return [
    header,
    ...rows.map((row) =>
      [
        row.orgId,
        safeCell(row.templateName),
        safeCell(row.providerTemplateId),
        row.pages,
        row.signerFields,
        row.mergeFields,
        row.sha256,
      ].join(" | "),
    ),
  ].join("\n");
}

function safeCell(value: string): string {
  return value.replace(/[\r\n|]/g, " ").trim();
}
