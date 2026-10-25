import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair } from 'jose';
import { startApp } from './local-worker.mjs';

test('pass-list sign-in cases through the real local Worker', { timeout: 120_000 }, async (t) => {
  const app = await startApp(t);
  async function refused(method, path, status, options) {
    const response = await app.request(method, path, options);
    assert.equal(response.status, status, `${method} ${path}: expected ${status}, got ${response.status}; body ${JSON.stringify(response.data)}`);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(response.data), ['error']);
    assert.equal(typeof response.data.error, 'string');
    t.diagnostic(`${method} ${path}: ${response.status}`);
    return response.data;
  }
  for (const path of ['/', '/api/contacts', '/llms.txt', '/contacts/1']) {
    await t.test(`case 1: GET ${path} without a token is 401 from the wrapper`, async () => {
      const result = await refused('GET', path, 401, { token: null });
      assert.equal(result.error, 'Sign in to use Wiser CRM.');
    });
  }
  await t.test('cases 2 and 5: forged X-Clawnify-User-Id is 403 with no token, a person token or an agent token', async () => {
    for (const token of [null, app.person, app.agent]) {
      await refused('GET', '/api/contacts', 403, { token, headers: { 'X-Clawnify-User-Id': 'forged' } });
    }
  });
  await t.test('case 3: GET contacts with an untrusted signing key is 401', async () => {
    const other = await generateKeyPair('RS256');
    // Reuse the trusted kid, so signature verification itself must fail.
    await refused('GET', '/api/contacts', 401, { token: await app.mint({}, other.privateKey) });
  });
  await t.test('case 3: GET contacts with an expired token is 401', async () => {
    await refused('GET', '/api/contacts', 401, { token: await app.mint({ exp: Math.floor(Date.now() / 1000) - 60 }) });
  });
  await t.test('case 3: GET contacts with another audience is 401', async () => {
    await refused('GET', '/api/contacts', 401, { token: await app.mint({ aud: 'another-application' }) });
  });
  await t.test('case 3: GET contacts with another issuer is 401', async () => {
    // A trusted signing key isolates the issuer check from the signature check.
    await refused('GET', '/api/contacts', 401, { token: await app.mint({ iss: 'https://another.cloudflareaccess.com' }) });
  });
  for (const path of ['/api/email-sync/run', '/api/ai-columns/run', '/api/meetings/run', '/api/email-sync/%72un']) {
    await t.test(`case 1: unsigned POST ${path} is 401 from the wrapper`, async () => {
      const result = await refused('POST', path, 401, { token: null });
      assert.equal(result.error, 'Sign in to use Wiser CRM.');
    });
    await t.test(`case 4: POST ${path} is 403 for person and agent`, async () => {
      for (const token of [app.person, app.agent]) {
        const result = await refused('POST', path, 403, { token });
        assert.equal(result.error, 'Public job runs are not available in Wiser CRM.');
      }
    });
  }
  await t.test('case 5: agent GET contacts with Cf-Access-Authenticated-User-Email is 403', async () => {
    await refused('GET', '/api/contacts', 403, {
      token: app.agent, headers: { 'Cf-Access-Authenticated-User-Email': 'forged@example.test' },
    });
  });
  await t.test('case 6: person and agent GET contacts are 200', async () => {
    for (const token of [app.person, app.agent]) {
      const listed = await app.api('GET', '/api/contacts', 200, { token });
      assert.deepEqual(listed.contacts, []);
      assert.equal(listed.total, 0);
    }
  });
  // Pass-list case 10, an address Access does not cover reaching the wrapper
  // without a credential, is worker/sign-in.test.ts's workers.dev case.
  await t.test('local entry refuses a non-local Host with no token, 403', async () => {
    // TCP still goes only to 127.0.0.1. The Host makes the Worker's URL non-local.
    for (const path of ['/', '/api/contacts', '/llms.txt', '/contacts/1']) {
      const result = await refused('GET', path, 403, { token: null, headers: { Host: 'outside.example.test' } });
      assert.equal(result.error, 'Local development is disabled.');
    }
  });
  for (const [method, path] of [['POST', '/api/integrations/email'], ['PUT', '/api/email-sync'], ['GET', '/api/email-sync/labels']]) {
    await t.test(`case 11: ${method} ${path} is 409 for person and agent`, async () => {
      for (const token of [app.person, app.agent]) {
        const result = await refused(method, path, 409, { token });
        assert.equal(result.error, 'This feature is not available in Wiser CRM.');
      }
    });
  }
});
