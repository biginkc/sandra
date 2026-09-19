import http from "node:http";
import { acceptOperation, getOperation } from "./domain.js";
import { assertFixtureDatabase } from "../shared/database.js";
import { relayOnce } from "./relay.js";
await assertFixtureDatabase();
let busy = false;
if (process.env.BULK_RELAY_DISABLED !== "1")
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await relayOnce();
    } catch (e) {
      console.error(String(e));
    } finally {
      busy = false;
    }
  }, 200).unref();
http
  .createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      const user = req.headers["x-fixture-user"];
      if (typeof user !== "string")
        throw Error("401 explicit fixture user required");
      const url = new URL(req.url!, "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/operations") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 20000) throw Error("413 body");
        }
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          throw Error("400 malformed JSON");
        }
        const result = await acceptOperation(user, body);
        res.writeHead(202);
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/operations/")) {
        res.end(
          JSON.stringify(await getOperation(user, url.pathname.split("/")[2])),
        );
        return;
      }
      throw Error("404 route");
    } catch (e) {
      const msg = String(e);
      res.writeHead(Number(msg.match(/\b(4\d\d)\b/)?.[1] ?? 500));
      res.end(JSON.stringify({ error: msg }));
    }
  })
  .listen(58789, "127.0.0.1", () =>
    console.log("Fixture acceptance API 58789"),
  );
