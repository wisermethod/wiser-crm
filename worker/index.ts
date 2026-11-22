import { createRemoteJWKSet } from "jose";
import app from "../src/server/index.js";
import type { BrandSettings } from "./brand.ts";
import { isConfigured, signIn, type SignInConfiguration } from "./sign-in.ts";
import { takeIn } from "./take-in.ts";

interface Environment extends BrandSettings {
  DB: D1Database;
  INTAKE_DB?: D1Database;
  OWNER_EMAIL?: string;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  AGENT_CLIENT_ID?: string;
  WISER_INSTANCE?: string;
  WISER_READ_ONLY?: string;
}

// A team's resolver retains jose's cache and rotation handling across requests.
const teamKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(config: SignInConfiguration) {
  if (!isConfigured(config)) return null;
  const team = config.teamDomain!;
  let keys = teamKeySets.get(team);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    teamKeySets.set(team, keys);
  }
  return keys;
}

export default {
  fetch(request: Request, env: Environment, context: ExecutionContext): Promise<Response> {
    const configuration = {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      agentClientId: env.AGENT_CLIENT_ID,
      ownerEmail: env.OWNER_EMAIL,
    };
    const intake = env.INTAKE_DB;
    return signIn(request, env, context, {
      takeIn: intake && (() => takeIn(env.DB, intake)),
      appFetch: (req, bindings, ctx) => app.fetch(req, bindings, ctx),
      keySet: keySet(configuration),
      configuration,
      routePath: (req) => app.getPath(req),
    });
  },
};
