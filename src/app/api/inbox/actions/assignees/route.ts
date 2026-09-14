import { inboxActionRoute } from "@/lib/inbox/action-route";
export async function GET(request:Request){return inboxActionRoute(request,"assignees");}
