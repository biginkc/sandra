import { inboxActionRoute } from "@/lib/inbox/action-route";
export async function GET(request:Request,{params}:{params:Promise<{operationId:string}>}){return inboxActionRoute(request,"status",(await params).operationId);}
