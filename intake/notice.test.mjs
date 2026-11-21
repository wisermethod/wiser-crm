import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.ts";

const receivedAt = Date.parse("2026-11-20T10:55:59.123Z");
const origin = "https://form.example.com";
const destination = "crm-inbox@example.com";
const sender = "notices@example.com";
const crmUrl = "https://crm.example.com";
const returnUrl = origin + "/thanks";
const visitor = {
  first_name: "Ada\r\nBcc: x@example.com",
  last_name: "Lovelace\u2028Example",
  email: "ada@example.com",
  company: "Analytical\r\nEngine",
  phone: "+1-202-555-0100",
  message: "First line.\nSecond line.",
  to: "second@example.com",
  cc: "second@example.com",
  bcc: "second@example.com",
  replyTo: "second@example.com",
};
const structuredNotice = {
  to: destination,
  from: { email: sender, name: "Wiser CRM" },
  subject: "New website enquiry, 20 Nov 2026 10:55 UTC",
  text: [
    "New enquiry from /contact",
    "",
    "Name:       AdaBcc: x@example.com LovelaceExample",
    "Work email: ada@example.com",
    "Company:    AnalyticalEngine",
    "Phone:      +1-202-555-0100",
    "",
    "Message:",
    "First line.",
    "Second line.",
    "",
    "This lead is saved. It appears in your CRM the",
    "next time the CRM is opened:",
    crmUrl,
  ].join("\n"),
};

function setup(t, errors = [], throttled = false) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: receivedAt });
  const sent = [];
  const inserted = [];
  const outcomes = [];
  const firstAttempt = Promise.withResolvers();
  const db = {
    prepare(sql) {
      const statement = sql.trimStart();
      return {
        bind(...values) {
          return {
            async first() { return "test-salt"; },
            async run() {
              if (statement.startsWith("INSERT INTO submissions")) {
                if (throttled) return { meta: { changes: 0 } };
                inserted.push(values);
              }
              if (statement.startsWith("UPDATE submissions SET notice_outcome")) outcomes.push(values);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const env = {
    INTAKE_DB: db, INTAKE_ORIGIN: origin, INTAKE_RETURN_URL: returnUrl,
    NOTICE_TO: destination, NOTICE_FROM: sender, CRM_URL: crmUrl,
    NOTICE: {
      async send(notice) {
        sent.push(notice);
        firstAttempt.resolve();
        assert.equal(inserted.length, 1, "the lead must exist before any notice attempt");
        assert.deepEqual(outcomes, [], "the outcome must not be written during the send");
        if (errors.length) throw errors.shift();
        return { messageId: "local-message" };
      },
    },
  };
  function request(fields = visitor, referer = origin + "/contact?private=1") {
    return new Request(origin + "/submit", {
      method: "POST",
      headers: { Origin: origin, Referer: referer },
      body: new URLSearchParams(fields),
    });
  }
  function assertOutcome(outcome) {
    assert.equal(inserted.length, 1);
    assert.deepEqual(outcomes, [[outcome, inserted[0][0]]]);
  }
  return { env, sent, inserted, outcomes, request, assertOutcome, firstAttempt: firstAttempt.promise };
}

function assertRedirect(response) {
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), returnUrl);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
}

test("the notice is one structured send with exact UTC subject, body and only the configured recipient", async (t) => {
  const { env, request, sent, assertOutcome } = setup(t);
  assertRedirect(await worker.fetch(request(), env));
  assert.deepEqual(sent, [structuredNotice]);
  assertOutcome("sent");
});

test("the form page is saved and printed in the notice when the Referer carries only the origin", async (t) => {
  const { env, request, sent, inserted, assertOutcome } = setup(t);
  assertRedirect(await worker.fetch(request({ ...visitor, page: "/contact" }, origin + "/"), env));
  assert.deepEqual({ page: inserted[0][2], notices: sent }, { page: "/contact", notices: [structuredNotice] });
  assertOutcome("sent");
});

for (const [shape, page] of [
  ["absolute address", "https://evil.example/x"],
  ["protocol-relative address", "//evil.example"],
  ["line break", "/contact\nextra"],
  ["200-character overflow", "/" + "x".repeat(200)],
  ["query", "/contact?query=1"],
  ["fragment", "/contact#form"],
  ["backslash", "/contact\\extra"],
  ["space", "/contact extra"],
  ["non-ASCII", "/contáct"],
]) {
  test(`an invalid page (${shape}) falls back to the Referer path in storage and in the notice`, async (t) => {
    const { env, request, sent, inserted, assertOutcome } = setup(t);
    assertRedirect(await worker.fetch(request({ ...visitor, page }), env));
    assert.equal(inserted[0][2], "/contact");
    assert.deepEqual(sent, [structuredNotice]);
    assertOutcome("sent");
  });
}

test("a 200-character page is accepted as sent, including percent escapes", async (t) => {
  const prefix = "/legal%20pages/";
  const page = prefix + "x".repeat(200 - prefix.length);
  const { env, request, sent, inserted, assertOutcome } = setup(t);
  assert.equal(page.length, 200);
  assertRedirect(await worker.fetch(request({ ...visitor, page }, origin + "/"), env));
  assert.equal(inserted[0][2], page);
  assert.equal(sent[0].text.split("\n", 1)[0], `New enquiry from ${page}`);
  assertOutcome("sent");
});

test("empty optional fields print empty values and an unset CRM URL omits the footer", async (t) => {
  const { env, request, sent, assertOutcome } = setup(t);
  const fields = { ...visitor, first_name: "Ada", last_name: "", company: "", phone: "" };
  assertRedirect(await worker.fetch(request(fields), { ...env, CRM_URL: undefined }));
  assert.deepEqual(sent, [{
    ...structuredNotice,
    text: "New enquiry from /contact\n\nName:       Ada \nWork email: ada@example.com\nCompany:    \nPhone:      \n\nMessage:\nFirst line.\nSecond line.",
  }]);
  assertOutcome("sent");
});

test("a populated website honeypot returns the same redirect without a save or send", async (t) => {
  const { env, request, sent, inserted, outcomes } = setup(t);
  assertRedirect(await worker.fetch(request({ ...visitor, website: "bot" }), env));
  assert.deepEqual(inserted, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(outcomes, []);
});

for (const [label, error, outcome] of [
  ["coded", { code: "E_TEST_SEND" }, "failed:E_TEST_SEND"],
  ["uncoded", new Error("internal error"), "failed:unknown"],
]) {
  test(`a ${label} send failure is recorded without retry and still redirects`, async (t) => {
    const { env, request, sent, assertOutcome } = setup(t, [error]);
    const response = await worker.fetch(request(), env);
    assertRedirect(response);
    assert.deepEqual(sent, [structuredNotice]);
    assertOutcome(outcome);
  });
}

for (const firstCode of ["E_SENDER_DOMAIN_NOT_CONFIGURED", "E_EMAIL_SENDING_NOT_READY"]) {
  test(`${firstCode} waits and retries the same structured send once`, async (t) => {
    const secondError = firstCode === "E_EMAIL_SENDING_NOT_READY" ? { code: firstCode } : undefined;
    const errors = secondError ? [{ code: firstCode }, secondError] : [{ code: firstCode }];
    const { env, request, sent, assertOutcome, firstAttempt } = setup(t, errors);
    const completion = worker.fetch(request(), env);
    await Promise.race([firstAttempt, completion]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [structuredNotice], "the retry must wait inside the request");
    t.mock.timers.tick(1_000);
    assertRedirect(await completion);
    assert.deepEqual(sent, [structuredNotice, structuredNotice]);
    assertOutcome(secondError ? `failed:${firstCode}` : "sent");
  });
}

for (const missing of ["NOTICE", "NOTICE_FROM", "NOTICE_TO"]) {
  test(`a missing ${missing} binding or variable records none and sends nothing`, async (t) => {
    const { env, request, sent, assertOutcome } = setup(t);
    assertRedirect(await worker.fetch(request(), { ...env, [missing]: undefined }));
    assert.deepEqual(sent, []);
    assertOutcome("none");
  });
}

test("a throttle refusal never calls the configured mail binding", async (t) => {
  const { env, request, sent, inserted, outcomes } = setup(t, [], true);
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(inserted, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(outcomes, []);
});
