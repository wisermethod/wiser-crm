import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.ts";

const origin = "https://example.test";
const configured = {
  INTAKE_ORIGIN: origin,
  INTAKE_RETURN_URL: origin + "/thanks",
};

function database() {
  const inserts: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() { return "test-salt"; },
            async run() {
              if (sql.trimStart().startsWith("INSERT INTO submissions")) inserts.push(values);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  return { inserts, env: { ...configured, INTAKE_DB: db } };
}

function form(body: BodyInit, headers?: Record<string, string>) {
  return new Request(origin + "/submit", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

test("8: the byte cap rejects a large header before reading and cancels an oversized stream despite a false header", async () => {
  const { env, inserts } = database();
  for (const [length, expectedPulls] of [["16385", 0], ["10", 2], [undefined, 2]] as const) {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(pulls === 1 ? 16_384 : 1));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const response = await worker.fetch(form(body, length ? { "Content-Length": length } : {}), env);
    assert.equal(response.status, 413);
    assert.equal(pulls, expectedPulls);
    assert.equal(cancelled, expectedPulls !== 0);
  }
  assert.deepEqual(inserts, []);
});

test("a body of exactly 16,384 bytes is accepted", async () => {
  const { env, inserts } = database();
  const valid = "first_name=Ada&email=ada%40example.test&message=a&extra=";
  const body = valid + "x".repeat(16_384 - valid.length);
  const response = await worker.fetch(form(body), env);
  assert.equal(response.status, 303);
  assert.equal(inserts.length, 1);
});

test("a capped value stays trimmed and preserves full Unicode characters", async () => {
  const { env, inserts } = database();
  const firstName = "𐐀".repeat(199);
  const body = new URLSearchParams({ first_name: ` ${firstName} suffix`, email: "a@b", message: "hello" });
  const response = await worker.fetch(form(body), env);
  assert.equal(response.status, 303);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][3], firstName);
});

test("required fields and malformed email receive a generic refusal", async () => {
  const { env, inserts } = database();
  const valid = { first_name: "Ada", email: "ada@example.test", message: "Example message." };
  for (const invalid of [
    { first_name: "" }, { email: "" }, { message: "\t\r " }, { email: "@example.test" },
    { email: "ada@" }, { email: "a@b@c" }, { email: "ada @example.test" },
    { email: "a\x00da@example.test" }, { email: "adaexample.test" },
  ]) {
    const response = await worker.fetch(form(new URLSearchParams({ ...valid, ...invalid })), env);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Invalid form.");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.deepEqual(inserts, []);
});

test("missing intake configuration gives a fixed 503 without reading a request body", async () => {
  const { env, inserts } = database();
  for (const missing of ["INTAKE_DB", "INTAKE_ORIGIN", "INTAKE_RETURN_URL"] as const) {
    const response = await worker.fetch(form("this must never be echoed"), { ...env, [missing]: undefined });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "Intake unavailable.");
  }
  assert.deepEqual(inserts, []);
});
