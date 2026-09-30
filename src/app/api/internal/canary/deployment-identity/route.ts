import { deploymentIdentity } from "@/lib/sequences/canary-runtime-proof";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(deploymentIdentity(), {
    headers: { "Cache-Control": "no-store" },
  });
}
