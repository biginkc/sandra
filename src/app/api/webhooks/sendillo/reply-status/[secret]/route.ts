import { POST as handlePost } from "../route";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ secret: string }> },
) {
  const { secret } = await params;
  const url = new URL(request.url);
  if (secret) {
    url.searchParams.set("secret", secret);
  }
  return handlePost(new Request(url.toString(), request));
}
