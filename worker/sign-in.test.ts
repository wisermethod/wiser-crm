import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  createLocalJWKSet, exportJWK, generateKeyPair, SignJWT,
  type JWTPayload, type JWTVerifyGetKey,
} from "jose";
import { caller, user } from "../runtime/app/identity.ts";
import { signIn, type SignInConfiguration } from "./sign-in.ts";

const configuration = {
  teamDomain: "https://example.cloudflareaccess.com",
  audience: "test-audience",
  agentClientId: "agent-client-id",
};
const { privateKey, publicKey } = await generateKeyPair("RS256");
const otherTeam = await generateKeyPair("RS256");
const rotated = await generateKeyPair("RS256");
const localKeys = createLocalJWKSet({ keys: [
  { ...await exportJWK(publicKey), kid: "current", alg: "RS256", use: "sig" },
  { ...await exportJWK(rotated.publicKey), kid: "previous", alg: "RS256", use: "sig" },
] });

async function token(claims: JWTPayload = {}, key = privateKey, kid = "current") {
  return new SignJWT({
    type: "app", sub: "person-123", email: "person@example.com",
    iss: configuration.teamDomain, aud: configuration.audience,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  }).setProtectedHeader({ alg: "RS256", kid }).sign(key);
}

function harness(config: SignInConfiguration = configuration, keySet: JWTVerifyGetKey | null = localKeys) {
  const appCalls: Array<{ request: Request; caller: ReturnType<typeof caller>; user: ReturnType<typeof user>; env: object; context: object }> = [];
  const assetCalls: Request[] = [];
  const context = { waitUntil(_work: Promise<unknown>) {}, passThroughOnException() {} };
  const env = {
    marker: "original binding",
    ASSETS: { async fetch(request: Request) {
      assetCalls.push(request);
      return new Response("asset");
    } },
  };
  const dependencies = {
    configuration: config,
    keySet,
    appFetch(request: Request, bindings: typeof env, ctx: typeof context) {
      const identity = { caller: caller({ env: bindings }), user: user({ env: bindings }) };
      appCalls.push({ request, ...identity, env: bindings, context: ctx });
      assert.equal(bindings.marker, env.marker);
      return Response.json(identity);
    },
  };
  return {
    appCalls, assetCalls, env, context,
    fetch(path = "/api/contacts", init: RequestInit = {}, credential?: string) {
      const headers = new Headers(init.headers);
      if (credential !== undefined) headers.set("Cf-Access-Jwt-Assertion", credential);
      const request = new Request(new URL(path, "https://crm.example.com"), { ...init, headers });
      return signIn(request, env, context, dependencies);
    },
  };
}

async function refused(h: ReturnType<typeof harness>, status: number, path?: string, init?: RequestInit, credential?: string) {
  const response = await h.fetch(path, init, credential);
  assert.equal(response.status, status);
  const body = await response.json() as { error: string };
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
  assert.doesNotMatch(body.error, /clawnify|cloudflare/i);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(h.appCalls.length, 0);
  assert.equal(h.assetCalls.length, 0);
  return body;
}

test("case 1: missing assertion reaches neither app nor assets", async () => {
  await refused(harness(), 401);
});

test("cases 2 and 5: any case of the forbidden header prefix is refused first", async () => {
  for (const name of ["X-Clawnify-User-Id", "x-cLaWnIfY-anything", "X-Clawnify-"]) {
    for (const credential of [undefined, await token(), await token({ sub: "", common_name: configuration.agentClientId })]) {
      await refused(harness(), 403, "/api/contacts", { headers: { [name]: "forged" } }, credential);
      await refused(harness({}), 403, "/", { headers: { [name]: "forged" } }, credential);
    }
  }
});

test("case 3: forged signature is refused", async () => {
  await refused(harness(), 401, undefined, undefined, await token({}, otherTeam.privateKey));
});

test("case 3: expired token is refused", async () => {
  await refused(harness(), 401, undefined, undefined, await token({ exp: Math.floor(Date.now() / 1000) - 60 }));
});

test("case 3: another application's audience is refused", async () => {
  await refused(harness(), 401, undefined, undefined, await token({ aud: "another-application" }));
});

test("case 3: another team's issuer signed with that team's key is refused", async () => {
  await refused(harness(), 401, undefined, undefined,
    await token({ iss: "https://other.cloudflareaccess.com" }, otherTeam.privateKey));
  // Issuer checking must also hold even if a trusted key signs the wrong issuer.
  await refused(harness(), 401, undefined, undefined, await token({ iss: "https://other.cloudflareaccess.com" }));
});

for (const path of ["/api/email-sync/run", "/api/ai-columns/run", "/api/meetings/run"]) {
  test(`case 4: POST ${path} is refused for both people and agents`, async () => {
    for (const credential of [await token(), await token({ sub: "", common_name: configuration.agentClientId })]) {
      await refused(harness(), 403, `${path}?ignored=1`, { method: "POST" }, credential);
    }
    await refused(harness(), 401, path, { method: "POST" });
  });
}

test("cases 4 and 11: a percent-encoded path is refused, since the app routes on the decoded one", async () => {
  // The control: Hono decodes before routing, so this path reaches the run handler.
  const app = new Hono();
  app.post("/api/email-sync/run", (c) => c.text("ran"));
  const reached = await app.fetch(new Request("https://crm.example.com/api/email-sync/%72un", { method: "POST" }));
  assert.equal(await reached.text(), "ran");

  await refused(harness(), 403, "/api/email-sync/%72un", { method: "POST" }, await token());
  await refused(harness(), 409, "/api/integrations/%65mail", { method: "POST" }, await token());
});

test("case 5: an agent with the authenticated person email header is refused", async () => {
  await refused(harness(), 403, undefined, { headers: { "Cf-Access-Authenticated-User-Email": "forged@example.com" } },
    await token({ sub: "", common_name: configuration.agentClientId }));
  await refused(harness(), 403, undefined, { headers: { "Cf-Access-Authenticated-User-Email": "" } },
    await token({ sub: "", common_name: configuration.agentClientId }));
});

test("case 6: a person reaches the app with the token's id and email through the real runtime", async () => {
  const h = harness();
  const response = await h.fetch("/api/contacts?user=forged", {
    headers: { "Cf-Access-Authenticated-User-Email": "forged@example.com", Cookie: "user=forged" },
  }, await token());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { caller: "user", user: { id: "person-123", email: "person@example.com" } });
  assert.equal(h.appCalls.length, 1);
  assert.equal(h.assetCalls.length, 0);
  assert.notEqual(h.appCalls[0].env, h.env);
  assert.equal(h.appCalls[0].context, h.context);
  assert.equal(caller({ env: h.env }), null);
  assert.equal(user({ env: h.env }), null);
});

test("case 10: no credential on a workers.dev address is refused for every surface", async () => {
  for (const path of ["/", "/api/contacts", "/llms.txt", "/contacts/1"]) {
    await refused(harness(), 401, `https://wiser-crm.example.workers.dev${path}`);
  }
});

const platformRoutes = [
  ["POST", "/api/integrations/email"],
  ["POST", "/api/integrations/meeting"],
  ["PUT", "/api/email-sync"],
  ["GET", "/api/email-sync/labels"],
  ["HEAD", "/api/email-sync/labels"],
  ["POST", "/api/email-sync/sync-now"],
  ["PUT", "/api/meetings/sync"],
  ["POST", "/api/meetings/sync-now"],
  ["PUT", "/api/ai-columns/contact/title"],
  ["POST", "/api/ai-columns/company/industry/fill"],
  ["POST", "/api/ai-columns/contact/title/cells/1"],
  ["POST", "/api/meetings/1/digest"],
];
for (const [method, path] of platformRoutes) {
  test(`case 11: ${method} ${path} returns 409 without calling the app`, async () => {
    for (const credential of [await token(), await token({ sub: "", common_name: configuration.agentClientId })]) {
      const body = await refused(harness(), 409, `${path}?ignored=1`, { method }, credential);
      assert.equal(body.error, "This feature is not available in Wiser CRM.");
    }
  });
}

test("an unconfigured or malformed instance refuses every surface even with a valid token", async () => {
  for (const config of [
    {}, { ...configuration, teamDomain: "" }, { ...configuration, audience: "" },
    { ...configuration, audience: "bad audience" },
    ...["http://example.cloudflareaccess.com", "https://example.com", "https://example.cloudflareaccess.com/",
      "https://example.cloudflareaccess.com.evil.example", "https://user@example.cloudflareaccess.com",
      "https://example.cloudflareaccess.com:443", "https://example.cloudflareaccess.com?x=1"].map(teamDomain => ({ ...configuration, teamDomain })),
  ]) {
    for (const path of ["/", "/api/contacts", "/llms.txt", "/contacts/1"]) {
      const body = await refused(harness(config), 503, path, undefined, await token());
      assert.equal(body.error, "Sign-in is not configured.");
    }
  }
  await refused(harness(configuration, null), 503);
});

test("an assertion sent only in the authorization cookie is refused", async () => {
  await refused(harness(), 401, undefined, { headers: { Cookie: `CF_Authorization=${await token()}` } });
});

test("unknown service identities and agents disabled by empty configuration are refused", async () => {
  await refused(harness(), 401, undefined, undefined, await token({ sub: "", common_name: "someone-else" }));
  await refused(harness({ ...configuration, agentClientId: "" }), 401, undefined, undefined,
    await token({ sub: "", common_name: configuration.agentClientId }));
  await refused(harness({ ...configuration, agentClientId: undefined }), 401, undefined, undefined,
    await token({ sub: "", common_name: configuration.agentClientId }));
  const person = harness({ ...configuration, agentClientId: "" });
  assert.equal((await person.fetch(undefined, undefined, await token())).status, 200);
});

test("the configured agent reaches the app with caller agent and no user", async () => {
  const h = harness();
  const response = await h.fetch(undefined, undefined, await token({ sub: "", common_name: configuration.agentClientId }));
  assert.deepEqual(await response.json(), { caller: "agent", user: null });
  assert.equal(h.appCalls.length, 1);
  assert.equal(h.assetCalls.length, 0);
});

test("verified static and deep-link requests reach only assets; unverified ones reach neither", async () => {
  for (const path of ["/", "/contacts/1", "/assets/main.js"]) {
    const h = harness();
    assert.equal(await (await h.fetch(path, undefined, await token())).text(), "asset");
    assert.equal(h.assetCalls.length, 1);
    assert.equal(new URL(h.assetCalls[0].url).pathname, path);
    assert.equal(h.appCalls.length, 0);
    await refused(harness(), 401, path);
  }
});

test("verified API, llms and status reads pass through without overblocking cleanup", async () => {
  for (const [method, path] of [
    ["GET", "/llms.txt"], ["HEAD", "/llms.txt"], ["GET", "/api/openapi.json"],
    ["GET", "/api/integrations/status"], ["GET", "/api/email-sync"],
    ["GET", "/api/meetings/sync"], ["GET", "/api/ai-columns?entity_type=contact"],
    ["DELETE", "/api/ai-columns/contact/title"], ["GET", "/api/contacts/1/emails"],
    ["PUT", "/api/meetings/1"],
  ]) {
    const h = harness();
    assert.equal((await h.fetch(path, { method }, await token())).status, 200);
    assert.equal(h.appCalls.length, 1);
    assert.equal(h.assetCalls.length, 0);
  }
});

test("nbf, exp, token type, required identity, and key id are enforced", async () => {
  for (const claims of [
    { nbf: Math.floor(Date.now() / 1000) + 300 }, { exp: undefined }, { type: "org" },
    { type: undefined }, { sub: undefined }, { sub: " " }, { email: undefined }, { email: " " },
    { sub: "", common_name: undefined },
  ]) {
    await refused(harness(), 401, undefined, undefined, await token(claims));
  }
  await refused(harness(), 401, undefined, undefined, await token({}, privateKey, "unknown"));
  await refused(harness(), 401, undefined, undefined, await token({}, privateKey, ""));
  await refused(harness(), 401, undefined, undefined, "malformed");
});

test("only RS256 is accepted, and rotation selects the matching trusted kid", async () => {
  // The trusted key names no alg and the token is otherwise valid, so only the
  // wrapper's RS256 allowlist can refuse it.
  const pss = await generateKeyPair("PS256");
  const untypedKeys = createLocalJWKSet({ keys: [{ ...await exportJWK(pss.publicKey), kid: "pss", use: "sig" }] });
  const credential = await new SignJWT({
    type: "app", sub: "person", email: "person@example.com",
    iss: configuration.teamDomain, aud: configuration.audience, exp: Math.floor(Date.now() / 1000) + 300,
  }).setProtectedHeader({ alg: "PS256", kid: "pss" }).sign(pss.privateKey);
  await refused(harness(configuration, untypedKeys), 401, undefined, undefined, credential);
  const h = harness();
  assert.equal((await h.fetch(undefined, undefined, await token({}, rotated.privateKey, "previous"))).status, 200);
});

test("person and agent identities remain separate across concurrent requests", async () => {
  const h = harness();
  const results = await Promise.all([
    h.fetch(undefined, undefined, await token()),
    h.fetch(undefined, undefined, await token({ sub: "", common_name: configuration.agentClientId })),
  ]);
  assert.deepEqual(await Promise.all(results.map(r => r.json())), [
    { caller: "user", user: { id: "person-123", email: "person@example.com" } },
    { caller: "agent", user: null },
  ]);
  assert.equal(caller({ env: h.env }), null);
});
