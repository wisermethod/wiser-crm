import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from './local-worker.mjs';

const roster = '/api/wiser/people';
const takeIn = '/api/wiser/intake/take-in';
const owner = 'person@example.test';
const applicant = 'waiting@example.test';
const member = 'member@example.test';
const viewer = 'viewer@example.test';
const browser = { Accept: 'text/html,application/xhtml+xml' };
const viewerError = 'Viewers can only read the CRM.';
const peopleError = 'Only an owner can change people.';
const contactInput = { first_name: 'Mary', last_name: 'Jackson', title: 'Engineer' };
const appOptions = { inspect: true };
const personPath = (email) => `${roster}/${encodeURIComponent(email)}`;
const setRole = (app, email, role) => app.api('PUT', personPath(email), 204, { body: { role } });
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(({ results }) => results);

function scenario(number, title, run, options = appOptions) {
  test(`S1-${String(number).padStart(2, '0')} ${title}`, { timeout: 120_000 }, async (t) => {
    await run(await startApp(t, options), t);
  });
}

async function waiting(app, token, method = 'GET') {
  const response = await app.request(method, '/', { token, headers: browser });
  assert.equal(response.status, 403, `waiting page status: ${JSON.stringify(response.data)}`);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /^text\/html/);
  if (method === 'GET') assert.match(response.data, /<h1>Waiting for access<\/h1>/);
  else assert.equal(response.data, '');
}

async function refused(app, token, method, path, status = 403, error, options = {}) {
  const response = await app.request(method, path, { ...options, token });
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.data)}`);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /^application\/json/);
  if (method !== 'HEAD') {
    assert.deepEqual(Object.keys(response.data), ['error']);
    assert.equal(typeof response.data.error, 'string');
    if (error) assert.equal(response.data.error, error);
  }
}

const deniedSurfaces = [
  ['GET', '/api/contacts'], ['GET', '/api/wiser/instance'], ['GET', '/api/wiser/brand'],
  ['POST', takeIn], ['GET', '/llms.txt'], ['GET', '/favicon.ico'], ['GET', roster],
];

scenario(1, 'unassigned person sees only the waiting page and none of the app surfaces', async (app) => {
  const token = await app.personFor(applicant);
  assert.deepEqual(await rows(app.crmDb, 'wiser_people'), []);
  await waiting(app, token);
  await waiting(app, token, 'HEAD');
  for (const [method, path] of deniedSurfaces) await refused(app, token, method, path);
  await refused(app, token, 'GET', '/', 403, undefined, { headers: { Accept: 'text/html;q=0,application/json' } });
});

async function plantIntake(app) {
  const id = crypto.randomUUID();
  await app.intakeDb.prepare(
    "INSERT INTO submissions (id, received_at, page, first_name, last_name, email, company, phone, message, notice_outcome) VALUES (?, datetime('now'), '/', 'Intake', '', 'visitor@example.test', '', '', 'Test lead', 'sent')",
  ).bind(id).run();
  return id;
}

async function waitForIntake(app, id, expected) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = await app.intakeDb.prepare('SELECT taken_in_at FROM submissions WHERE id = ?').bind(id).first();
    assert.ok(row, 'the intake row still exists');
    if (Boolean(row.taken_in_at) === expected) return true;
    await delay(50);
  }
  return false;
}

async function pageDoesNotTakeIn(app, token, expectedStatus) {
  const id = await plantIntake(app);
  const submissions = await rows(app.intakeDb, 'submissions');
  const contacts = await rows(app.crmDb, 'contacts');
  assert.equal((await app.request('GET', '/', { token, headers: browser })).status, expectedStatus);
  await delay(250);
  assert.equal(await waitForIntake(app, id, true), false, 'page started take-in');
  assert.deepEqual(await rows(app.intakeDb, 'submissions'), submissions);
  assert.deepEqual(await rows(app.crmDb, 'contacts'), contacts);
  // Positive control: the same pending submission is eligible for background intake.
  assert.deepEqual(await app.api('POST', takeIn, 200), { taken_in: 1, failed: 0, remaining: 0 });
  assert.equal(await waitForIntake(app, id, true), true);
  assert.equal((await rows(app.crmDb, 'contacts')).length, contacts.length + 1);
}

scenario(2, 'unassigned page open leaves intake and contacts alone', async (app) => {
  await pageDoesNotTakeIn(app, await app.personFor(applicant), 403);
}, { intake: true });

scenario(3, 'first request creates exactly one waiting record and the next still waits', async (app) => {
  const token = await app.personFor(applicant);
  await waiting(app, token);
  const created = await rows(app.crmDb, 'wiser_people');
  assert.equal(created.length, 1);
  assert.deepEqual({ ...created[0], added_at: Boolean(created[0].added_at) },
    { email: applicant, role: null, added_by: applicant, added_at: true });
  await waiting(app, token);
  assert.deepEqual(await rows(app.crmDb, 'wiser_people'), created);
});

// Read both real D1 results before either concurrent request can insert.
function synchronizePeopleLookups(worker) {
  let lookups = 0;
  return {
    fetch(request, env, context) {
      const db = env.DB;
      const DB = new Proxy(db, {
        get(target, property) {
          if (property !== 'prepare') {
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql) => {
            const statement = db.prepare(sql);
            if (!sql.includes('FROM wiser_people WHERE email = ?')) return statement;
            return {
              bind(...args) {
                const bound = statement.bind(...args);
                return {
                  async first(...columns) {
                    const person = await bound.first(...columns);
                    lookups++;
                    while (lookups < 2) await new Promise(resolve => setTimeout(resolve, 10));
                    return person;
                  },
                };
              },
            };
          };
        },
      });
      return worker.fetch(request, { ...env, DB }, context);
    },
  };
}

scenario(4, 'simultaneous page and asset requests leave one waiting record', async (app) => {
  const token = await app.personFor(applicant);
  await Promise.all([waiting(app, token), refused(app, token, 'GET', '/favicon.ico')]);
  const [row, ...others] = await rows(app.crmDb, 'wiser_people');
  assert.equal(row?.email, applicant);
  assert.equal(row.role, null);
  assert.deepEqual(others, []);
}, { ...appOptions, wrapWorker: synchronizePeopleLookups });

scenario(5, 'unassigned read-only page waits without changing people', async (app) => {
  const before = await rows(app.crmDb, 'wiser_people');
  await waiting(app, await app.personFor(applicant));
  assert.deepEqual(await rows(app.crmDb, 'wiser_people'), before);
}, { ...appOptions, vars: { WISER_READ_ONLY: 'true' } });

scenario(6, 'an existing waiting record never grants access', async (app) => {
  await app.crmDb.prepare('INSERT INTO wiser_people (email, added_by) VALUES (?, ?)').bind(applicant, applicant).run();
  const token = await app.personFor(applicant);
  await waiting(app, token);
  for (const [method, path] of deniedSurfaces) await refused(app, token, method, path);
});

const fixture = {
  '/api/companies/{id}': ['company'],
  '/api/contacts/{id}': ['contact'],
  '/api/stages/{key}': ['stage'],
  '/api/deals/{id}': ['deal'],
  '/api/meetings/{id}': ['meeting'],
  '/api/meetings/{id}/digest': ['meeting'],
  '/api/tasks/{id}': ['task'],
  '/api/deals/{id}/updates': ['deal'],
  '/api/insights/{id}': ['insight'],
  '/api/insights/{id}/deal': ['insight'],
  '/api/contacts/{id}/emails': ['contact'],
  '/api/emails/{mailbox}/{id}': ['mail@example.test', 'message'],
  '/api/ai-columns/{entity}/{key}': ['contact', 'title'],
  '/api/ai-columns/{entity}/{key}/fill': ['contact', 'title'],
  '/api/ai-columns/{entity}/{key}/cells/{id}': ['contact', 'title', 'contact'],
  '/api/custom-fields/{id}': ['custom'],
  '/api/views/{id}': ['view'],
  '/api/views/{id}/fields': ['view'],
  '/api/views/{id}/fields/{key}': ['view', 'email'],
};
const query = {
  '/api/lookup': '?email=contact@example.test',
  '/api/records': '?entity=contact&ids=contact',
  '/api/values': '?entity=contact&field=email',
  '/api/views': '?entity=contact',
};
const syncReads = new Set(['/api/contacts/{id}/emails', '/api/email-sync', '/api/meetings/sync']);
const httpMethods = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace'];
const isRead = (method) => method === 'GET' || method === 'HEAD';

async function seedRouteRecords(db) {
  await db.batch([
    "INSERT OR IGNORE INTO companies (id, name) VALUES ('company', 'Company')",
    "INSERT OR IGNORE INTO contacts (id, first_name, email, company_id) VALUES ('contact', 'Contact', 'contact@example.test', 'company')",
    "INSERT OR IGNORE INTO stages (key, label) VALUES ('stage', 'Fixture stage')",
    "INSERT OR IGNORE INTO deals (id, name, contact_id, stage) VALUES ('deal', 'Deal', 'contact', 'stage')",
    "INSERT OR IGNORE INTO meetings (id, starts_at, link_status) VALUES ('meeting', '2025-06-01T12:00:00Z', 'manual')",
    "INSERT OR IGNORE INTO tasks (id, title) VALUES ('task', 'Task')",
    "INSERT OR IGNORE INTO insights (id, meeting_id, kind, text) VALUES ('insight', 'meeting', 'idea', 'Insight')",
    "INSERT OR IGNORE INTO email_accounts (mailbox) VALUES ('mail@example.test')",
    "INSERT OR IGNORE INTO email_messages (mailbox, id, thread_id, sent_at, direction, from_email) VALUES ('mail@example.test', 'message', 'thread', '2025-06-01', 'sent', 'mail@example.test')",
    "INSERT OR IGNORE INTO ai_columns (entity_type, field_key) VALUES ('contact', 'title')",
    "INSERT OR IGNORE INTO views (id, entity_type, name) VALUES ('view', 'contact', 'Fixture view')",
    "INSERT OR IGNORE INTO view_fields (view_id, field_key) VALUES ('view', 'email')",
  ].map((sql) => db.prepare(sql)));
  if (!await db.prepare("SELECT id FROM custom_field_defs WHERE id = 'custom'").first()) {
    await db.prepare("INSERT INTO custom_field_defs (id, entity_type, key, label, field_type) VALUES ('custom', 'contact', 'cf_s1', 'Custom', 'string')").run();
  }
  if (!(await db.prepare('PRAGMA table_info(contacts)').all()).results.some(({ name }) => name === 'cf_s1')) {
    await db.prepare('ALTER TABLE contacts ADD COLUMN cf_s1 TEXT').run();
  }
}

function operations(openapi) {
  assert.ok(Object.keys(openapi.paths).length > 0);
  const operations = Object.entries(openapi.paths).flatMap(([template, item]) => {
    let index = 0;
    const params = fixture[template] ?? [];
    const path = template.replace(/\{[^}]+\}/g, () => {
      const value = params[index++];
      assert.ok(value, `Create a record for the new parameter of ${template}`);
      return encodeURIComponent(value);
    });
    assert.equal(index, params.length, `Stale parameters for ${template}`);
    const methods = Object.keys(item).filter((method) => httpMethods.includes(method));
    if (methods.includes('get') && !methods.includes('head')) methods.push('head');
    return methods.map((method) => ({ template, path: path + (isRead(method.toUpperCase()) ? query[template] ?? '' : ''),
      method: method.toUpperCase() }));
  });
  return operations.sort((a, b) => Number(isRead(b.method)) - Number(isRead(a.method)));
}

scenario(7, 'first owner starts with no row, matches member app access, and writes people', async (app, t) => {
  assert.deepEqual(await rows(app.crmDb, 'wiser_people'), []);
  await seedRouteRecords(app.crmDb);
  const routes = operations(app.openapi);
  const statuses = async (token) => {
    const result = [];
    for (const { method, path } of routes) {
      const body = method === 'POST' && path === '/api/lookup'
        ? { addresses: [{ email: 'contact@example.test' }] }
        : ['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined;
      const response = await app.request(method, path, { token, body });
      assert.ok(response.status < 500 && response.status !== 401, `${method} ${path}: ${JSON.stringify(response.data)}`);
      result.push(`${method} ${path} ${response.status}`);
    }
    return result;
  };
  const ownerStatuses = await statuses(app.person);
  assert.deepEqual(await rows(app.crmDb, 'wiser_people'), []);
  await setRole(app, member, 'member');
  await seedRouteRecords(app.crmDb);
  assert.deepEqual(await statuses(await app.personFor(member)), ownerStatuses);
  t.diagnostic(`Compared ${routes.length} OpenAPI method and path pairs, including implicit HEAD requests.`);
});

scenario(8, 'viewer OpenAPI matrix matches member reads except three sync routes and refuses every write', async (app, t) => {
  await setRole(app, member, 'member');
  await setRole(app, viewer, 'viewer');
  await seedRouteRecords(app.crmDb);
  const memberToken = await app.personFor(member);
  const viewerToken = await app.personFor(viewer);
  const routes = operations(app.openapi);
  const encountered = new Set();
  for (const { template, method, path } of routes) {
    if (isRead(method)) {
      const comparison = await app.request(method, path, { token: memberToken });
      assert.ok(comparison.status < 500 && comparison.status !== 401, `Member ${method} ${path}: ${JSON.stringify(comparison.data)}`);
      if (!syncReads.has(template)) {
        assert.equal((await app.request(method, path, { token: viewerToken })).status, comparison.status, `${method} ${path}`);
        continue;
      }
      encountered.add(template);
      assert.equal(comparison.status, 200, `Member can read ${method} ${path}`);
    }
    await refused(app, viewerToken, method, path, 403, viewerError);
  }
  assert.deepEqual(encountered, syncReads);
  t.diagnostic(`Checked ${routes.length} OpenAPI method and path pairs, including implicit HEAD requests.`);
});

scenario(9, 'member and owner can both create the same contact data', async (app) => {
  await setRole(app, member, 'member');
  const token = await app.personFor(member);
  for (const credential of [app.person, token]) {
    const { contact } = await app.api('POST', '/api/contacts', 201, { token: credential, body: contactInput });
    for (const [key, value] of Object.entries(contactInput)) assert.equal(contact[key], value);
  }
  assert.equal((await rows(app.crmDb, 'contacts')).length, 2);
});

scenario(10, 'viewer cannot take in explicitly or on an HTML page open', async (app) => {
  await setRole(app, viewer, 'viewer');
  const token = await app.personFor(viewer);
  await refused(app, token, 'POST', takeIn, 403, viewerError);
  await pageDoesNotTakeIn(app, token, 200);
}, { intake: true });

scenario(12, 'decoded sync route and paths containing control characters are refused', async (app) => {
  await setRole(app, viewer, 'viewer');
  const token = await app.personFor(viewer);
  const encoded = '/api/contacts/contact/%65mails';
  assert.equal((await app.request('GET', encoded)).status, 200, 'owner reaches the encoded sync route');
  await refused(app, token, 'GET', encoded, 403, viewerError);
  for (const credential of [app.person, token, app.agent, await app.personFor(applicant)]) {
    for (const control of ['%00', '%0A', '%0D', '%1F', '%7F', '%E2%80%A8', '%E2%80%A9']) {
      await refused(app, credential, 'GET', '/api/contacts/contact/emails' + control, 400, 'This request path is invalid.');
    }
  }
  assert.equal((await rows(app.crmDb, 'wiser_people')).some(({ email }) => email === applicant), false);
});

scenario(13, 'member reads people and cannot PUT or DELETE', async (app) => {
  await setRole(app, member, 'member');
  const token = await app.personFor(member);
  const list = await app.api('GET', roster, 200, { token });
  assert.deepEqual(list.you, { email: member, role: 'member' });
  await refused(app, token, 'PUT', personPath(member), 403, peopleError, { body: { role: 'owner' } });
  await refused(app, token, 'DELETE', personPath(member), 403, peopleError);
  assert.deepEqual(await app.api('GET', roster, 200, { token }), list);
});

scenario(14, 'owner adds, changes and removes an account, immediately revoking app access', async (app) => {
  const token = await app.personFor(applicant);
  await waiting(app, token);
  await setRole(app, member, 'member');
  assert.equal((await app.api('GET', roster, 200)).people[1].added_by, owner);
  await app.api('DELETE', personPath(member), 204);
  await setRole(app, applicant, 'viewer');
  assert.equal((await app.api('GET', roster, 200, { token })).you.role, 'viewer');
  await setRole(app, applicant, 'member');
  assert.equal((await app.api('GET', roster, 200, { token })).you.role, 'member');
  await app.api('DELETE', personPath(applicant), 204);
  assert.deepEqual(await rows(app.crmDb, 'wiser_people'), []);
  await refused(app, token, 'GET', '/api/contacts');
});

scenario(15, 'first owner cannot be demoted, removed or duplicated by a stored row', async (app) => {
  await app.crmDb.prepare("INSERT INTO wiser_people (email, role, added_by) VALUES (?, 'viewer', ?)").bind(owner, owner).run();
  const address = personPath(owner.toUpperCase());
  for (const method of ['PUT', 'DELETE']) await refused(app, app.person, method, address, 403,
    'The first owner is set at install.', method === 'PUT' ? { body: { role: 'viewer' } } : {});
  assert.equal((await rows(app.crmDb, 'wiser_people'))[0].role, 'viewer');
  assert.deepEqual(await app.api('GET', roster, 200), {
    you: { email: owner, role: 'owner' }, people: [{ email: owner, role: 'owner', first_owner: true }],
  });
  await app.api('POST', '/api/contacts', 201, { body: contactInput });
  await setRole(app, member, 'member');
});

scenario(16, 'agent reads people and cannot PUT or DELETE', async (app) => {
  await setRole(app, member, 'member');
  const list = await app.api('GET', roster, 200, { token: app.agent });
  assert.equal(list.you, 'agent');
  await refused(app, app.agent, 'DELETE', personPath(member), 403, peopleError);
  await refused(app, app.agent, 'PUT', personPath(member), 403, peopleError, { body: { role: 'owner' } });
  assert.deepEqual(await app.api('GET', roster, 200, { token: app.agent }), list);
});

scenario(17, 'signed emails, owner setting and person writes compare lowercase', async (app) => {
  await setRole(app, member.toUpperCase(), 'member');
  const alternate = await app.personFor('mEmBeR@example.TEST');
  assert.deepEqual((await app.api('GET', roster, 200, { token: alternate })).you, { email: member, role: 'member' });
  assert.deepEqual((await app.api('GET', roster, 200, { token: await app.personFor(owner.toUpperCase()) })).you,
    { email: owner, role: 'owner' });
  assert.equal((await rows(app.crmDb, 'wiser_people'))[0].email, member);
}, { ...appOptions, ownerEmail: owner.toUpperCase() });

scenario(18, 'read-only refuses owner writes to people and to contacts', async (app) => {
  for (const [method, path, body] of [['PUT', personPath(member), { role: 'viewer' }],
    ['DELETE', personPath(member), undefined], ['POST', '/api/contacts', contactInput]]) {
    await refused(app, app.person, method, path, 503, 'The CRM is read-only during an upgrade.', { body });
  }
  assert.deepEqual(await rows(app.crmDb, 'wiser_people'), []);
  assert.deepEqual(await rows(app.crmDb, 'contacts'), []);
}, { ...appOptions, vars: { WISER_READ_ONLY: 'true' } });

for (const [label, ownerEmail] of [['missing', null], ['empty', ''], ['malformed', 'not-an-email']]) {
  scenario(20, `${label} owner setting refuses valid person and agent tokens`, async (app) => {
    for (const token of [app.person, app.agent]) {
      for (const path of ['/', '/api/wiser/instance', roster]) {
        await refused(app, token, 'GET', path, 503, 'This install has no owner configured.', { headers: browser });
      }
    }
    await refused(app, null, 'GET', '/', 401, 'Sign in to use Wiser CRM.');
  }, { production: true, ownerEmail, checkOpenapi: false });
}

test('people API orders the list, rejects invalid requests and caps even a chunked body', { timeout: 120_000 }, async (t) => {
  const app = await startApp(t);
  await waiting(app, await app.personFor('a@example.test'));
  await setRole(app, viewer, 'viewer');
  const list = await app.request('GET', roster);
  assert.equal(list.headers['cache-control'], 'no-store');
  assert.deepEqual(list.data.people.map(({ email, role, waiting, first_owner }) => ({ email, role, waiting, first_owner })), [
    { email: owner, role: 'owner', waiting: undefined, first_owner: true },
    { email: viewer, role: 'viewer', waiting: false, first_owner: undefined },
    { email: 'a@example.test', role: null, waiting: true, first_owner: undefined },
  ]);
  for (const email of ['no-at', 'two@@example.test', 'two names@example.test', 'x@ex,ample.test', 'x\u0080@example.test']) {
    await refused(app, app.person, 'PUT', personPath(email), 400, 'Enter one email address.', { body: { role: 'member' } });
  }
  const path = personPath(member);
  for (const body of [{}, { role: null }, { role: 'admin' }, { role: 'member', email: member }, ['owner']]) {
    await refused(app, app.person, 'PUT', path, 400, undefined, { body });
  }
  await refused(app, app.person, 'PUT', path, 415, undefined, { rawBody: '{"role":"member"}' });
  await refused(app, app.person, 'PUT', path, 400, undefined, {
    rawBody: '{"role":', headers: { 'Content-Type': 'application/json' },
  });
  await refused(app, app.person, 'PUT', path, 413, undefined, {
    rawBody: '{"role":"member"}' + ' '.repeat(1100),
    headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
  });
  await refused(app, app.person, 'DELETE', path, 400, undefined, { body: { role: 'viewer' } });
  assert.deepEqual(await app.api('GET', roster, 200), list.data);
});
