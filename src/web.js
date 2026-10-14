import { clerkOwnerVerifier, webConfig } from "./web-auth.js";
import { playerQuerySchema, readPlayer } from "./web-data.js";
import { EventConflict } from "./storage.js";

/** @param {any} body @param {number} status */
const response = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      Vary: "Cookie, Authorization",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });

/** @param {() => import('./database.js').Database} database
 * @param {ReturnType<typeof webConfig>} config
 * @param {ReturnType<typeof clerkOwnerVerifier>} verify */
export function createWebApi(
  database,
  config = webConfig(),
  verify = clerkOwnerVerifier(config),
) {
  /** @param {Request} request */
  return async (request) => {
    const url = new URL(request.url);
    if (!["/api/player", "/api/web-config"].includes(url.pathname))
      return response({ error: "not_found" }, 404);
    if (request.method !== "GET")
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET", "Cache-Control": "no-store" },
      });
    if (url.pathname === "/api/web-config")
      return response({ publishableKey: config.publishableKey }, 200);
    const auth = await verify(request);
    if (auth.status !== 200 || !auth.owner)
      return response({ error: auth.error }, auth.status);
    try {
      if (url.search.length > 4000)
        return response({ error: "invalid_query" }, 400);
      const query = JSON.parse(url.searchParams.get("q") || "{}");
      if (
        [...url.searchParams.keys()].some((k) => k !== "q") ||
        url.searchParams.getAll("q").length > 1
      )
        return response({ error: "invalid_query" }, 400);
      const parsed = playerQuerySchema.safeParse(query);
      if (!parsed.success) return response({ error: "invalid_query" }, 400);
      const data = await readPlayer(database(), auth.owner, parsed.data);
      return response(data, 200);
    } catch (error) {
      if (error instanceof SyntaxError)
        return response({ error: "invalid_query" }, 400);
      if (error instanceof EventConflict)
        return response({ error: "record_unavailable" }, 404);
      return response({ error: "game_unavailable" }, 503);
    }
  };
}
