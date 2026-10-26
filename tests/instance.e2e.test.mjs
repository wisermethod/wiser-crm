import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './local-worker.mjs';

const readOnlyError = { error: 'The CRM is read-only during an upgrade.' };
async function instance(app, token, read_only, version = 'dev') {
  const response = await app.request('GET', '/api/wiser/instance', { token });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.data, { instance: 'test-install', version, caller: token === app.agent ? 'agent' : 'user', read_only });
}

test('instance and read-only policy through the real local Worker', { timeout: 120_000 }, async t => {
  const app = await startApp(t, { vars: { WISER_INSTANCE: 'test-install', WISER_READ_ONLY: 'true' } });
  await t.test('instance answers staff and agent with the verified caller', async () => {
    await instance(app, app.person, true);
    await instance(app, app.agent, true);
  });
  await t.test('instance refuses an absent or invalid credential', async () => {
    for (const token of [null, 'invalid']) {
      const response = await app.request('GET', '/api/wiser/instance', { token });
      assert.equal(response.status, 401);
      assert.deepEqual(response.data, { error: 'Sign in to use Wiser CRM.' });
    }
  });
  await t.test('writing methods and all writing GET/HEAD routes are refused for both callers', async () => {
    const paths = ['/api/stats', '/api/stages', '/api/deals', '/api/deals/board', '/api/deals/progress', '/api/deals/1',
      '/api/customers', '/api/lookup?email=person@example.test', '/api/email-sync', '/api/contacts/1/emails', '/api/meetings/sync', '/api/views?entity=contact'];
    for (const token of [app.person, app.agent]) {
      for (const [method, path] of [
        ['POST', '/api/contacts'], ['PATCH', '/api/contacts/1'], ['DELETE', '/api/contacts/1'],
        ...paths.flatMap(path => [['GET', path], ['HEAD', path]]), ['GET', '/api/email-%73ync?check=1'],
      ]) {
        const response = await app.request(method, path, { token, body: method === 'POST' ? { first_name: 'Blocked' } : undefined });
        assert.equal(response.status, 503, `${method} ${path}`);
        assert.equal(response.headers['cache-control'], 'no-store', `${method} ${path}: ${JSON.stringify(response.data)}`);
        if (method !== 'HEAD') assert.deepEqual(response.data, readOnlyError);
      }
    }
    assert.deepEqual((await app.api('GET', '/api/contacts', 200)).contacts, []);
    assert.equal((await app.request('HEAD', '/api/contacts')).status, 200);
    const index = await app.request('GET', '/');
    assert.equal(index.status, 200);
    const asset = /(?:src|href)="(\/assets\/[^\"]+)"/.exec(index.data)?.[1];
    assert.ok(asset, 'Built HTML must name a real static asset');
    assert.equal((await app.request('GET', asset)).status, 200);
    await instance(app, app.agent, true);
  });
  await t.test('every live upstream GET route is explicitly classified, with no stale entries', async () => {
    const { readGetRoutes, writingGetRoutes } = await import('../worker/get-routes.ts');
    const classified = [...readGetRoutes, ...Object.keys(writingGetRoutes)].sort();
    const actual = Object.entries(app.openapi.paths).filter(([, item]) => item.get).map(([path]) => path).sort();
    const unknown = actual.filter(path => !classified.includes(path));
    assert.deepEqual(unknown, [], `Unclassified upstream GET routes: ${unknown.join(', ')}`);
    assert.deepEqual(classified, actual, 'GET classification contains missing or duplicate routes');
  });
});

for (const flag of ['', 'false', 'yes']) {
  test(`local Worker switch ${JSON.stringify(flag)}`, { timeout: 120_000 }, async t => {
    const app = await startApp(t, { vars: { WISER_INSTANCE: 'test-install', WISER_READ_ONLY: flag } });
    const readOnly = flag === 'yes';
    await instance(app, app.agent, readOnly);
    const response = await app.request('POST', '/api/contacts', { body: { first_name: 'Allowed', email: 'allowed@example.test' } });
    assert.equal(response.status, readOnly ? 503 : 201);
    assert.equal((await app.request('GET', '/api/email-sync')).status, readOnly ? 503 : 200);
  });
}
test('local Worker instance is 503 without a name', { timeout: 120_000 }, async t => {
  const app = await startApp(t);
  const response = await app.request('GET', '/api/wiser/instance');
  assert.equal(response.status, 503);
  assert.deepEqual(response.data, { error: 'This install has no instance name.' });
});
