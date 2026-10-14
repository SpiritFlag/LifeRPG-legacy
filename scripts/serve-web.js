import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { loadEnvFile } from "node:process";
import { createWebApi } from "../src/web.js";
import { webConfig } from "../src/web-auth.js";
import { connectDatabase } from "../src/database.js";

// No automatic migrations or game initialization. An explicit env file is required.
loadEnvFile(process.env.WEB_ENV_FILE || ".env.local");
const config = webConfig();
let db;
const api = createWebApi(
  () => (db ||= connectDatabase(process.env.DATABASE_URL || "")),
  config,
);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, config.origin);
    if (url.pathname.startsWith("/api/")) {
      const response = await api(
        new Request(url, { method: req.method, headers: req.headers }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^(index\.html|assets\/[\w.-]+\.(js|css))$/.test(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      extname(file) === ".css"
        ? "text/css"
        : extname(file) === ".js"
          ? "text/javascript"
          : "text/html; charset=utf-8",
    );
    res.setHeader("Cache-Control", "no-store");
    res.end(await readFile(resolve("public", file)));
  } catch {
    res.writeHead(503);
    res.end("Website unavailable");
  }
});
server.listen(Number(new URL(config.origin).port || 3000), "127.0.0.1", () =>
  console.info(`Clerk-protected Life RPG: ${config.origin}`),
);
process.on("SIGINT", () =>
  server.close(async () => {
    await db?.close();
    process.exit(0);
  }),
);
