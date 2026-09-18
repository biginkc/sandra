import { inboxSavedActionRoute } from "@/lib/inbox/saved-action-route";

export async function GET(request: Request) { return inboxSavedActionRoute(request, "list"); }
export async function POST(request: Request) { return inboxSavedActionRoute(request, "create"); }
export async function PATCH(request: Request) { return inboxSavedActionRoute(request, "update"); }
export async function DELETE(request: Request) { return inboxSavedActionRoute(request, "deactivate"); }
