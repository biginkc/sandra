import { CLOSR_SCRIPT } from "./script-block";

/** Metadata only: the coach continues to load its existing single script. */
export const COACH_SCRIPTS: readonly { id: string; title: string; version: string }[] = [
  {
    id: "closr-outbound",
    title: CLOSR_SCRIPT.title ?? "CLOSR Outbound Sales Script",
    version: CLOSR_SCRIPT.version,
  },
];
