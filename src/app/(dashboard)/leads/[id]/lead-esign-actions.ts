"use server";

import { revalidatePath } from "next/cache";

import type { Result } from "@/lib/errors/result";

import type {
  AuthorizedDownload,
  ConfirmContractNotSentInput,
  DownloadLeadFileInput,
  FixSignerEmailAndResendContractInput,
  LeadEsignPreflight,
  RemindContractInput,
  RetryContractInput,
  SendContractInput,
  SendContractOutput,
  VoidContractInput,
} from "./esign-types";
import { createBoundLeadEsignCore } from "./lead-esign-bindings";
import type { ViewContractInput, ViewContractOutput } from "./lead-esign-action-core";

export async function loadLeadEsignPreflightAction(propertyId: string): Promise<Result<LeadEsignPreflight>> {
  return createBoundLeadEsignCore().preflight(propertyId);
}

export async function sendContractAction(input: SendContractInput): Promise<Result<SendContractOutput>> {
  const result = await createBoundLeadEsignCore().send(input);
  if (result.ok) revalidatePath(`/leads/${input.propertyId}`);
  return result;
}

export async function remindContractAction(input: RemindContractInput): Promise<Result<null>> {
  const result = await createBoundLeadEsignCore().remind(input);
  if (result.ok) revalidatePath("/leads", "layout");
  return result;
}

export async function voidContractAction(input: VoidContractInput): Promise<Result<null>> {
  const result = await createBoundLeadEsignCore().void(input);
  if (result.ok) revalidatePath("/leads", "layout");
  return result;
}

export async function retryContractAction(input: RetryContractInput): Promise<Result<SendContractOutput>> {
  const result = await createBoundLeadEsignCore().retry(input);
  if (result.ok) revalidatePath("/leads", "layout");
  return result;
}

export async function fixSignerEmailAndResendContractAction(
  input: FixSignerEmailAndResendContractInput,
): Promise<Result<null>> {
  const result = await createBoundLeadEsignCore().fixSignerEmailAndResend(input);
  if (result.ok) revalidatePath("/leads", "layout");
  return result;
}

export async function confirmContractNotSentAction(input: ConfirmContractNotSentInput): Promise<Result<null>> {
  const result = await createBoundLeadEsignCore().confirmNotSent(input);
  if (result.ok) revalidatePath("/leads", "layout");
  return result;
}

export async function viewContractAction(input: ViewContractInput): Promise<Result<ViewContractOutput>> {
  return createBoundLeadEsignCore().view(input);
}

export async function downloadLeadFileAction(input: DownloadLeadFileInput): Promise<Result<AuthorizedDownload>> {
  return createBoundLeadEsignCore().download(input);
}
