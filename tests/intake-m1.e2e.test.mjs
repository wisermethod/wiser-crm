import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import intakeWorker from '../intake/worker.ts';
import { takeIn } from '../worker/take-in.ts';
import { startApp } from './local-worker.mjs';

const origin = 'https://example.com';
const returnUrl = origin + '/thanks';
const contentType = 'application/x-www-form-urlencoded';
const route = '/api/wiser/intake/take-in';
const visitor = {
  first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test',
  company: 'Analytical Engine', phone: '1234', message: 'Enquiry for Milestone 1.',
};
const cleared = Object.fromEntries(Object.keys(visitor).map((field) => [field, null]));
const address = '192.0.2.30';
const hour = 60 * 60 * 1000;
const day = 24 * hour;

const headers = (ip) => ({
  Origin: origin, 'Content-Type': contentType, Referer: origin + '/contact?private=1',
  ...(ip === undefined ? {} : { 'CF-Connecting-IP': ip }),
});
const form = (data) => new URLSearchParams({ ...visitor, ...data });
const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
const addressHash = (salt) => createHash('sha256').update(`${salt}:${address}`).digest('hex');

async function clear(db) {
  await db.batch(['submissions', 'throttle', 'throttle_salts'].map((table) => db.prepare(`DELETE FROM ${table}`)));
}

function assertThrottled(response) {
  assert.equal(response.status, 429);
  assert.match(response.headers['content-type'], /^text\/plain/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(typeof response.data, 'string');
}

test('the intake config declares only its database and a single pinned structured mail binding', async () => {
  const config = JSON.parse(await readFile(new URL('../intake/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.send_email, [{ name: 'NOTICE', destination_address: config.vars.NOTICE_TO }]);
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ['INTAKE_DB']);
  assert.equal(config.assets, undefined);
  assert.equal(String(config.vars.INTAKE_MAX_PER_ADDRESS_PER_DAY), '5');
  assert.equal(String(config.vars.INTAKE_MAX_PER_HOUR), '60');
  for (const key of ['INTAKE_ORIGIN', 'INTAKE_RETURN_URL', 'CRM_URL']) {
    assert.match(config.vars[key], /^https:\/\/([\w-]+\.)?example\.com(?:\/|$)/);
  }
  for (const key of ['NOTICE_FROM', 'NOTICE_TO']) assert.match(config.vars[key], /@example\.com$/);
});

test('Milestone 1 intake and retention through both real local Workers', { timeout: 120_000 }, async (t) => {
  const app = await startApp(t, { intake: true });
  const { crmDb, intakeDb } = app;
  const submissions = () => rows(intakeDb, 'submissions');
  const run = () => app.api('POST', route, 200, { token: app.agent });
  const post = (ip, data) => app.intakeRequest('POST', '/submit', {
    headers: headers(ip), body: form(data).toString(),
  });

  async function scenario(name, fn) {
    await t.test(name, async (subtest) => {
      await clear(intakeDb);
      await crmDb.batch(['activities', 'contacts'].map((table) => crmDb.prepare(`DELETE FROM ${table}`)));
      await fn(subtest);
    });
  }

  await scenario('a populated honeypot is indistinguishable from success and uses no throttle slots', async () => {
    const bot = await post(address, { website: 'filled' });
    assert.equal(bot.status, 303);
    assert.deepEqual(await submissions(), []);
    assert.deepEqual(await rows(intakeDb, 'throttle'), []);
    assert.deepEqual(await rows(intakeDb, 'throttle_salts'), []);
    const real = await post(address, { website: '' });
    assert.equal(real.status, 303);
    assert.equal(bot.headers.location, real.headers.location);
    assert.equal(bot.headers['cache-control'], real.headers['cache-control']);
    assert.equal(bot.data, real.data);
    assert.equal((await submissions()).length, 1);
  });

  await scenario('only five posts from an address are saved per UTC day, even under concurrency', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => post(address)));
    assert.equal(responses.filter(({ status }) => status === 303).length, 5);
    assert.equal(responses.filter(({ status }) => status === 429).length, 1);
    assertThrottled(responses.find(({ status }) => status === 429));
    assert.equal((await submissions()).length, 5);
    const buckets = await rows(intakeDb, 'throttle');
    const salts = await rows(intakeDb, 'throttle_salts');
    assert.equal(salts.length, 1);
    assert.equal(buckets.length, 2);
    const ipBucket = buckets.find(({ key }) => /^[0-9a-f]{64}$/.test(key));
    assert.ok(ipBucket);
    assert.equal(ipBucket.key, addressHash(salts[0].salt));
    assert.ok(!JSON.stringify(buckets).includes(address));
    assert.equal(ipBucket.count, 5);
    assert.ok(buckets.every(({ count }) => count === 5));
    assert.equal(ipBucket.window_ends_at, salts[0].window_ends_at);
    assert.equal((await post('192.0.2.31')).status, 303);
  });

  await scenario('the default hourly cap applies across addresses and expired hours are removed by the next post', async () => {
    for (let number = 1; number <= 60; number++) {
      assert.equal((await post(`198.51.100.${number}`)).status, 303);
    }
    assertThrottled(await post('198.51.100.61'));
    assert.equal((await submissions()).length, 60);
    await intakeDb.prepare('UPDATE throttle SET window_ends_at = ? WHERE count = 60').bind(Date.now() - hour).run();
    assert.equal((await post('198.51.100.61')).status, 303);
    assert.equal((await submissions()).length, 61);
    assert.equal((await rows(intakeDb, 'throttle')).some(({ count }) => count === 60), false);
  });

  await scenario('missing network addresses share one bucket', async () => {
    for (let number = 0; number < 5; number++) assert.equal((await post()).status, 303);
    assertThrottled(await post());
    assert.equal((await submissions()).length, 5);
  });

  await scenario('a new UTC day resets the address cap and rotates and deletes the stored salt and hash', async (subtest) => {
    const before = Date.parse('2026-11-20T23:59:59Z');
    subtest.mock.timers.enable({ apis: ['Date'], now: before });
    const env = { INTAKE_DB: intakeDb, INTAKE_ORIGIN: origin, INTAKE_RETURN_URL: returnUrl };
    const submit = () => intakeWorker.fetch(new Request(origin + '/submit', {
      method: 'POST', headers: headers(address), body: form().toString(),
    }), env);
    for (let number = 0; number < 5; number++) assert.equal((await submit()).status, 303);
    assert.equal((await submit()).status, 429);
    const [oldSalt] = await rows(intakeDb, 'throttle_salts');
    const oldBucket = (await rows(intakeDb, 'throttle')).find(({ key }) => /^[0-9a-f]{64}$/.test(key));
    const midnight = before + 1000;
    assert.equal(oldSalt.window_ends_at, midnight);
    assert.equal(oldBucket.window_ends_at, midnight);
    subtest.mock.timers.setTime(midnight);
    assert.equal((await submit()).status, 303);
    const salts = await rows(intakeDb, 'throttle_salts');
    const buckets = await rows(intakeDb, 'throttle');
    assert.equal(salts.length, 1);
    assert.equal(buckets.length, 2);
    assert.notEqual(salts[0].salt, oldSalt.salt);
    assert.ok(buckets.some(({ key }) => key === addressHash(salts[0].salt)));
    assert.equal(salts[0].window_ends_at, midnight + day);
    assert.ok(buckets.every(({ key, count, window_ends_at }) => key !== oldBucket.key && count === 1 && window_ends_at > midnight));
    assert.equal((await submissions()).length, 6);
  });

  await scenario('a post with no mail binding saves a none outcome', async () => {
    assert.equal((await post(address)).status, 303);
    const [saved] = await submissions();
    assert.equal(saved.notice_outcome, 'none');
  });

  await scenario('take-in adds the failed notice line and leaves only receipt metadata after erasure', async () => {
    assert.equal((await post(address)).status, 303);
    const [saved] = await submissions();
    await intakeDb.prepare('UPDATE submissions SET notice_outcome = ? WHERE id = ?').bind('failed:E_TEST_SEND', saved.id).run();
    assert.deepEqual(await run(), { taken_in: 1, failed: 0, remaining: 0 });
    const [note] = await rows(crmDb, 'activities');
    const [contact] = await rows(crmDb, 'contacts');
    const [receipt] = await submissions();
    assert.equal(note.body, `${visitor.message}\n\nCompany: ${visitor.company}\nPhone: ${visitor.phone}\nPage: /contact\nEmail notice was not sent (E_TEST_SEND).`);
    assert.equal(note.entity_id, contact.id);
    assert.ok(receipt.claimed_at);
    assert.ok(receipt.taken_in_at);
    assert.deepEqual(receipt, {
      id: saved.id, received_at: saved.received_at, page: '/contact', ...cleared,
      claimed_at: receipt.claimed_at, claim_id: null, taken_in_at: receipt.taken_in_at,
      contact_id: contact.id, notice_outcome: 'failed:E_TEST_SEND',
    });
  });

  await scenario('the next form post nulls every visitor field and clears stale claims on 31-day-old rows', async () => {
    assert.equal((await post(address)).status, 303);
    const [saved] = await submissions();
    await intakeDb.prepare("UPDATE submissions SET received_at = datetime('now', '-31 days'), claim_id = 'old-claim'").run();
    assert.equal((await post(address)).status, 303);
    const [old, fresh] = await submissions();
    assert.deepEqual(old, {
      id: saved.id, received_at: old.received_at, page: saved.page, ...cleared,
      claimed_at: null, claim_id: null, taken_in_at: null, contact_id: null, notice_outcome: 'none',
    });
    assert.equal(fresh.message, visitor.message);
  });

  await scenario('the next take-in nulls a 31-day-old untaken submission', async () => {
    assert.equal((await post(address)).status, 303);
    await intakeDb.prepare("UPDATE submissions SET received_at = datetime('now', '-31 days')").run();
    assert.deepEqual(await run(), { taken_in: 0, failed: 0, remaining: 0 });
    const [old] = await submissions();
    assert.deepEqual(Object.fromEntries(Object.keys(visitor).map((key) => [key, old[key]])), cleared);
    assert.equal(old.taken_in_at, null);
    assert.deepEqual(await rows(crmDb, 'contacts'), []);
  });

  await scenario('take-in removes ended throttle windows and salts while keeping active ones', async () => {
    assert.equal((await post(address)).status, 303);
    const expired = Date.now() - day;
    await intakeDb.batch([
      intakeDb.prepare('INSERT INTO throttle (key, window_ends_at, count) VALUES (?, ?, ?)').bind('expired-key', expired, 1),
      intakeDb.prepare('INSERT INTO throttle_salts (window_ends_at, salt) VALUES (?, ?)').bind(expired, 'expired-salt'),
    ]);
    assert.deepEqual(await run(), { taken_in: 1, failed: 0, remaining: 0 });
    const buckets = await rows(intakeDb, 'throttle');
    assert.equal(buckets.length, 2);
    assert.ok(buckets.every(({ window_ends_at }) => window_ends_at > expired));
    const salts = await rows(intakeDb, 'throttle_salts');
    assert.equal(salts.length, 1);
    assert.ok(salts[0].window_ends_at > expired);
  });

  await scenario('each take-in processes at most 50 leads, oldest first', async () => {
    await intakeDb.prepare(`
      WITH RECURSIVE sequence(number) AS (
        VALUES (1) UNION ALL SELECT number + 1 FROM sequence WHERE number < 51
      )
      INSERT INTO submissions (id, received_at, page, first_name, last_name, email, company, phone, message, notice_outcome)
      SELECT printf('lead-%02d', number), datetime('now', '-2 hours', '+' || number || ' seconds'),
        '/contact', 'Ada', 'Lovelace', 'ada@example.test', '', '', 'Message ' || number, 'none'
      FROM sequence
    `).run();
    assert.deepEqual(await run(), { taken_in: 50, failed: 0, remaining: 1 });
    const queued = (await submissions()).filter(({ taken_in_at }) => taken_in_at === null);
    assert.deepEqual(queued.map(({ id }) => id), ['lead-51']);
    assert.equal((await rows(crmDb, 'activities')).length, 50);
    assert.deepEqual(await run(), { taken_in: 1, failed: 0, remaining: 0 });
    assert.equal((await rows(crmDb, 'activities')).length, 51);
    assert.equal((await rows(crmDb, 'contacts')).length, 1);
  });

  await scenario('take-in waits for the notice outcome and then takes a failed send or an abandoned save', async () => {
    assert.equal((await post(address)).status, 303);
    const [saved] = await submissions();
    const received = new Date(saved.received_at).getTime();
    await intakeDb.prepare('UPDATE submissions SET notice_outcome = NULL').run();
    assert.deepEqual(await takeIn(crmDb, intakeDb, () => new Date(received + 2000)), { taken_in: 0, failed: 0, remaining: 1 });
    assert.deepEqual(await rows(crmDb, 'activities'), []);
    await intakeDb.prepare("UPDATE submissions SET notice_outcome = 'failed:E_TEST_SEND'").run();
    assert.deepEqual(await takeIn(crmDb, intakeDb, () => new Date(received + 3000)), { taken_in: 1, failed: 0, remaining: 0 });
    const [note] = await rows(crmDb, 'activities');
    assert.match(note.body, /Email notice was not sent \(E_TEST_SEND\)\.$/);

    assert.equal((await post(address)).status, 303);
    const [, abandoned] = await submissions();
    await intakeDb.prepare('UPDATE submissions SET notice_outcome = NULL WHERE id = ?').bind(abandoned.id).run();
    const later = new Date(Date.parse(abandoned.received_at) + 11 * 60_000);
    assert.deepEqual(await takeIn(crmDb, intakeDb, () => later), { taken_in: 1, failed: 0, remaining: 0 });
    assert.equal((await submissions())[1].notice_outcome, null);
  });
});

test('both intake throttle caps are configurable on the real Worker', { timeout: 120_000 }, async (t) => {
  const app = await startApp(t, { intake: true, intakeVars: {
    INTAKE_MAX_PER_ADDRESS_PER_DAY: '1', INTAKE_MAX_PER_HOUR: '2',
  } });
  const post = (ip) => app.intakeRequest('POST', '/submit', { headers: headers(ip), body: form().toString() });
  assert.equal((await post(address)).status, 303);
  assertThrottled(await post(address));
  assert.equal((await post('192.0.2.31')).status, 303);
  assertThrottled(await post('192.0.2.32'));
  assert.equal((await rows(app.intakeDb, 'submissions')).length, 2);
});
