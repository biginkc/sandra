import "server-only";

import {
  AccountApi,
  ApiAppApi,
  EmbeddedApi,
  HttpError,
  SignatureRequestApi,
  SubMergeField,
  TemplateApi,
  type SignatureRequestSendWithTemplateRequest,
  type SignatureRequestUpdateRequest,
} from "@dropbox/sign";

import { ProviderError } from "@/lib/errors/classes";

import type {
  DropboxSignProvider,
  CreateEmbeddedTemplateDraftInput,
  SendWithTemplateInput,
  SendWithTemplateOutput,
  ProviderTemplateMetadata,
  TemplatePdf,
} from "./contracts";
import { EsignSecret } from "./secret";

type DropboxApiSet = {
  account: AccountApi;
  apiApp: ApiAppApi;
  embedded: EmbeddedApi;
  signatureRequest: SignatureRequestApi;
  template: TemplateApi;
};

function authenticatedApiSet(apiKey: EsignSecret): DropboxApiSet {
  const account = new AccountApi();
  const apiApp = new ApiAppApi();
  const embedded = new EmbeddedApi();
  const signatureRequest = new SignatureRequestApi();
  const template = new TemplateApi();
  for (const api of [account, apiApp, embedded, signatureRequest, template]) {
    api.username = apiKey.reveal();
    api.password = "";
  }
  return { account, apiApp, embedded, signatureRequest, template };
}

function abortableSignatureApi(apiKey: EsignSecret, signal?: AbortSignal) {
  const signatureRequest = new SignatureRequestApi();
  signatureRequest.username = apiKey.reveal();
  signatureRequest.password = "";
  if (signal) {
    signatureRequest.addInterceptor((options) => {
      options.signal = signal;
    });
  }
  return signatureRequest;
}

function abortableTemplateApi(apiKey: EsignSecret, signal?: AbortSignal) {
  const template = new TemplateApi();
  template.username = apiKey.reveal();
  template.password = "";
  if (signal) {
    template.addInterceptor((options) => {
      options.signal = signal;
    });
  }
  return template;
}

function abortableAccountApi(apiKey: EsignSecret, signal?: AbortSignal) {
  const account = new AccountApi();
  account.username = apiKey.reveal();
  account.password = "";
  if (signal) {
    account.addInterceptor((options) => {
      options.signal = signal;
    });
  }
  return account;
}

export function createDropboxSignProvider(input: {
  apiKey: EsignSecret;
  clientId: string;
  expectedDomain?: string;
}): DropboxSignProvider {
  const api = authenticatedApiSet(input.apiKey);

  return {
    async validateCredentials() {
      try {
        const [accountResponse, appResponse] = await Promise.all([
          api.account.accountGet(),
          api.apiApp.apiAppGet(input.clientId),
        ]);
        const apiApp = appResponse.body.apiApp;
        if (apiApp.clientId !== input.clientId) {
          throw new ProviderError(
            "Dropbox Sign returned a different API app client ID.",
            "dropbox_sign",
            { providerCode: "client_id_mismatch" },
          );
        }
        const domains = apiApp.domains ?? [];
        const expectedHost = input.expectedDomain
          ? normalizedDomain(input.expectedDomain)
          : null;
        if (
          expectedHost &&
          !domains.some((domain) => normalizedDomain(domain) === expectedHost)
        ) {
          throw new ProviderError(
            "The Dropbox Sign API app does not allow Sandra's embedded domain.",
            "dropbox_sign",
            { providerCode: "embedded_domain_not_allowed" },
          );
        }
        return {
          accountId: accountResponse.body.account.accountId ?? null,
          clientId: apiApp.clientId,
          domains,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async createEmbeddedTemplateDraft(
      request: CreateEmbeddedTemplateDraftInput,
    ) {
      try {
        const response = await api.template.templateCreateEmbeddedDraft({
          clientId: input.clientId,
          files: [providerFile(request.file)],
          title: request.title,
          signerRoles: request.signerRoles.map((role) => ({ ...role })),
          forceSignerRoles: true,
          mergeFields: request.mergeFieldNames.map((name) => ({
            name,
            type: SubMergeField.TypeEnum.Text,
          })),
          metadata: { sandra_template_id: request.localTemplateId },
          testMode: true,
        });
        const template = response.body.template;
        if (!template.templateId || !template.editUrl) {
          throw new ProviderError(
            "Dropbox Sign did not return an embedded template draft session.",
            "dropbox_sign",
          );
        }
        return {
          providerTemplateId: template.templateId,
          editUrl: template.editUrl,
          expiresAt: template.expiresAt ?? null,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async getEmbeddedTemplateEditUrl(providerTemplateId: string) {
      try {
        const response = await api.embedded.embeddedEditUrl(providerTemplateId, {
          forceSignerRoles: true,
          testMode: true,
        });
        const embedded = response.body.embedded;
        if (!embedded.editUrl) {
          throw new ProviderError(
            "Dropbox Sign did not return an embedded template edit URL.",
            "dropbox_sign",
          );
        }
        return {
          providerTemplateId,
          editUrl: embedded.editUrl,
          expiresAt: embedded.expiresAt ?? null,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async getTemplate(providerTemplateId: string, signal?: AbortSignal): Promise<ProviderTemplateMetadata> {
      try {
        const response = await abortableTemplateApi(input.apiKey, signal).templateGet(providerTemplateId);
        const template = response.body.template;
        const metadata = providerTemplateMetadata(template as typeof template & { metadata?: Record<string, unknown> });
        return { ...metadata, providerTemplateId: metadata.providerTemplateId || providerTemplateId };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async getTemplateFiles(providerTemplateId: string) {
      try {
        return (await api.template.templateFiles(providerTemplateId, "pdf")).body;
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async duplicateTemplate(providerTemplateId: string, file: TemplatePdf) {
      try {
        const response = await api.template.templateUpdateFiles(providerTemplateId, {
          clientId: input.clientId,
          files: [providerFile(file)],
          testMode: true,
        });
        const duplicateId = response.body.template?.templateId;
        if (!duplicateId || duplicateId === providerTemplateId) {
          throw new ProviderError(
            "Dropbox Sign did not return a distinct copied template identifier.",
            "dropbox_sign",
            { providerCode: "template_copy_id_missing" },
          );
        }
        return { providerTemplateId: duplicateId, readiness: "pending" };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async updateTemplateFiles(providerTemplateId: string, file: TemplatePdf) {
      try {
        await api.template.templateUpdateFiles(providerTemplateId, {
          clientId: input.clientId,
          files: [providerFile(file)],
          testMode: true,
        });
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async deleteTemplate(providerTemplateId: string) {
      try {
        await api.template.templateDelete(providerTemplateId);
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async sendWithTemplate(
      request: SendWithTemplateInput,
    ): Promise<SendWithTemplateOutput> {
      const body: SignatureRequestSendWithTemplateRequest = {
        templateIds: [request.templateId],
        clientId: input.clientId,
        signers: request.signers,
        customFields: Object.entries(request.mergeValues).map(([name, value]) => ({
          name,
          value,
        })),
        metadata: { sandra_request_id: request.localRequestId },
        title: request.title,
        subject: request.subject,
        message: request.message,
        testMode: request.testMode,
      };
      try {
        const response =
          await abortableSignatureApi(input.apiKey, request.signal)
            .signatureRequestSendWithTemplate(body);
        const signatureRequest = response.body.signatureRequest;
        if (!signatureRequest.signatureRequestId) {
          throw new ProviderError(
            "Dropbox Sign did not return a signature request identifier.",
            "dropbox_sign",
          );
        }
        return {
          signatureRequestId: signatureRequest.signatureRequestId,
          signatures: (signatureRequest.signatures ?? []).flatMap(
            (signature, index) =>
              signature.signatureId &&
              signature.signerRole &&
              signature.signerName &&
              signature.signerEmailAddress
                ? [{
                    signatureId: signature.signatureId,
                    role: signature.signerRole,
                    name: signature.signerName,
                    emailAddress: signature.signerEmailAddress,
                    order: signature.order ?? index,
                  }]
                : [],
          ),
          detailsUrl: signatureRequest.detailsUrl ?? null,
          testMode: request.testMode,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async getRemainingSignatureRequests(signal?: AbortSignal) {
      try {
        const response = await abortableAccountApi(input.apiKey, signal).accountGet();
        const account = response.body.account as unknown as {
          quotas?: {
            api_signature_requests_left?: unknown;
            apiSignatureRequestsLeft?: unknown;
          };
        };
        const remaining =
          account.quotas?.api_signature_requests_left ??
          account.quotas?.apiSignatureRequestsLeft;
        return typeof remaining === "number" && Number.isFinite(remaining)
          ? remaining
          : null;
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async updateSignerEmail(request) {
      const body: SignatureRequestUpdateRequest = {
        signatureId: request.signatureId,
        emailAddress: request.emailAddress,
        name: request.name,
      };
      try {
        const response = await abortableSignatureApi(
          input.apiKey,
          request.signal,
        ).signatureRequestUpdate(request.signatureRequestId, body);
        const updated = (response.body.signatureRequest.signatures ?? []).find(
          (signature) =>
            signature.signerRole === request.role &&
            signature.signerName === request.name &&
            signature.signerEmailAddress === request.emailAddress &&
            (signature.order ?? request.order) === request.order,
        );
        if (
          !updated?.signatureId ||
          !updated.signerRole ||
          !updated.signerName ||
          !updated.signerEmailAddress
        ) {
          throw new ProviderError(
            "Dropbox Sign did not return the updated signer identity.",
            "dropbox_sign",
            { providerCode: "updated_signature_missing" },
          );
        }
        return {
          signatureId: updated.signatureId,
          role: updated.signerRole,
          name: updated.signerName,
          emailAddress: updated.signerEmailAddress,
          order: updated.order ?? request.order,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async findSignatureRequestIdsByLocalRequestId(localRequestId, testMode, signal) {
      try {
        const response = await abortableSignatureApi(
          input.apiKey,
          signal,
        ).signatureRequestList(
          undefined,
          1,
          100,
          `metadata:${localRequestId} AND test_mode:${testMode} AND client_id:${input.clientId}`,
        );
        const requests = response.body.signatureRequests ?? [];
        const providerRequestIds = requests.flatMap((request) =>
          request.metadata?.sandra_request_id === localRequestId &&
          request.signatureRequestId
            ? [request.signatureRequestId]
            : [],
        );
        const listInfo = response.body.listInfo;
        return {
          complete:
            (listInfo.numPages ?? 1) === 1 &&
            (listInfo.numResults ?? requests.length) === requests.length,
          providerRequestIds,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async getSignatureRequestMetadata(signatureRequestId, signal) {
      try {
        const response = await abortableSignatureApi(
          input.apiKey,
          signal,
        ).signatureRequestGet(signatureRequestId);
        const request = response.body.signatureRequest;
        return {
          signatureRequestId: request.signatureRequestId ?? "",
          localRequestId:
            typeof request.metadata?.sandra_request_id === "string"
              ? request.metadata.sandra_request_id
              : null,
        testMode: typeof request.testMode === "boolean" ? request.testMode : null,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async remind(
      signatureRequestId: string,
      signer: { emailAddress: string; name?: string },
      signal?: AbortSignal,
    ) {
      try {
        await abortableSignatureApi(input.apiKey, signal).signatureRequestRemind(signatureRequestId, {
          emailAddress: signer.emailAddress,
          name: signer.name,
        });
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async cancel(signatureRequestId: string, signal?: AbortSignal) {
      try {
        await abortableSignatureApi(input.apiKey, signal).signatureRequestCancel(signatureRequestId);
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async downloadSignedPdf(signatureRequestId: string) {
      try {
        const response = await api.signatureRequest.signatureRequestFiles(
          signatureRequestId,
          "pdf",
        );
        return response.body;
      } catch (error) {
        throw normalizeDropboxSignError(error, { retryableStatuses: [409] });
      }
    },
  };
}

function providerTemplateMetadata(template: {
  templateId?: string;
  title?: string;
  isEmbedded?: boolean | null;
  isCreator?: boolean;
  canEdit?: boolean;
  isLocked?: boolean;
  accounts?: Array<{ accountId?: string; isLocked?: boolean }>;
  metadata?: Record<string, unknown>;
  signerRoles?: Array<{ name?: string; order?: number }>;
  namedFormFields?: Array<{ name?: string }> | null;
}): ProviderTemplateMetadata {
  return {
    providerTemplateId: template.templateId ?? "",
    localTemplateId: typeof template.metadata?.sandra_template_id === "string"
      ? template.metadata.sandra_template_id
      : null,
    title: template.title ?? null,
    isEmbedded: typeof template.isEmbedded === "boolean" ? template.isEmbedded : null,
    canEdit: typeof template.canEdit === "boolean" ? template.canEdit : null,
    isCreator: typeof template.isCreator === "boolean" ? template.isCreator : null,
    isLocked: typeof template.isLocked === "boolean" ? template.isLocked : null,
    accounts: (template.accounts ?? []).map((account) => ({
      accountId: account.accountId ?? null,
      isLocked: typeof account.isLocked === "boolean" ? account.isLocked : null,
    })),
    signerRoles: (template.signerRoles ?? [])
      .map((role, index) => ({ name: role.name ?? "", order: role.order ?? index }))
      .sort((a, b) => a.order - b.order),
    mergeFieldNames: (template.namedFormFields ?? [])
      .map((field) => field.name)
      .filter((name): name is string => Boolean(name)),
  };
}

function providerFile(file: TemplatePdf) {
  return {
    value: file.bytes,
    options: {
      filename: file.filename,
      contentType: "application/pdf",
      knownLength: file.bytes.byteLength,
    },
  };
}

function normalizedDomain(value: string): string {
  try {
    return new URL(
      value.includes("://") ? value : `https://${value}`,
    ).hostname.toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  }
}

export function normalizeDropboxSignError(
  error: unknown,
  options: { retryableStatuses?: number[] } = {},
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof HttpError) {
    const retryAfter = error.response?.headers?.["retry-after"];
    return new ProviderError(
      error.body?.error?.errorMsg || "Dropbox Sign rejected the request.",
      "dropbox_sign",
      {
        providerCode: error.body?.error?.errorName,
        statusCode: error.statusCode,
        retryAfterSeconds:
          typeof retryAfter === "string" ? Number(retryAfter) : undefined,
        retryable:
          error.statusCode === 429 ||
          (error.statusCode ?? 0) >= 500 ||
          options.retryableStatuses?.includes(error.statusCode ?? 0) === true,
      },
    );
  }
  return new ProviderError(
    error instanceof Error
      ? error.message
      : "Dropbox Sign request failed unexpectedly.",
    "dropbox_sign",
  );
}
