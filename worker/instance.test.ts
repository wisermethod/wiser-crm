import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { signIn } from "./sign-in.ts";

const configuration = { teamDomain: "https://local.cloudflareaccess.com", audience: "local", agentClientId: "agent" };
const keys = await generateKeyPair("RS256");
const keySet = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256" }] });
async function mint(agent = false) {
  return new SignJWT({ type: "app", sub: agent ? "" : "staff", email: agent ? undefined : "staff@example.test", common_name: agent ? "agent" : undefined })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(configuration.teamDomain)
    .setAudience(configuration.audience).setExpirationTime("5m").sign(keys.privateKey);
}
const staff = await mint(), agent = await mint(true);
function harness(flag?: string, instance: string | undefined = "test-install") {
  let appCalls = 0, assetCalls = 0;
  const env = { WISER_INSTANCE: instance, WISER_READ_ONLY: flag, ASSETS: { async fetch() { assetCalls++; return new Response("asset"); } } };
  return {
    calls: () => [appCalls, assetCalls],
    fetch(path: string, method = "GET", credential: string | null = staff, headers = {}) {
      return signIn(new Request(`https://crm.example.test${path}`, { method, headers: { ...headers, ...(credential === null ? {} : { "Cf-Access-Jwt-Assertion": credential }) } }), env, {}, {
        configuration, keySet, appFetch() { appCalls++; return new Response("upstream"); },
      });
    },
  };
}
const error = { error: "The CRM is read-only during an upgrade." };
const writingGets = [
  "/api/stats", "/api/stages", "/api/deals", "/api/deals/board", "/api/deals/progress", "/api/deals/1",
  "/api/customers", "/api/lookup?email=person@example.test", "/api/email-sync", "/api/contacts/1/emails",
  "/api/meetings/sync", "/api/views?entity=contact",
];

for (const [credential, caller] of [[staff, "user"], [agent, "agent"]]) {
  test(`instance identifies verified ${caller}, ignores supplied identity and stays in wrapper`, async () => {
    const h = harness();
    const response = await h.fetch("/api/wiser/instance?caller=other", "GET", credential, { "X-Wiser-Caller": "other" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { instance: "test-install", version: "dev", caller, read_only: false });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(h.calls(), [0, 0]);
  });
}
for (const instance of ["", undefined]) {
  test(`instance refuses ${instance === "" ? "empty" : "unset"} name`, async () => {
    // Remove the binding as well as testing its empty value.
    const env = { WISER_INSTANCE: instance, ASSETS: { async fetch() { return new Response("asset"); } } };
    const response = await signIn(new Request("https://crm.example.test/api/wiser/instance", { headers: { "Cf-Access-Jwt-Assertion": staff } }), env, {}, {
      configuration, keySet, appFetch() { throw new Error("Unnamed instance reached upstream"); },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "This install has no instance name." });
  });
}
test("instance verifies caller before answering or revealing missing name/read-only state", async () => {
  for (const credential of [null, "invalid"]) {
    const h = harness("true", "");
    const response = await h.fetch("/api/wiser/instance", "GET", credential);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Sign in to use Wiser CRM." });
    assert.deepEqual(h.calls(), [0, 0]);
  }
  const response = await harness().fetch("/api/wiser/instance", "GET", agent, { "Cf-Access-Authenticated-User-Email": "forged@example.test" });
  assert.equal(response.status, 403);
});

for (const flag of ["true", "yes", "FALSE", "0", " "]) {
  test(`read-only ${JSON.stringify(flag)} blocks every write before downstream for staff and agent`, async () => {
    for (const credential of [staff, agent]) {
      const h = harness(flag);
      for (const method of ["POST", "PATCH", "DELETE", "PUT", "OPTIONS"]) {
        const response = await h.fetch("/api/contacts", method, credential);
        assert.equal(response.status, 503, method);
        assert.deepEqual(await response.json(), error);
        assert.equal(response.headers.get("Cache-Control"), "no-store");
      }
      for (const path of [...writingGets, "/api/email-%73ync?check=1", "/api/contacts/a%20b/emails",
        "/api/contacts/1/emails%0a", "/api/contacts/1/emails%0d", "/api/contacts/1/emails%E2%80%A8", "/api/contacts/1/emails%E2%80%A9"]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await h.fetch(path, method, credential);
          assert.equal(response.status, 503, `${method} ${path}`);
          assert.deepEqual(await response.json(), error);
        }
      }
      assert.deepEqual(h.calls(), [0, 0]);
    }
  });
}
for (const flag of [undefined, "", "false"]) {
  test(`writable ${JSON.stringify(flag)} passes writes and writing GETs downstream`, async () => {
    const h = harness(flag);
    for (const method of ["POST", "PATCH", "DELETE"]) assert.equal(await (await h.fetch("/api/contacts", method)).text(), "upstream");
    for (const path of writingGets) assert.equal(await (await h.fetch(path)).text(), "upstream");
    assert.deepEqual(h.calls(), [15, 0]);
    assert.deepEqual(await (await h.fetch("/api/wiser/instance")).json(), { instance: "test-install", version: "dev", caller: "user", read_only: false });
  });
}
test("read-only keeps reads, assets and instance, verifies before the write refusal", async () => {
  const h = harness("true");
  for (const method of ["GET", "HEAD"]) {
    for (const path of ["/api/contacts", "/api/openapi.json", "/llms.txt"]) assert.equal(await (await h.fetch(path, method)).text(), "upstream");
    assert.equal(await (await h.fetch("/assets/main.js", method)).text(), "asset");
  }
  assert.deepEqual(await (await h.fetch("/api/wiser/instance")).json(), { instance: "test-install", version: "dev", caller: "user", read_only: true });
  assert.deepEqual(h.calls(), [6, 2]);
  assert.equal((await h.fetch("/api/contacts", "POST", null)).status, 401);
  assert.equal((await h.fetch("/api/email-sync", "GET", "invalid")).status, 401);
});
