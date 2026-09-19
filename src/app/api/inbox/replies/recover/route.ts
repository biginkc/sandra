import { inboxReplyRoute } from "@/lib/inbox/reply-route";
export async function GET(request: Request) { return inboxReplyRoute(request, "recover"); }
