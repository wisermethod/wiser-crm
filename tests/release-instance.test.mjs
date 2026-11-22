import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRelease } from '../release/sign.mjs';
import { format2Fixture, format3Fixture, publishedVariables } from './fixtures/release-manifests.mjs';
import { startApp } from './local-worker.mjs';

const { 'wiser-crm': legacyCrm, 'wiser-crm-intake': legacyIntake } = publishedVariables;
const currentCrm = { required: [...legacyCrm.required, 'OWNER_EMAIL'], optional: ['BRAND_NAME', 'BRAND_ACCENT'] };
const currentIntake = { required: legacyIntake.required, optional: [...legacyIntake.optional, 'NOTICE_FROM_NAME'] };

test('the format 2 manifest and the published 0.2.0 format 3 set still verify', t => {
  const format2 = format2Fixture(t);
  assert.deepEqual(checkRelease(format2.release).manifest.worker.vars_required, legacyCrm.required);
  const format3 = format3Fixture(t);
  const { apps } = checkRelease(format3.release).manifest;
  assert.deepEqual(apps['wiser-crm'].vars, legacyCrm);
  assert.deepEqual(apps['wiser-crm-intake'].vars, legacyIntake);
});

// Run against real build.mjs output, including both deterministic builds.
for (const release of (process.env.WISER_TEST_RELEASES ?? '').split(',').filter(Boolean)) {
  test(`release manifest and embedded instance version: ${release}`, { timeout: 120_000 }, async t => {
    const { manifest } = checkRelease(release);
    await t.test('manifest requires OWNER_EMAIL only for the CRM and F1 remains 10', () => {
      assert.equal(manifest.format, 3);
      assert.deepEqual(manifest.apps['wiser-crm'].vars, currentCrm);
      assert.deepEqual(manifest.apps['wiser-crm-intake'].vars, currentIntake);
      assert.deepEqual(manifest.source.f1, { count: 10, limit: 10 });
      assert.deepEqual(manifest.checks, { lockfile: 'PASS', install_log: 'PASS', bundle_inputs: 'PASS' });
    });
    await t.test('built production Worker answers its release version for staff and agent', async () => {
      const app = await startApp(t, { release, ownerEmail: 'person@example.test', vars: {
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
