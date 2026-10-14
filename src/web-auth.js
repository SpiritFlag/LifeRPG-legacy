import { createClerkClient } from "@clerk/backend";

/** @param {NodeJS.ProcessEnv} env */
export function webConfig(env = process.env) {
  // The private website may use the custom domain while MCP keeps its issuer
  // and resource on the existing connector origin.
  const origin = new URL(env.WEB_PUBLIC_BASE_URL || env.PUBLIC_BASE_URL || "http://localhost:3000").origin;
  return {
    origin,
    publishableKey: env.CLERK_PUBLISHABLE_KEY || "",
    secretKey: env.CLERK_SECRET_KEY || "",
    jwtKey: env.CLERK_JWT_KEY?.replace(/\\n/g, "\n"),
    ownerId: env.CLERK_OWNER_USER_ID || "",
  };
}

/** Only a verified Clerk session for the configured owner maps to the existing MCP owner.
 * @param {ReturnType<typeof webConfig>} config */
export function clerkOwnerVerifier(config) {
  const clerk =
    config.publishableKey && config.secretKey
      ? createClerkClient({
          publishableKey: config.publishableKey,
          secretKey: config.secretKey,
        })
      : null;
  /** @param {Request} request */
  return async (request) => {
    if (!clerk || !config.ownerId)
      return { status: 503, error: "auth_not_configured" };
    const origin = request.headers.get("origin");
    if (origin && origin !== config.origin)
      return { status: 403, error: "invalid_origin" };
    try {
      const session = await clerk.authenticateRequest(request, {
        authorizedParties: [config.origin],
        acceptsToken: "session_token",
        jwtKey: config.jwtKey,
      });
      if (!session.isAuthenticated)
        return { status: 401, error: "sign_in_required" };
      const identity = session.toAuth();
      if (identity.userId !== config.ownerId)
        return { status: 403, error: "owner_only" };
      return { status: 200, owner: "experiment-owner" };
    } catch {
      return { status: 401, error: "invalid_session" };
    }
  };
}
