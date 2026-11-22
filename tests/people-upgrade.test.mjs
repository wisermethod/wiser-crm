import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './local-worker.mjs';

const recordTables = ['contacts', 'companies', 'deals', 'activities'];
const markers = ['companies.customer_since', 'deals.company_id'];
const recordRows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(({ results }) => results);
const snapshot = async (db) => Object.fromEntries(await Promise.all(recordTables.map(async (table) => [table, await recordRows(db, table)])));
const markerKeys = (db) => db.prepare('SELECT key FROM data_backfills ORDER BY key').all().then(({ results }) => results.map(({ key }) => key));

async function seed(db) {
  await db.batch([
    "INSERT INTO companies (id, name, created_at, updated_at) VALUES ('company', 'Company', '2025-01-01', '2025-01-01')",
    "INSERT INTO contacts (id, first_name, email, company_id, created_at, updated_at) VALUES ('contact', 'Contact', 'contact@example.test', 'company', '2025-01-01', '2025-01-01')",
    "INSERT INTO stages (key, label, is_won) VALUES ('won-fixture', 'Won', 1)",
    "INSERT INTO deals (id, name, contact_id, stage, close_date, created_at, updated_at) VALUES ('deal', 'Deal', 'contact', 'won-fixture', '2025-03-02', '2025-01-01', '2025-03-03')",
    "INSERT INTO activities (id, entity_type, entity_id, body, created_at) VALUES ('note', 'contact', 'contact', 'Keep this note', '2025-01-01')",
  ].map((sql) => db.prepare(sql)));
}

test('S1-11 migration matches the real app backfills and viewer reads leave record tables unchanged', { timeout: 120_000 }, async (t) => {
  let initial;
  const setupBaseline = async (db) => {
    await seed(db);
    assert.deepEqual(await markerKeys(db), []);
    const records = await snapshot(db);
    assert.equal(records.companies[0].customer_since, null);
    assert.equal(records.deals[0].company_id, null);
    if (initial) assert.deepEqual(records, initial);
    else initial = records;
  };

  let legacy;
  await t.test('baseline-only database runs the upstream backfills via stats', async (control) => {
    const app = await startApp(control, { inspect: true, setupBaseline, baselineOnly: true });
    await app.api('GET', '/api/stats', 200);
    legacy = await snapshot(app.crmDb);
    assert.deepEqual(await markerKeys(app.crmDb), markers);
    assert.equal(legacy.companies[0].customer_since, '2025-03-02');
    assert.equal(legacy.deals[0].company_id, 'company');
  });
  assert.ok(legacy, 'baseline control completed');

  const app = await startApp(t, { inspect: true, setupBaseline });
  assert.deepEqual(await markerKeys(app.crmDb), markers);
  assert.deepEqual(await snapshot(app.crmDb), legacy);
  const email = 'viewer@example.test';
  await app.api('PUT', `/api/wiser/people/${encodeURIComponent(email)}`, 204, { body: { role: 'viewer' } });
  const token = await app.personFor(email);
  for (const path of ['/api/stats', '/api/deals', '/api/deals/board', '/api/deals/progress', '/api/deals/deal',
    '/api/customers', '/api/lookup?email=contact@example.test']) {
    await app.api('GET', path, 200, { token });
    assert.deepEqual(await snapshot(app.crmDb), legacy, `Viewer changed records on ${path}`);
  }
});

test('S1-19 upgrading an existing baseline preserves records and serves the first owner at once', { timeout: 120_000 }, async (t) => {
  let before;
  const app = await startApp(t, {
    inspect: true,
    async setupBaseline(db) {
      await seed(db);
      // Existing markers keep intentionally cleared columns clear.
      await db.batch(markers.map((key) => db.prepare('INSERT INTO data_backfills (key) VALUES (?)').bind(key)));
      before = await snapshot(db);
    },
  });
  assert.ok(before);
  assert.deepEqual(await snapshot(app.crmDb), before);
  assert.deepEqual(await markerKeys(app.crmDb), markers);
  const listed = await app.api('GET', '/api/contacts', 200);
  assert.equal(listed.contacts[0].id, 'contact');
  assert.equal((await app.api('GET', '/api/wiser/people', 200)).you.role, 'owner');
  assert.deepEqual(await recordRows(app.crmDb, 'wiser_people'), []);
});
