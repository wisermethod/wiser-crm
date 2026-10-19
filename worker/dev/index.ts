import { createLocalJWKSet } from "jose";
import { signIn, type SignInDependencies } from "../sign-in.ts";

interface LocalEnvironment {
  WISER_LOCAL_DEV?: string;
  DEV_JWKS?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isLocal(request: Request, env: LocalEnvironment): boolean {
  const hostname = new URL(request.url).hostname;
  return env.WISER_LOCAL_DEV === "1"
    && (hostname === "localhost" || hostname === "127.0.0.1");
}

type LocalApp<E, C> = Pick<SignInDependencies<E, C>, "appFetch" | "routePath">;

/** The injected app keeps tests on the same local guard and real sign-in path. */
export async function localFetch<E extends LocalEnvironment, C>(
  request: Request,
  env: E,
  context: C,
  loadApp: () => Promise<LocalApp<E, C>>,
): Promise<Response> {
  if (!isLocal(request, env)) return jsonError(403, "Local development is disabled.");

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/__wiser-dev/sign-in") {
    // Another site's page cannot replace the local session by linking here.
    if (request.headers.get("Sec-Fetch-Site") === "cross-site") return jsonError(403, "Local sign-in must be opened directly.");
    const token = url.searchParams.get("token");
    if (!token) return jsonError(400, "A local token is required.");
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": `wiser_dev_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  const headers = new Headers(request.headers);
  const cookie = headers.get("Cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("wiser_dev_token="));
  if (cookie !== undefined) {
    // Never pass the local credential cookie to either downstream, even when
    // an explicit Access assertion takes precedence over it.
    headers.delete("Cookie");
    if (!headers.has("Cf-Access-Jwt-Assertion")) {
      try {
        headers.set("Cf-Access-Jwt-Assertion", decodeURIComponent(cookie.slice("wiser_dev_token=".length)));
      } catch {
        return jsonError(401, "The local token cookie is invalid.");
      }
    }
  }

  let keySet: ReturnType<typeof createLocalJWKSet>;
  try {
    keySet = createLocalJWKSet(JSON.parse(env.DEV_JWKS ?? ""));
  } catch {
    return jsonError(503, "Local sign-in keys are not configured.");
  }
  return signIn(new Request(request, { headers }), env, context, {
    ...await loadApp(),
    keySet,
    configuration: {
      teamDomain: "https://local.cloudflareaccess.com",
      audience: "local",
      agentClientId: "local-agent",
    },
  });
}

export default {
  fetch(request: Request, env: LocalEnvironment & { DB: D1Database }, context: ExecutionContext): Promise<Response> {
    return localFetch(request, env, context, async () => {
      const { default: app } = await import("../../src/server/index.js");
      return {
        appFetch: (req, bindings, ctx) => app.fetch(req, bindings, ctx),
        routePath: (req) => app.getPath(req),
      };
    });
  },
};
