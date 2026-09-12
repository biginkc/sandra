import { expect, type Page, type Request } from "@playwright/test";

/** Await the response body, not just HTTP headers or an early URL commit.
 * Call only for an uncached server navigation; UI assertions still follow.
 * The enclosing test's existing deadline bounds an unfinished stream.
 */
export async function completeServerNavigation(
  page: Page,
  destination: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const target = new URL(destination, page.url());
  const matches = (request: Request) => {
    const url = new URL(request.url());
    url.searchParams.delete("_rsc");
    return request.method() === "GET" &&
      (request.isNavigationRequest() || request.headers().rsc === "1") &&
      url.href === target.href;
  };
  let failed!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => { failed = resolve; });
  const onFailed = (request: Request) => {
    if (matches(request)) failed(new Error(request.failure()?.errorText ?? "Navigation failed"));
  };
  page.on("requestfailed", onFailed);
  try {
    const [response] = await Promise.all([
      page.waitForResponse((response) => matches(response.request())),
      action(),
    ]);
    expect(response.ok(), `Navigation response for ${target.pathname}`).toBe(true);
    const outcome = await Promise.race([response.finished(), failure]);
    expect(outcome, `Navigation body for ${target.pathname}`).toBeNull();
  } finally {
    page.off("requestfailed", onFailed);
  }
}
