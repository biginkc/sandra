import { inboxActionRoute } from "@/lib/inbox/action-route";
export async function POST(request:Request){return inboxActionRoute(request,"accept");}
