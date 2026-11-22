import { getPath } from "hono/utils/url";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { withIdentity, type Identity } from "../runtime/app/identity.ts";
import { findPerson, isReadMethod, mayWriteApp, plainEmail, type PeopleDatabase } from "../runtime/people/index.ts";
import { installBrand, type BrandSettings } from "./brand.ts";
import { isViewerSyncRead, isWritingGet } from "./get-routes.ts";
import { peoplePath, peopleResponse, refusal, waitForRole, type PeopleCaller } from "./people.ts";
import type { TakeInCounts } from "./take-in.ts";
import { releaseVersion } from "./version.ts";

export interface SignInConfiguration {
  teamDomain?: string;
  audience?: string;
  agentClientId?: string;
  ownerEmail?: string;
}

export function isConfigured(config: SignInConfiguration): boolean {
  return typeof config.teamDomain === "string"
    && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(config.teamDomain)
    && typeof config.audience === "string"
    && /^[A-Za-z0-9_-]+$/.test(config.audience);
}

interface AssetEnvironment extends BrandSettings {
  DB: PeopleDatabase;
  ASSETS: { fetch(request: Request): Promise<Response> };
  WISER_INSTANCE?: string;
  WISER_READ_ONLY?: string;
}

export interface SignInDependencies<E, C> {
  appFetch(request: Request, env: E, context: C): Response | Promise<Response>;
  takeIn?: () => Promise<TakeInCounts>;
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

  let identity: { caller: "user"; user: NonNullable<Identity["user"]> }
    | { caller: "agent"; user: null };
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

  const firstOwner = plainEmail(config.ownerEmail);
  if (!firstOwner) return refusal(503, "This install has no owner configured.");

  const path = (dependencies.routePath ?? getPath)(request);
  // Missing and empty are writable; every other spelling except exact false
  // fails closed, so a mistyped upgrade flag cannot reopen writes.
  const readOnly = env.WISER_READ_ONLY !== undefined
    && env.WISER_READ_ONLY !== "" && env.WISER_READ_ONLY !== "false";
  const upgradeError = "The CRM is read-only during an upgrade.";
  // A regular expression's end anchor can match before a trailing newline.
  // Reject control characters before classifying any decoded route.
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(path)) {
    return readOnly ? refusal(503, upgradeError) : refusal(400, "This request path is invalid.");
  }

  let you: PeopleCaller = "agent";
  if (identity.caller === "agent") {
    if (request.headers.has("Cf-Access-Authenticated-User-Email")) {
      return refusal(403, "An agent cannot supply a person identity.");
    }
  } else {
    const email = identity.user.email.toLowerCase();
    if (email === firstOwner) {
      you = { email, role: "owner" };
    } else {
      try {
        const person = await findPerson(env.DB, email);
        if (!person?.role) return await waitForRole(request, env.DB, email, !readOnly && !person);
        you = { email, role: person.role };
      } catch {
        return refusal(503, "People are unavailable.");
      }
    }
  }

  if ((request.method === "GET" || request.method === "HEAD") && path === "/api/wiser/instance") {
    if (!env.WISER_INSTANCE) return refusal(503, "This install has no instance name.");
    return Response.json({ instance: env.WISER_INSTANCE, version: releaseVersion, caller: identity.caller, read_only: readOnly }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if ((request.method === "GET" || request.method === "HEAD") && path === "/api/wiser/brand") {
    const headers = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
    return request.method === "HEAD"
      ? new Response(null, { headers })
      : Response.json(installBrand(env), { headers });
  }
  // Hono also runs GET handlers for HEAD.
  const readMethod = isReadMethod(request.method);
  if (readOnly && (!readMethod || isWritingGet(path))) return refusal(503, upgradeError);
  if (you !== "agent" && !mayWriteApp(you.role) && (!readMethod || isViewerSyncRead(path))) {
    return refusal(403, "Viewers can only read the CRM.");
  }
  if (path === peoplePath || path.startsWith(peoplePath + "/")) {
    try {
      return await peopleResponse(request, path, env.DB, firstOwner, you);
    } catch {
      return refusal(503, "People are unavailable.");
    }
  }
  if (request.method === "POST" && publicRuns.has(path)) {
    return refusal(403, "Public job runs are not available in Wiser CRM.");
  }
  if (unavailableFeature(request.method, path)) {
    return refusal(409, "This feature is not available in Wiser CRM.");
  }

  if (request.method === "POST" && path === "/api/wiser/intake/take-in") {
    if (!dependencies.takeIn) return refusal(409, "Intake is not configured.");
    try {
      return Response.json(await dependencies.takeIn(), { headers: { "Cache-Control": "no-store" } });
    } catch {
      return refusal(503, "Intake is unavailable.");
    }
  }
  if (path.startsWith("/api/") || path === "/llms.txt") {
    return dependencies.appFetch(request, withIdentity(env, identity), context);
  }
  if (!readOnly && you !== "agent" && mayWriteApp(you.role) && request.method === "GET"
    && request.headers.get("Accept")?.toLowerCase().includes("text/html")
    && dependencies.takeIn && typeof context === "object" && context !== null
    && "waitUntil" in context && typeof context.waitUntil === "function") {
    context.waitUntil(Promise.resolve().then(dependencies.takeIn).catch(() => {}));
  }
  return env.ASSETS.fetch(request);
}
