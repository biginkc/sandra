import { LeadMediaImage } from "./lead-media-image";
import {
  resolveLeadMediaPresentation,
  type LeadMediaPresentation,
  type LeadMediaLocation,
} from "./lead-media";

/**
 * Resolve third-party imagery below the hero's Suspense boundary. The parent
 * supplies the already-authorized lead location; this component performs no
 * record lookup and receives no lead identifier.
 */
export async function LeadMediaImageSlot({
  location,
  address,
}: {
  location: LeadMediaLocation;
  address: string;
}) {
  let media: LeadMediaPresentation;
  try {
    media = await resolveLeadMediaPresentation(location);
  } catch (error) {
    console.error("[lead-media] presentation resolver failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    media = { kind: "flat", reason: "resolver-error" };
  }

  return (
    <LeadMediaImage
      media={media}
      address={address}
      showPreviewMisconfiguration={process.env.VERCEL_ENV === "preview"}
    />
  );
}
