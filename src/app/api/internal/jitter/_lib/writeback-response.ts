import { NextResponse } from "next/server";

type WritebackOutcome = { outcome?: string } | null;

export function responseForWritebackPayload(payload: unknown): NextResponse {
  const outcome = (payload as WritebackOutcome)?.outcome;
  if (outcome === "identity_conflict") {
    return NextResponse.json(
      { error: "conflict", error_code: "call_activity_identity_conflict" },
      { status: 409 },
    );
  }
  if (outcome === "artifact_conflict") {
    return NextResponse.json(
      { error: "conflict", error_code: "call_artifact_conflict" },
      { status: 409 },
    );
  }
  return NextResponse.json(payload);
}
