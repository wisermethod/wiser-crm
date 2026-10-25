import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './local-worker.mjs';

test('overlapping contact imports fill blanks, preserve existing values and match email plus first name', { timeout: 120_000 }, async (t) => {
  const app = await startApp(t);
  app.operation('POST', '/api/contacts/import');
  app.operation('GET', '/api/contacts');
  const initial = [
    { first_name: 'Ada', last_name: 'Lovelace', email: 'Ada@example.test', title: 'Analyst', status: 'active', company: 'M2b Import Company' },
    { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.test', phone: '+1-202-555-0122', title: 'Engineer', status: 'lead', company: 'M2b Import Company' },
    { first_name: 'Katherine', last_name: 'Johnson', email: 'katherine@example.test', phone: '+1-202-555-0123', title: 'Mathematician', status: 'active', company: 'M2b Import Company' },
  ];
  const importRows = (contacts) => app.api('POST', '/api/contacts/import', 200, { body: { contacts, inferCompanyFromEmail: false } });
  const list = () => app.api('GET', '/api/contacts?limit=100', 200);
  assert.deepEqual(await importRows(initial), { imported: 3, matched: 0, companiesCreated: 1, skipped: 0, duplicates: 0 });
  const before = await list();
  assert.equal(before.total, 3);
  assert.equal(before.contacts.length, 3);
  for (const row of initial) {
    const record = before.contacts.find((record) => record.email === row.email);
    assert.ok(record);
    for (const [field, value] of Object.entries(row)) {
      if (field !== 'company') assert.equal(record[field], value);
    }
    assert.ok(record.company_id);
  }
  const phone = '+1-202-555-0199';
  const overlap = [
    { first_name: 'ADA', last_name: 'Replacement', email: 'ada@EXAMPLE.test', phone, title: 'Replacement title', status: 'lead', company: 'Replacement Company' },
    { first_name: 'GRACE', last_name: 'Replacement', email: 'GRACE@example.test', phone: '+1-202-555-0000', title: 'Replacement title', status: 'active', company: 'Replacement Company' },
    { first_name: 'Dorothy', last_name: 'Vaughan', email: 'dorothy@example.test', title: 'Supervisor', status: 'lead', company: 'M2b Import Company' },
  ];
  assert.deepEqual(await importRows(overlap), { imported: 1, matched: 2, companiesCreated: 1, skipped: 0, duplicates: 0 });
  const after = await list();
  assert.equal(after.total, 4);
  assert.equal(after.contacts.length, 4);
  const matchKey = (record) => `${record.email.trim().toLowerCase()}|${record.first_name.trim().toLowerCase()}`;
  assert.equal(new Set(after.contacts.map(matchKey)).size, 4);
  for (const original of before.contacts) {
    const current = after.contacts.find((record) => record.id === original.id);
    assert.ok(current, `Original contact ${original.first_name} must keep its id`);
    // Compare every pre-existing nonblank field, not just the conflicting ones.
    for (const [field, value] of Object.entries(original)) {
      if (field !== 'updated_at' && value !== '' && value !== null) {
        assert.deepEqual(current[field], value, `Import overwrote ${original.first_name}.${field}`);
      }
    }
  }
  assert.equal(after.contacts.find((record) => record.email === initial[0].email).phone, phone);
  const added = after.contacts.find((record) => record.email === overlap[2].email);
  assert.ok(added);
  for (const [field, value] of Object.entries(overlap[2])) if (field !== 'company') assert.equal(added[field], value);

  // agent.md: email alone never matches, even when another contact has it.
  assert.deepEqual(await importRows([{ first_name: 'Augusta', last_name: 'King', email: initial[0].email }]),
    { imported: 1, matched: 0, companiesCreated: 0, skipped: 0, duplicates: 0 });
  const final = await list();
  assert.equal(final.total, 5);
  assert.equal(final.contacts.length, 5);
  const sameEmail = final.contacts.filter((record) => record.email.toLowerCase() === initial[0].email.toLowerCase());
  assert.deepEqual(sameEmail.map((record) => record.first_name).sort(), ['Ada', 'Augusta']);
  assert.equal(new Set(sameEmail.map((record) => record.id)).size, 2);
  for (const record of after.contacts) {
    assert.deepEqual(final.contacts.find((current) => current.id === record.id), record, 'Email-only nonmatch must leave existing records unchanged');
  }
});
