import { NextResponse } from "next/server";

import { resumeByProperty } from "@/lib/sequences/enrollment";
import { createClient } from "@/lib/supabase/server";

/** Crash/tab-close cleanup for the softphone-owned sequence pause. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { propertyId?: unknown };
  try {
    body = (await request.json()) as { propertyId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (typeof body.propertyId !== "string" || !body.propertyId.trim()) {
    return NextResponse.json({ error: "Property is required" }, { status: 400 });
  }

  try {
    const resumed = await resumeByProperty(supabase, {
      propertyId: body.propertyId,
      actor: { actorType: "user", actorId: user.id },
    });
    return NextResponse.json({ ok: true, ...resumed });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not resume the call" },
      { status: 500 },
    );
  }
}
