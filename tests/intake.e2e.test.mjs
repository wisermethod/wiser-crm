import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { takeIn } from '../worker/take-in.ts';
import { startApp } from './local-worker.mjs';

const origin = 'https://example.test';
const returnUrl = 'https://example.test/thanks';
const intakeVars = { INTAKE_ORIGIN: origin, INTAKE_RETURN_URL: returnUrl };
const takeInPath = '/api/wiser/intake/take-in';
const contentType = 'application/x-www-form-urlencoded';
const visitor = {
  first_name: 'Ada', last_name: 'Lovelace', email: 'Ada@example.test',
  company: 'Analytical Engine', phone: '+1-202-555-0100', message: 'Please send details.',
};
const fields = Object.keys(visitor);
const erased = Object.fromEntries(fields.map((field) => [field, null]));
const methods = ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'POST'];
const otherPaths = ['/', '/api/contacts', '/submit/', '/submit/x', '/llms.txt'];

function post(app, form = visitor, { path = '/submit', headers = {} } = {}) {
  return app.intakeRequest('POST', path, {
    headers: { Origin: origin, 'Content-Type': contentType, ...headers },
    body: typeof form === 'string' ? form : new URLSearchParams(form).toString(),
  });
}

async function all(db, table) {
  return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
}

function visitorFields(row) {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

function counts(taken_in, failed = 0, remaining = 0) {
  return { taken_in, failed, remaining };
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt++) {
    // The harness's Workers and this inspection client share one local
    // database file, so a read can meet a write's lock. Poll again; any
    // other error still fails the case.
    let result;
    try {
      result = await check();
    } catch (error) {
      if (!/SQLITE_BUSY|database is locked|D1_ERROR/.test(String(error?.cause ?? error) + String(error))) throw error;
    }
    if (result) return result;
    await delay(50);
  }
  return false;
}

test('public intake and CRM take-in through two real local Workers', { timeout: 120_000 }, async (t) => {
  const app = await startApp(t, { intake: true, intakeVars });
  const { crmDb, intakeDb } = app;
  const submissions = () => all(intakeDb, 'submissions');
  const contacts = () => all(crmDb, 'contacts');
  const notes = () => all(crmDb, 'activities');
  const run = (token = app.person) => app.api('POST', takeInPath, 200, { token });
  const importRows = (records) => app.api('POST', '/api/contacts/import', 200, {
    body: { contacts: records, inferCompanyFromEmail: false },
  });

  async function scenario(name, fn) {
    await t.test(name, async () => {
      await intakeDb.batch(['submissions', 'throttle', 'throttle_salts']
        .map((table) => intakeDb.prepare(`DELETE FROM ${table}`)));
      await crmDb.batch(['activities', 'contacts', 'companies'].map((table) => crmDb.prepare(`DELETE FROM ${table}`)));
      await fn();
    });
  }

  await scenario('1: a public POST leaves one submission and take-in creates its contact and note', async () => {
    const response = await post(app, visitor, { headers: { Referer: `${origin}/get-in-touch?campaign=private#fragment` } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, returnUrl);
    assert.equal(response.data, '');
    const rows = await submissions();
    assert.equal(rows.length, 1);
    const [before] = rows;
    assert.match(before.id, /^[a-f0-9-]{36}$/);
    assert.deepEqual(visitorFields(before), visitor);
    assert.equal(before.page, '/get-in-touch');
    assert.equal(before.taken_in_at, null);
    assert.deepEqual(await contacts(), []);
    assert.deepEqual(await notes(), []);
    assert.deepEqual(await run(app.agent), counts(1));
    const records = await contacts();
    const activities = await notes();
    assert.equal(records.length, 1);
    assert.equal(activities.length, 1);
    const [contact] = records;
    const [note] = activities;
    assert.equal(contact.first_name, visitor.first_name);
    assert.equal(note.entity_type, 'contact');
    assert.equal(note.entity_id, contact.id);
    assert.equal(note.type, 'note');
    assert.equal(note.body, `${visitor.message}\n\nCompany: ${visitor.company}\nPhone: ${visitor.phone}\nPage: /get-in-touch`);
    assert.deepEqual(JSON.parse(note.meta), { intake_submission: before.id });
    const [after] = await submissions();
    assert.equal(after.contact_id, contact.id);
    assert.ok(after.taken_in_at);
    assert.deepEqual(visitorFields(after), erased);
  });

  await scenario('2: two submissions from one visitor become one contact and two notes', async () => {
    assert.equal((await post(app)).status, 303);
    assert.equal((await post(app, { ...visitor, first_name: ' ada ', email: ' ADA@EXAMPLE.TEST ', message: 'Follow-up.' })).status, 303);
    const [first, second] = await submissions();
    assert.notEqual(first.id, second.id);
    assert.deepEqual(await run(), counts(2));
    const [contact] = await contacts();
    assert.equal((await contacts()).length, 1);
    const activities = await notes();
    assert.equal(activities.length, 2);
    assert.ok(activities.every((note) => note.entity_id === contact.id));
    assert.deepEqual(activities.map((note) => JSON.parse(note.meta).intake_submission).sort(), [first.id, second.id].sort());
    assert.deepEqual(await run(), counts(0));
  });

  await scenario('3: concurrent take-ins acquire one claim and a third run adds nothing', async () => {
    assert.equal((await post(app)).status, 303);
    const [first, second] = await Promise.all([run(), run(app.agent)]);
    assert.equal(first.taken_in + second.taken_in, 1);
    assert.equal(first.failed + second.failed, 0);
    assert.deepEqual(await run(), counts(0));
    assert.equal((await contacts()).length, 1);
    assert.equal((await notes()).length, 1);

    // Force the selection/claim race even when local HTTP requests serialize.
    assert.equal((await post(app, { ...visitor, message: 'Still held by the other run.' })).status, 303);
    const [, waiting] = await submissions();
    const competingClaim = crypto.randomUUID();
    const now = new Date();
    const staleQueue = {
      batch: (statements) => intakeDb.batch(statements),
      prepare(sql) {
        if (!sql.trimStart().startsWith('SELECT id FROM submissions')) return intakeDb.prepare(sql);
        return { bind: (...args) => ({ all: async () => {
          const selected = await intakeDb.prepare(sql).bind(...args).all();
          assert.deepEqual(selected.results, [{ id: waiting.id }]);
          await intakeDb.prepare('UPDATE submissions SET claim_id = ?, claimed_at = ? WHERE id = ?')
            .bind(competingClaim, now.toISOString(), waiting.id).run();
          return selected;
        } }) };
      },
    };
    assert.deepEqual(await takeIn(crmDb, staleQueue, () => now), counts(0, 0, 1));
    const [, stillWaiting] = await submissions();
    assert.equal(stillWaiting.claim_id, competingClaim);
    assert.equal(stillWaiting.message, waiting.message);
    assert.equal((await notes()).length, 1);

    await intakeDb.prepare("UPDATE submissions SET claimed_at = datetime('now', '-11 minutes') WHERE id = ?")
      .bind(waiting.id).run();
    assert.deepEqual(await run(), counts(1));
    assert.equal((await contacts()).length, 1);
    assert.equal((await notes()).length, 2);
  });

  await scenario('4: a failed note read-back retains every intake field and a retry reuses the note', async () => {
    assert.equal((await post(app)).status, 303);
    let reads = 0;
    const missingReadBack = {
      prepare(sql) {
        if (!sql.trimStart().startsWith('SELECT entity_id FROM activities')) return crmDb.prepare(sql);
        return { bind: () => ({ first: async () => { reads++; return null; } }) };
      },
      batch: (statements) => crmDb.batch(statements),
    };
    const now = new Date();
    assert.deepEqual(await takeIn(missingReadBack, intakeDb, () => now), counts(0, 1, 1));
    assert.equal(reads, 2);
    assert.equal((await contacts()).length, 1);
    assert.equal((await notes()).length, 1);
    const [pending] = await submissions();
    assert.deepEqual(visitorFields(pending), visitor);
    assert.equal(pending.taken_in_at, null);
    assert.equal(pending.contact_id, null);
    assert.equal(pending.claimed_at, now.toISOString());
    assert.ok(pending.claim_id);
    assert.deepEqual(await takeIn(crmDb, intakeDb, () => new Date(now.getTime() + 9 * 60_000)), counts(0, 0, 1));
    assert.deepEqual(await takeIn(crmDb, intakeDb, () => new Date(now.getTime() + 11 * 60_000)), counts(1));
    assert.deepEqual(visitorFields((await submissions())[0]), erased);
    assert.equal((await contacts()).length, 1);
    assert.equal((await notes()).length, 1);
  });

  await scenario('5: neither email domain nor typed company name creates or links a company', async () => {
    await crmDb.prepare("INSERT INTO companies (id, name, domain) VALUES ('existing', 'Analytical Engine', 'example.test')").run();
    const companies = await all(crmDb, 'companies');
    assert.equal(companies.length, 1);
    assert.equal((await post(app, { ...visitor, company: '' })).status, 303);
    assert.equal((await post(app, { ...visitor, first_name: 'Grace', email: 'grace@elsewhere.test' })).status, 303);
    assert.deepEqual(await run(), counts(2));
    assert.deepEqual(await all(crmDb, 'companies'), companies);
    const records = await contacts();
    assert.equal(records.length, 2);
    assert.ok(records.every((contact) => contact.company_id === null));
    const activities = await notes();
    assert.match(activities.find((note) => note.entity_id === records.find((r) => r.first_name === 'Grace').id).body, /Company: Analytical Engine/);
  });

  await scenario('7: only POST /submit is routed on the intake address', async () => {
    for (const path of ['/submit', ...otherPaths]) {
      for (const method of methods) {
        if (method === 'POST' && path === '/submit') continue;
        const response = await app.intakeRequest(method, path);
        assert.equal(response.status, path === '/submit' ? 405 : 404, `${method} ${path}`);
        assert.equal(response.headers['cache-control'], 'no-store');
        if (path === '/submit') assert.equal(response.headers.allow, 'POST');
      }
    }
    assert.deepEqual(await submissions(), []);
  });

  await scenario('8: bounded body before parsing and only one allowlisted set of fields', async () => {
    const oversized = `x=${'x'.repeat(16_383)}`;
    for (const headers of [{ 'Content-Length': Buffer.byteLength(oversized) }, { 'Transfer-Encoding': 'chunked' }]) {
      const response = await post(app, oversized, { headers });
      assert.equal(response.status, 413);
    }
    assert.deepEqual(await submissions(), []);
    const form = new URLSearchParams({
      first_name: ' \x01Ada\x7f ', last_name: ` ${'L'.repeat(220)} `, email: ' Ada@example.test ',
      company: ' Engine\u0085 Works ', phone: ' 123\t45 ', message: ` First\r\n\tline\x00 ${'x'.repeat(5_100)} `,
    });
    for (const field of fields) form.append(field, field === 'email' ? 'second@example.test' : 'second lead');
    form.append('', 'unlabelled');
    form.append('extra', 'unrecognized');
    assert.equal((await post(app, form)).status, 303);
    const rows = await submissions();
    assert.equal(rows.length, 1);
    assert.deepEqual(visitorFields(rows[0]), {
      first_name: 'Ada', last_name: 'L'.repeat(200), email: 'Ada@example.test', company: 'Engine Works',
      phone: '12345', message: `First\n\tline ${'x'.repeat(5_100)}`.slice(0, 5_000),
    });
    assert.equal(Object.hasOwn(rows[0], 'extra'), false);
    assert.equal(Object.hasOwn(rows[0], ''), false);
  });

  await scenario('9: origin must match exactly and every refused POST stores nothing', async () => {
    const body = new URLSearchParams(visitor).toString();
    for (const supplied of [undefined, 'null', 'https://example.test.evil.example', 'http://example.test',
      'https://example.test:443', 'https://example.test/', 'https://EXAMPLE.test']) {
      const headers = { 'Content-Type': contentType, ...(supplied === undefined ? {} : { Origin: supplied }) };
      assert.equal((await app.intakeRequest('POST', '/submit', { headers, body })).status, 403, supplied);
    }
    assert.deepEqual(await submissions(), []);
  });

  await scenario('10: installed redirect ignores fields, query, Referer and Host', async () => {
    const redirects = Object.fromEntries(['return', 'redirect', 'next', 'url'].map((name) => [name, 'https://elsewhere.test/']));
    const response = await post(app, { ...visitor, ...redirects }, {
      path: `/submit?${new URLSearchParams(redirects)}`,
      headers: { Referer: 'https://elsewhere.test/private?id=123', Host: 'override.example.test' },
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, returnUrl);
    assert.equal(response.data, '');
    const [record] = await submissions();
    assert.equal(record.page, '');
    assert.deepEqual(visitorFields(record), visitor);
  });

  await scenario('11: no intake response exposes a stored message or submission id', async () => {
    const message = 'private-memo-c20-totally-distinct';
    const initial = await post(app, { ...visitor, message });
    const [{ id }] = await submissions();
    function privateResponse(response, expected) {
      assert.equal(response.status, expected);
      assert.equal(response.headers['cache-control'], 'no-store');
      const serialized = JSON.stringify(response);
      assert.equal(serialized.includes(message), false);
      assert.equal(serialized.includes(id), false);
    }
    privateResponse(initial, 303);
    for (const path of ['/submit', ...otherPaths]) {
      for (const method of methods) {
        if (path === '/submit' && method === 'POST') continue;
        privateResponse(await app.intakeRequest(method, path), path === '/submit' ? 405 : 404);
      }
    }
    privateResponse(await post(app, { ...visitor, message }, { headers: { Origin: 'https://elsewhere.test' } }), 403);
    privateResponse(await post(app, { ...visitor, message }, { headers: { 'Content-Type': 'text/plain' } }), 415);
    privateResponse(await post(app, `message=${message}`), 400);
    privateResponse(await post(app, `message=${message}${'x'.repeat(16_384)}`), 413);
    privateResponse(await post(app, { ...visitor, message }), 303);
  });

  await scenario('13: a day-31 form post erases all six visitor fields from an untaken submission', async () => {
    assert.equal((await post(app)).status, 303);
    const [old] = await submissions();
    await intakeDb.prepare("UPDATE submissions SET received_at = datetime('now', '-31 days') WHERE id = ?").bind(old.id).run();
    assert.equal((await post(app, { ...visitor, message: 'New message.' })).status, 303);
    const [aged, fresh] = await submissions();
    assert.deepEqual(visitorFields(aged), erased);
    assert.equal(aged.id, old.id);
    assert.equal(aged.taken_in_at, null);
    assert.equal(fresh.message, 'New message.');
    assert.deepEqual(await run(), counts(1));
    assert.equal((await notes()).length, 1);
  });

  await scenario('take-in and contact import write equivalent columns and defaults', async () => {
    assert.equal((await importRows([visitor])).imported, 1);
    const [imported] = await contacts();
    assert.ok(imported.company_id);
    await crmDb.prepare('DELETE FROM contacts WHERE id = ?').bind(imported.id).run();
    assert.equal((await post(app)).status, 303);
    assert.deepEqual(await run(), counts(1));
    const [taken] = await contacts();
    assert.equal(taken.company_id, null);
    assert.notEqual(imported.id, taken.id);
    for (const row of [imported, taken]) {
      assert.match(row.id, /^[0-9a-f-]{36}$/);
      assert.match(row.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
      assert.equal(row.updated_at, row.created_at);
    }
    const stable = ({ id, created_at, updated_at, company_id, ...values }) => values;
    assert.deepEqual(stable(taken), stable(imported));
  });

  await scenario('take-in matches the import on name and email case, spaces, Unicode and distinct first names', async () => {
    const cases = [
      ['case', 'Ada', 'ADA@EXAMPLE.TEST', 'aDA', 'ada@example.test', true],
      ['surrounding spaces', '\u00a0 Ada\t', ' ada@example.test ', ' Ada ', ' Ada@EXAMPLE.TEST ', true],
      ['same email with another first name', 'Ada', 'ada@example.test', 'Augusta', 'ada@example.test', false],
      ['Unicode first names', ' ÉLODIE ', 'elodie@example.test', 'élodie', 'elodie@example.test', true],
      ['SQLite email prefilter', 'Élodie', '\telodie@example.test', 'Élodie', 'elodie@example.test', false],
    ];
    for (const [name, storedName, storedEmail, first_name, email, matches] of cases) {
      await crmDb.batch([
        crmDb.prepare('DELETE FROM activities'),
        crmDb.prepare('DELETE FROM contacts'),
        crmDb.prepare("INSERT INTO contacts (id, first_name, email, updated_at) VALUES ('older', ?, ?, '2025-01-01')").bind(storedName, storedEmail),
        crmDb.prepare("INSERT INTO contacts (id, first_name, email, updated_at) VALUES ('latest', ?, ?, '2026-01-01')").bind(storedName, storedEmail),
      ]);
      const form = { ...visitor, company: '', first_name, email };
      const imported = await importRows([form]);
      assert.equal(imported.matched, Number(matches), name);
      assert.equal(imported.imported, Number(!matches), name);
      if (matches) {
        const records = await contacts();
        assert.equal(records.find((r) => r.id === 'latest').phone, form.phone, name);
        assert.equal(records.find((r) => r.id === 'older').phone, '', name);
        await crmDb.prepare("UPDATE contacts SET phone = '', last_name = '', updated_at = '2026-01-01' WHERE id = 'latest'").run();
      } else {
        await crmDb.prepare("DELETE FROM contacts WHERE id NOT IN ('older', 'latest')").run();
      }
      assert.equal((await post(app, form)).status, 303);
      assert.deepEqual(await run(), counts(1), name);
      const records = await contacts();
      assert.equal(records.length, matches ? 2 : 3, name);
      const [{ entity_id }] = await notes();
      assert.equal(entity_id, matches ? 'latest' : records[2].id, name);
      assert.equal(records.find((r) => r.id === 'latest').phone, '', name);
    }
  });

  await scenario('only a signed-in person opening HTML triggers a background take-in', async () => {
    assert.equal((await post(app)).status, 303);
    const headers = { Accept: 'text/html,application/xhtml+xml' };
    assert.equal((await app.request('POST', takeInPath, { token: null })).status, 401);
    assert.equal((await app.request('GET', '/', { token: null, headers })).status, 401);
    assert.equal((await app.request('GET', '/', { token: app.agent, headers })).status, 200);
    assert.equal((await app.request('HEAD', '/', { headers })).status, 200);
    assert.equal((await app.request('GET', '/', { headers: { Accept: 'application/json' } })).status, 200);
    assert.equal((await app.request('GET', '/llms.txt', { headers })).status, 200);
    assert.equal((await app.request('GET', '/api/contacts', { headers })).status, 200);
    assert.equal(await waitFor(async () => (await notes()).length !== 0), false);
    const asset = await app.request('GET', '/contacts/visiting', { headers });
    assert.equal(asset.status, 200);
    assert.match(asset.data, /<html/);
    assert.equal(await waitFor(async () => (await submissions())[0].taken_in_at !== null), true);
    assert.equal((await contacts()).length, 1);
    assert.equal((await notes()).length, 1);
  });
});

test('12: read-only CRM serves HTML and refuses take-in while intake keeps the submission', { timeout: 120_000 }, async (t) => {
  const app = await startApp(t, { intake: true, intakeVars, vars: { WISER_READ_ONLY: 'true' } });
  const response = await post(app);
  assert.equal(response.status, 303);
  const [before] = await all(app.intakeDb, 'submissions');
  const asset = await app.request('GET', '/', { headers: { Accept: 'text/html' } });
  assert.equal(asset.status, 200);
  assert.match(asset.data, /<html/);
  for (const token of [app.person, app.agent]) {
    const refusal = await app.request('POST', takeInPath, { token });
    assert.equal(refusal.status, 503);
    assert.deepEqual(refusal.data, { error: 'The CRM is read-only during an upgrade.' });
  }
  assert.equal(await waitFor(async () => (await all(app.crmDb, 'activities')).length !== 0), false);
  assert.deepEqual(await all(app.crmDb, 'contacts'), []);
  assert.deepEqual(await all(app.crmDb, 'activities'), []);
  assert.deepEqual(await all(app.intakeDb, 'submissions'), [before]);
  assert.deepEqual(visitorFields(before), visitor);
});

test('the signed-in take-in route returns 409 when the install has no intake binding', { timeout: 120_000 }, async (t) => {
  const app = await startApp(t);
  assert.equal((await app.request('POST', takeInPath, { token: null })).status, 401);
  for (const token of [app.person, app.agent]) {
    const response = await app.request('POST', takeInPath, { token });
    assert.equal(response.status, 409);
    assert.deepEqual(response.data, { error: 'Intake is not configured.' });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});
