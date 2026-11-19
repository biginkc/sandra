/**
 * Shared rules for the "Voicemail drop" drip step (plan v3, build step 5).
 * The database (sequence_replace_steps + sequence_steps_voicemail_drop_body_xor)
 * is the source of truth; these mirror it so the editor and server action
 * reject bad steps before the RPC does.
 */

import { hasDropCowboyRandomVariant } from "@/lib/voicemail-drop/eligibility";

export { hasDropCowboyRandomVariant };

/** Drop Cowboy rejects longer TTS scripts (reason code 3021). */
export const VOICEMAIL_SCRIPT_MAX_CHARS = 1200;

export type VoicemailDropStepFields = {
  action_type: string;
  template_body?: string | null;
  template_id?: string | null;
  template_category?: string | null;
  target_status?: string | null;
  vm_media_id?: string | null;
  vm_tts_body?: string | null;
  vm_voice_id?: string | null;
  vm_phone_line_id?: string | null;
  /** Rotate among saved voicemail scripts (voicemail_templates.category). */
  vm_template_category?: string | null;
};

/** Single-brace tokens like {first_name} are never filled in; the engine uses {{first_name}}. */
export function hasSingleBraceMergeField(text: string | null | undefined): boolean {
  return /(^|[^{])\{\s*[a-z_]+\s*\}(?!\})/i.test(text ?? "");
}

const filled = (value: string | null | undefined) => Boolean(value?.trim());

/**
 * Problem with one voicemail script (a step script or a saved voicemail
 * template), or null when it is fine to read aloud.
 */
export function voicemailScriptProblem(text: string | null | undefined): string | null {
  const script = (text ?? "").trim();
  if (!script) return "Write the script.";
  if (script.length > VOICEMAIL_SCRIPT_MAX_CHARS) {
    return `Scripts can be at most ${VOICEMAIL_SCRIPT_MAX_CHARS.toLocaleString("en-US")} characters.`;
  }
  if (hasSingleBraceMergeField(script)) return "Use double braces, like {{first_name}}, so Sandra fills them in.";
  if (hasDropCowboyRandomVariant(script)) {
    return "Remove [this/that] choices. Sandra picks the script, so the voicemail provider must not pick words at random.";
  }
  return null;
}

/** The step reads text aloud (one script, or a rotation of saved scripts). */
export function voicemailStepIsSpoken(step: VoicemailDropStepFields): boolean {
  return step.action_type === "send_voicemail_drop" && !filled(step.vm_media_id) &&
    (filled(step.vm_tts_body) || filled(step.vm_template_category));
}

/**
 * A script is read aloud by a provider voice: the step's vm_voice_id, or the
 * server default (DROPCOWBOY_VOICE_ID). Recordings need no voice.
 */
export function voicemailScriptNeedsVoice(step: VoicemailDropStepFields, defaultVoiceId?: string | null): boolean {
  return step.action_type === "send_voicemail_drop" && !filled(step.vm_media_id) &&
    !filled(step.vm_voice_id) && !filled(defaultVoiceId);
}

export const VOICEMAIL_VOICE_REQUIRED_MESSAGE =
  "A voicemail script needs a voice. Enter a voice ID, or set a default voice for voicemail drops.";

/**
 * Exactly one of recording / script / saved-script rotation, script within
 * the limit and with a voice (own or default), no SMS or status fields. Each
 * rotated template is checked where it is saved and again by the worker.
 */
export function isValidVoicemailDropStep(step: VoicemailDropStepFields, defaultVoiceId?: string | null): boolean {
  if (step.action_type !== "send_voicemail_drop") return false;
  const media = filled(step.vm_media_id);
  const tts = filled(step.vm_tts_body);
  const rotation = filled(step.vm_template_category);
  if (Number(media) + Number(tts) + Number(rotation) !== 1) return false;
  if (tts && voicemailScriptProblem(step.vm_tts_body)) return false;
  if (voicemailScriptNeedsVoice(step, defaultVoiceId)) return false;
  return !filled(step.template_body) && !step.template_id && !filled(step.template_category) &&
    !filled(step.target_status);
}

/** Non-drop steps must carry no voicemail fields (database check). */
export function hasVoicemailFields(step: VoicemailDropStepFields): boolean {
  return filled(step.vm_media_id) || filled(step.vm_tts_body) || filled(step.vm_voice_id) ||
    filled(step.vm_phone_line_id) || filled(step.vm_template_category);
}

export type VoicemailDropTimelineRow = {
  id: string;
  status: string;
  attempt_outcome: string;
  reason: string | null;
  reason_code: string | null;
  proof_url: string | null;
  /** When the receipt saved proof_url (its 7 days start here). */
  proof_url_at?: string | null;
  /** Sandra's own stored copy (private bucket), when it has one. */
  proof_storage_path?: string | null;
  audio_kind: string;
  queued_at: string | null;
  completed_at: string | null;
  created_at: string;
};

export const VOICEMAIL_DROP_TIMELINE_COLUMNS =
  "id, status, attempt_outcome, reason, reason_code, proof_url, proof_url_at, proof_storage_path, audio_kind, queued_at, completed_at, created_at";

/**
 * Drops Drop Cowboy proved it never queued (429/500/400/401, or an
 * authorization that refused the send) are bookkeeping for a retry, not
 * something that happened to the lead: keep them off the timeline.
 */
export function visibleVoicemailDrops<T extends { attempt_outcome: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.attempt_outcome !== "not_queued");
}

/** Plain-English failure reasons for the delivery codes the plan names. */
const REASON_TEXT: Record<string, string> = {
  "4001": "no voicemail box",
  "4002": "voicemail box full",
  "4007": "not a mobile number",
  "4016": "number is on the do-not-call list",
  "3021": "script too long",
  "4010": "no caller line set up",
};

export function voicemailDropTimelineText(row: VoicemailDropTimelineRow): { title: string; detail: string | null } {
  const kind = row.audio_kind === "media" ? "recorded message" : "script";
  if (row.status === "delivered") return { title: "Voicemail delivered", detail: `Left a ${kind}.` };
  if (row.status === "failed") {
    const reason = (row.reason_code && REASON_TEXT[row.reason_code]) || row.reason?.trim() || "provider did not say why";
    return { title: "Voicemail not delivered", detail: reason.charAt(0).toUpperCase() + reason.slice(1) + "." };
  }
  if (row.status === "skipped") return { title: "Voicemail skipped", detail: row.reason?.trim() || null };
  return { title: "Voicemail queued", detail: `Sending a ${kind}.` };
}
