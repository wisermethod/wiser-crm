import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { caller, user } from "../../runtime/app/identity.ts";
import { localFetch } from "./index.ts";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwks = { keys: [{ ...await exportJWK(publicKey), kid: "local-test", alg: "RS256", use: "sig" }] };
async function token(sub = "person", email = "person@example.test") {
  return new SignJWT({ type: "app", sub, email })
    .setProtectedHeader({ alg: "RS256", kid: "local-test" })
    .setIssuer("https://local.cloudflareaccess.com").setAudience("local")
    .setExpirationTime("5m").sign(privateKey);
}

function harness(enabled: string | undefined = "1", keys: string | undefined = JSON.stringify(jwks)) {
  const calls: Request[] = [];
  let loads = 0;
  const env = {
    WISER_LOCAL_DEV: enabled,
    DEV_JWKS: keys,
    ASSETS: { async fetch(req: Request) { calls.push(req); return new Response("asset"); } },
  };
  return {
    calls,
    get loads() { return loads; },
    fetch(url: string, init?: RequestInit) {
      return localFetch(new Request(url, init), env, {}, async () => {
        loads++;
        return {
          appFetch(req: Request, bindings: typeof env) {
            calls.push(req);
            return Response.json({ caller: caller({ env: bindings }), user: user({ env: bindings }) });
          },
        };
      });
    },
  };
}

test("non-local hosts refuse before loading or calling the app, even when enabled", async () => {
  for (const host of ["example.com", "localhost.example.com", "127.0.0.2", "[::1]"]) {
    const h = harness();
    const res = await h.fetch(`http://${host}/__wiser-dev/sign-in?token=unused`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Local development is disabled." });
    assert.equal(res.headers.get("Content-Type")?.startsWith("application/json"), true);
    assert.equal(h.loads, 0);
    assert.equal(h.calls.length, 0);
  }
});

test("127.0.0.1 refuses when the explicit local flag is unset or different", async () => {
  for (const flag of ["", "0", "true"]) {
    const h = harness(flag);
    assert.equal((await h.fetch("http://127.0.0.1/api/contacts")).status, 403);
    assert.equal(h.loads, 0);
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  const env = { ASSETS: { async fetch() { throw new Error("assets called"); } } };
  const res = await localFetch(new Request("http://127.0.0.1/"), env, {}, async () => {
    throw new Error("app loaded");
  });
  assert.equal(res.status, 403);
  assert.equal(h.calls.length, 0);
});

test("local sign-in redirects home and sets only the HttpOnly Strict root cookie", async () => {
  for (const host of ["localhost", "127.0.0.1"]) {
    const h = harness();
    const res = await h.fetch(`http://${host}/__wiser-dev/sign-in?token=a%2Bb%2Fc`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "/");
    assert.equal(res.headers.get("Set-Cookie"), "wiser_dev_token=a%2Bb%2Fc; HttpOnly; SameSite=Strict; Path=/");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(h.loads, 0);
    assert.equal(h.calls.length, 0);
  }
});

test("local sign-in opened from another site sets no cookie", async () => {
  const h = harness();
  const res = await h.fetch("http://127.0.0.1/__wiser-dev/sign-in?token=planted", { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Set-Cookie"), null);
  for (const site of ["none", "same-origin"]) {
    const direct = await h.fetch("http://127.0.0.1/__wiser-dev/sign-in?token=typed", { headers: { "Sec-Fetch-Site": site } });
    assert.equal(direct.status, 302);
  }
  assert.equal(h.loads, 0);
});

test("cookie becomes the Access assertion and never reaches the real sign-in downstream", async () => {
  const h = harness();
  const credential = await token();
  const res = await h.fetch("http://127.0.0.1/api/contacts", {
    headers: { Cookie: `other=value; wiser_dev_token=${credential}`, "Content-Type": "application/json" },
    method: "POST", body: JSON.stringify({ first_name: "Local" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { caller: "user", user: { id: "person", email: "person@example.test" } });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].headers.get("Cf-Access-Jwt-Assertion"), credential);
  assert.equal(h.calls[0].headers.has("Cookie"), false);
  assert.equal(await h.calls[0].text(), JSON.stringify({ first_name: "Local" }));
});

test("an existing assertion takes precedence over the cookie, including an invalid assertion", async () => {
  const cookie = await token("cookie-person");
  const header = await token("header-person");
  const h = harness();
  const res = await h.fetch("http://localhost/api/contacts", {
    headers: { Cookie: `wiser_dev_token=${cookie}`, "Cf-Access-Jwt-Assertion": header },
  });
  assert.equal(res.status, 200);
  assert.equal(h.calls[0].headers.get("Cf-Access-Jwt-Assertion"), header);
  assert.equal(h.calls[0].headers.has("Cookie"), false);
  const { payload } = await jwtVerify(header, createLocalJWKSet(jwks));
  assert.equal(payload.sub, "header-person");
  for (const value of ["invalid", ""]) {
    const refused = harness();
    const response = await refused.fetch("http://localhost/api/contacts", {
      headers: { Cookie: `wiser_dev_token=${cookie}`, "Cf-Access-Jwt-Assertion": value },
    });
    assert.equal(response.status, 401);
    assert.equal(refused.calls.length, 0);
  }
});

test("absent or forged credentials still fail the real wrapper", async () => {
  const cases: HeadersInit[] = [{}, { Cookie: "wiser_dev_token=invalid" }, { Cookie: "wiser_dev_token=%zz" }];
  for (const headers of cases) {
    const h = harness();
    assert.equal((await h.fetch("http://127.0.0.1/api/contacts", { headers })).status, 401);
    assert.equal(h.calls.length, 0);
  }
});

test("a cookie also authenticates assets without forwarding the cookie", async () => {
  const h = harness();
  const res = await h.fetch("http://localhost/contacts", { headers: { Cookie: `wiser_dev_token=${await token()}` } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "asset");
  assert.equal(h.calls[0].headers.has("Cookie"), false);
});

test("missing local keys and a sign-in without a token fail closed", async () => {
  const h = harness("1", "");
  assert.equal((await h.fetch("http://localhost/api/contacts")).status, 503);
  assert.equal((await h.fetch("http://localhost/__wiser-dev/sign-in")).status, 400);
  assert.equal(h.loads, 0);
  assert.equal(h.calls.length, 0);
});
