import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startApp } from './local-worker.mjs';

// Run against real build.mjs output, including both deterministic builds. The
// ordinary suite can run without paying for a fresh clean-checkout install.
for (const release of (process.env.WISER_TEST_RELEASES ?? '').split(',').filter(Boolean)) {
  test(`release manifest and embedded instance version: ${release}`, { timeout: 120_000 }, async t => {
    const manifest = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'));
    await t.test('manifest carries all five required variables and F1 remains 10', () => {
      assert.deepEqual(manifest.worker.vars_required, ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'AGENT_CLIENT_ID', 'WISER_INSTANCE', 'WISER_READ_ONLY']);
      assert.deepEqual(manifest.source.f1, { count: 10, limit: 10 });
      assert.deepEqual(manifest.checks, { lockfile: 'PASS', install_log: 'PASS', bundle_inputs: 'PASS' });
    });
    await t.test('built production Worker answers its release version for staff and agent', async () => {
      const app = await startApp(t, { release, vars: {
        ACCESS_TEAM_DOMAIN: 'https://local.cloudflareaccess.com', ACCESS_AUD: 'local', AGENT_CLIENT_ID: 'local-agent',
        WISER_INSTANCE: 'built-install', WISER_READ_ONLY: 'yes',
      } });
      for (const [token, caller] of [[app.person, 'user'], [app.agent, 'agent']]) {
        const response = await app.request('GET', '/api/wiser/instance', { token });
        assert.equal(response.status, 200);
        assert.deepEqual(response.data, { instance: 'built-install', version: manifest.version, caller, read_only: true });
      }
      assert.equal((await app.request('POST', '/api/contacts', { body: { first_name: 'Blocked' } })).status, 503);
      assert.equal((await app.request('GET', '/api/wiser/instance', { token: null })).status, 401);
    });
  });
}
