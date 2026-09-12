import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/denied") {
      response.writeHead(302, { location: "/login" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/dashboard") {
      // Deliberately leave the document stream open after its shell renders.
      response.write('<!doctype html><html><body><button>Sign out</button><main aria-label="Loading Overview"></main>');
      return;
    }
    response.end('<!doctype html><html><body><button>Sign in with Hugo</button></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("authenticated shell is observable before the document finishes loading", async ({ page }) => {
  let loaded = false;
  page.on("load", () => { loaded = true; });
  await page.goto(`${origin}/dashboard`, { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  expect(loaded).toBe(false);
});

test("committing navigation does not treat a login redirect as authenticated", async ({ page }) => {
  await page.goto(`${origin}/denied`, { waitUntil: "commit" });
  await expect(page).toHaveURL(`${origin}/login`);
  await expect(page.getByRole("button", { name: "Sign in with Hugo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
});
