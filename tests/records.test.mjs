import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './local-worker.mjs';

// Routes and request fields: agent.md and the running GET /api/openapi.json.
test('person record CRUD and append-only activity timeline', { timeout: 120_000 }, async (t) => {
  const app = await startApp(t);
  const records = [];

  async function crud(entity, plural, input, patch) {
    const collection = `/api/${plural}`;
    const detail = `${collection}/{id}`;
    for (const [method, path] of [['POST', collection], ['GET', detail], ['PUT', detail], ['DELETE', detail]]) {
      app.operation(method, path);
    }
    for (const [method, body] of [['POST', input], ['PUT', patch]]) {
      const schema = app.operation(method, method === 'POST' ? collection : detail)
        .requestBody.content['application/json'].schema;
      for (const field of Object.keys(body)) assert.ok(schema.properties[field], `Undocumented ${entity} field ${field}`);
    }
    const created = (await app.api('POST', collection, 201, { body: input }))[entity];
    assert.equal(typeof created.id, 'string');
    assert.ok(created.id.length > 0);
    for (const [field, value] of Object.entries(input)) assert.deepEqual(created[field], value, `${entity} create ${field}`);
    const path = `${collection}/${created.id}`;
    const before = (await app.api('GET', path, 200))[entity];
    for (const [field, value] of Object.entries(created)) assert.deepEqual(before[field], value, `${entity} read ${field}`);
    const updated = (await app.api('PUT', path, 200, { body: patch }))[entity];
    for (const [field, value] of Object.entries(patch)) {
      assert.notDeepEqual(before[field], value, `${entity} patch must change a value`);
      assert.deepEqual(updated[field], value, `${entity} update response ${field}`);
    }
    const after = (await app.api('GET', path, 200))[entity];
    // updated_at is server-owned; every other returned field must survive a
    // one-field patch, including ids, relations and fields not set by this test.
    const stable = ({ updated_at, ...record }) => record;
    assert.deepEqual(stable(after), stable({ ...before, ...patch }), `${entity} update preserves other fields`);
    for (const [field, value] of Object.entries(updated)) assert.deepEqual(after[field], value, `${entity} updated read ${field}`);
    records.push({ entity, plural, path, id: created.id });
    return created;
  }

  let company, contact;
  await t.test('company create, read and one-field update', async () => {
    company = await crud('company', 'companies', {
      name: 'M2b Company', domain: 'm2b.example.test', industry: 'Research',
      phone: '+1-202-555-0100', email: 'company@example.test', notes: 'Original company note',
    }, { industry: 'Engineering' });
    assert.equal(company.name, 'M2b Company');
  });
  await t.test('contact linked to company: create, read and one-field update', async () => {
    contact = await crud('contact', 'contacts', {
      first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test',
      phone: '+1-202-555-0101', company_id: company.id, title: 'Analyst', status: 'lead',
    }, { title: 'Principal Analyst' });
    assert.equal(contact.company_id, company.id);
  });
  await t.test('deal linked to company and contact: create, read and one-field update', async () => {
    const deal = await crud('deal', 'deals', {
      name: 'M2b Deal', company_id: company.id, contact_id: contact.id,
      value: 1250, stage: 'prospect', close_date: '2026-12-31', notes: 'Original deal note',
    }, { value: 1500 });
    assert.equal(deal.company_id, company.id);
    assert.equal(deal.contact_id, contact.id);
  });
  await t.test('activity note acknowledges creation and appears in the contact timeline; API stays append-only', async () => {
    app.operation('GET', '/api/activities');
    app.operation('POST', '/api/activities');
    assert.deepEqual(Object.keys(app.openapi.paths['/api/activities']).sort(), ['get', 'post']);
    assert.equal(Object.hasOwn(app.openapi.paths, '/api/activities/{id}'), false);
    assert.deepEqual(Object.keys(app.openapi.paths).filter((path) => path.startsWith('/api/activities/')), []);
    const note = { entity_type: 'contact', entity_id: contact.id, type: 'note', body: 'M2b contact timeline note' };
    assert.deepEqual(await app.api('POST', '/api/activities', 201, { body: note }), { ok: true });
    const timeline = await app.api('GET', `/api/activities?entity_type=contact&entity_id=${contact.id}`, 200);
    const found = timeline.activities.filter((activity) => activity.body === note.body);
    assert.equal(found.length, 1);
    for (const [field, value] of Object.entries(note)) assert.equal(found[0][field], value);
  });
  // Delete dependants first, so each deletion tests that record's own route.
  for (const { entity, plural, path, id } of records.toReversed()) {
    await t.test(`${entity} delete removes it from detail and list`, async () => {
      assert.deepEqual(await app.api('DELETE', path, 200), { ok: true });
      const missing = await app.api('GET', path, 404);
      assert.equal(typeof missing.error, 'string');
      const listed = await app.api('GET', `/api/${plural}`, 200);
      assert.equal(listed[plural].some((record) => record.id === id), false);
    });
  }
});
