import { getPath } from "hono/utils/url";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { withIdentity, type Identity } from "../runtime/app/identity.ts";

export interface SignInConfiguration {
  teamDomain?: string;
  audience?: string;
  agentClientId?: string;
}

export function isConfigured(config: SignInConfiguration): boolean {
  return typeof config.teamDomain === "string"
    && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(config.teamDomain)
    && typeof config.audience === "string"
    && /^[A-Za-z0-9_-]+$/.test(config.audience);
}

interface AssetEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export interface SignInDependencies<E, C> {
  appFetch(request: Request, env: E, context: C): Response | Promise<Response>;
  keySet: JWTVerifyGetKey | null;
  configuration: SignInConfiguration;
  /** The path the app routes on. Hono decodes percent-escapes before routing,
   *  so the refusals below must match the decoded path, not `URL.pathname`. */
  routePath?: (request: Request) => string;
}

const publicRuns = new Set([
  "/api/email-sync/run",
  "/api/ai-columns/run",
  "/api/meetings/run",
]);

function unavailableFeature(method: string, path: string): boolean {
  if (method === "POST") {
    return new Set([
      "/api/integrations/email",
      "/api/integrations/meeting",
      "/api/email-sync/sync-now",
      "/api/meetings/sync-now",
    ]).has(path)
      || /^\/api\/ai-columns\/[^/]+\/[^/]+\/(?:fill|cells\/[^/]+)$/.test(path)
      || /^\/api\/meetings\/[^/]+\/digest$/.test(path);
  }
  if (method === "PUT") {
    return path === "/api/email-sync"
      || path === "/api/meetings/sync"
      || /^\/api\/ai-columns\/[^/]+\/[^/]+$/.test(path);
  }
  // Hono also serves GET handlers for HEAD.
  return (method === "GET" || method === "HEAD") && path === "/api/email-sync/labels";
}

function refusal(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** All request policy lives here; keys and both downstream fetches are injected. */
export async function signIn<E extends AssetEnvironment, C>(
  request: Request,
  env: E,
  context: C,
  dependencies: SignInDependencies<E, C>,
): Promise<Response> {
  for (const name of request.headers.keys()) {
    if (name.toLowerCase().startsWith("x-clawnify-")) {
      return refusal(403, "Caller-supplied identity headers are not allowed.");
    }
  }

  const config = dependencies.configuration;
  if (!isConfigured(config) || !dependencies.keySet) {
    return refusal(503, "Sign-in is not configured.");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return refusal(401, "Sign in to use Wiser CRM.");

  let identity: Identity;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, dependencies.keySet, {
      algorithms: ["RS256"],
      issuer: config.teamDomain,
      audience: config.audience,
      requiredClaims: ["exp"],
    });
    if (!protectedHeader.kid || payload.type !== "app") throw new Error("Invalid token");
    if (typeof payload.sub === "string" && payload.sub.trim()
      && typeof payload.email === "string" && payload.email.trim()) {
      identity = { caller: "user", user: { id: payload.sub, email: payload.email } };
    } else if (payload.sub === "" && config.agentClientId
      && payload.common_name === config.agentClientId) {
      identity = { caller: "agent", user: null };
    } else {
      throw new Error("Invalid identity");
    }
  } catch {
    return refusal(401, "Sign in to use Wiser CRM.");
  }

  if (identity.caller === "agent" && request.headers.has("Cf-Access-Authenticated-User-Email")) {
    return refusal(403, "An agent cannot supply a person identity.");
  }

  const path = (dependencies.routePath ?? getPath)(request);
  if (request.method === "POST" && publicRuns.has(path)) {
    return refusal(403, "Public job runs are not available in Wiser CRM.");
  }
  if (unavailableFeature(request.method, path)) {
    return refusal(409, "This feature is not available in Wiser CRM.");
  }

  if (path.startsWith("/api/") || path === "/llms.txt") {
    return dependencies.appFetch(request, withIdentity(env, identity), context);
  }
  return env.ASSETS.fetch(request);
}
