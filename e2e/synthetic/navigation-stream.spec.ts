import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { completeServerNavigation } from "../support/navigation";

test("HTTP 200 and URL commit do not prove that a streamed navigation finished", async ({ page }) => {
  let releaseBody!: () => void;
  const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/detail")) {
      response.writeHead(200, { "content-type": "text/x-component" });
      response.write("pending\n");
      await bodyGate;
      response.end("ready");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<button id="open">Open lead</button><script>
      document.querySelector('#open').onclick = async () => {
        const response = await fetch('/detail?_rsc=proof', {headers: {rsc: '1'}});
        history.pushState({}, '', '/detail');
        await response.text();
        document.body.innerHTML = '<h1>Lead detail</h1>';
      };
    </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local address");
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    let finished = false;
    const navigation = completeServerNavigation(page, "/detail", () =>
      page.getByRole("button", { name: "Open lead" }).click(),
    ).then(() => { finished = true; });
    await expect(page).toHaveURL(/\/detail$/);
    // Reproduce the original five-second assertion failure with a successful
    // HTTP response whose body is deliberately held open. No database involved.
    await expect(expect(page.getByRole("heading", { name: "Lead detail" }))
      .toBeVisible()).rejects.toThrow();
    expect(finished).toBe(false);
    releaseBody();
    await navigation;
    await expect(page.getByRole("heading", { name: "Lead detail" })).toBeVisible();
  } finally {
    releaseBody();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const mode of ["http-error", "aborted-body"] as const) {
  test(`navigation rejects ${mode} instead of accepting HTTP headers`, async ({ page }) => {
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/detail")) {
        if (mode === "http-error") {
          response.writeHead(503);
          response.end("unavailable");
        } else {
          response.writeHead(200, { "content-type": "text/x-component" });
          response.write("partial");
          setTimeout(() => response.destroy(), 100);
        }
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<button onclick="fetch('/detail?_rsc=proof', {headers:{rsc:'1'}}).then(r=>r.text()).catch(()=>{})">Open</button>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local address");
    try {
      await page.goto(`http://127.0.0.1:${address.port}`);
      await expect(completeServerNavigation(page, "/detail", () =>
        page.getByRole("button", { name: "Open", exact: true }).click(),
      )).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
