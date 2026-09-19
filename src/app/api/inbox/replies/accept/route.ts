import { inboxReplyRoute } from "@/lib/inbox/reply-route";
export async function POST(request: Request) { return inboxReplyRoute(request, "accept"); }
