import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createFixture } from "../test/fixtures/web-game.js";
import { createWebApi } from "../src/web.js";
import { webConfig, clerkOwnerVerifier } from "../src/web-auth.js";
import { loadEnvFile } from "node:process";

export async function startPreview(port = 4317, clerk = false) {
  if (process.env.VERCEL || process.env.NODE_ENV === "production")
    throw new Error("Synthetic preview is local-only");
  const fixture = await createFixture();
  const config = clerk
    ? webConfig()
    : {
        origin: `http://127.0.0.1:${port}`,
        publishableKey: "",
        secretKey: "",
        ownerId: "preview",
      };
  const authenticate = clerk
    ? clerkOwnerVerifier(config)
    : async () => ({ status: 200, owner: "experiment-owner" });
  const api = createWebApi(
    () => fixture.db,
    config,
    async (request) => {
      const identity = await authenticate(request);
      return identity.status === 200 &&
        request.headers.get("x-preview-state") === "empty"
        ? { ...identity, owner: "empty-preview-owner" }
        : identity;
    },
  );
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      // Bind to loopback and reject foreign Host/Origin headers (including DNS rebinding).
      if (
        !/^127\.0\.0\.1:\d+$/.test(req.headers.host || "") ||
        (req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}`)
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (url.pathname === "/api/web-config") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            preview: !clerk,
            synthetic: true,
            publishableKey: config.publishableKey,
          }),
        );
        return;
      }
      if (url.pathname === "/api/player") {
        const response = await api(
          new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method,
            headers: req.headers,
          }),
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
      res.writeHead(500);
      res.end("Preview unavailable");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  console.info(`Synthetic memory-only Life RPG preview: ${url}`);
  return {
    url,
    fixture,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await fixture.close();
    },
  };
}
if (process.argv[1]?.endsWith("preview-web.js")) {
  const clerk = process.argv.includes("--clerk");
  if (clerk) loadEnvFile(".env.clerk.local");
  const preview = await startPreview(
    Number(process.env.PORT || (clerk ? 4318 : 4317)),
    clerk,
  );
  process.on("SIGINT", async () => {
    await preview.close();
    process.exit(0);
  });
}
