import "server-only";

import { getMyLeadsFlag } from "./flags";
import { schemaReady } from "./schema-ready";

/** Server-side truth for the Phase 2 UI surfaces: each is on only when its flag is on AND its schema has landed. */
export type MyLeadsCallFeatures = {
  /** 2.7: Call goes through the Dialpad API instead of the Sandra softphone. */
  clickToDial: boolean;
  /** 2.6: the post-call prompt opens on its own for the oldest unacknowledged call. */
  autoPrompt: boolean;
  /** 2.8: the callback-due banner and strip pin. */
  callbackAlert: boolean;
  /** The call screen route is on (`call_screen` flag): Call lands on it and rows offer "Open call screen". */
  callScreen: boolean;
};

export const CALL_FEATURES_OFF: MyLeadsCallFeatures = { clickToDial: false, autoPrompt: false, callbackAlert: false, callScreen: false };

export async function getMyLeadsCallFeatures(orgId: string): Promise<MyLeadsCallFeatures> {
  const gate = async (flag: "click_to_dial" | "auto_prompt" | "callback_alert", feature: "api_dial" | "ack_prompts" | "callbacks_due") =>
    (await getMyLeadsFlag(orgId, flag)) ? schemaReady(feature) : false;
  const [clickToDial, autoPrompt, callbackAlert, callScreen] = await Promise.all([
    gate("click_to_dial", "api_dial"),
    gate("auto_prompt", "ack_prompts"),
    gate("callback_alert", "callbacks_due"),
    // The route itself only checks the flag (page.tsx), so the entry points do too.
    getMyLeadsFlag(orgId, "call_screen"),
  ]);
  return { clickToDial, autoPrompt, callbackAlert, callScreen };
}
