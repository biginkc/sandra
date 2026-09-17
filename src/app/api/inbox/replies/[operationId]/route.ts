import { inboxReplyRoute } from "@/lib/inbox/reply-route";
export async function GET(request: Request, { params }: { params: Promise<{ operationId: string }> }) { return inboxReplyRoute(request, "status", (await params).operationId); }
