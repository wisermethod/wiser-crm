import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The published 0.2.0 variable declarations were transcribed from FORMAT.md
// before the 0.3.0 changes, independently of the builder and signer's lists.
export const publishedVariables = JSON.parse(fs.readFileSync(new URL('./release-0.2.0-vars.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, null, 2) + '\n';

export function format2Fixture(t, version = '0.1.0') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiser-crm-sign-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const release = path.join(base, 'wiser-crm', version);
  const files = path.join(release, 'files');
  fs.mkdirSync(files, { recursive: true });
  function record(bytes) {
    const sha256 = hash(bytes);
    fs.writeFileSync(path.join(files, sha256), bytes);
    return { sha256, size: Buffer.byteLength(bytes) };
  }
  const shared = record('export default {};\n');
  const manifest = {
    format: 2, app: 'wiser-crm', version, created: '2026-10-30T12:00:00.000Z',
    source: { repository: 'wisermethod/wiser-crm', commit: 'a'.repeat(40), upstream_commit: 'b'.repeat(40), f1: { count: 10, limit: 10 } },
    checks: { lockfile: 'PASS', install_log: 'PASS', bundle_inputs: 'PASS' },
    worker: { main_module: 'index.js', compatibility_date: '2025-04-01', compatibility_flags: ['nodejs_compat'], d1_binding: 'DB', assets_binding: 'ASSETS', vars_required: ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'AGENT_CLIENT_ID', 'WISER_INSTANCE', 'WISER_READ_ONLY'], modules: [
      { name: 'data.bin', type: 'application/octet-stream', ...record(Buffer.from([0, 1, 255])) },
      { name: 'index.js', type: 'application/javascript+module', ...shared },
    ] },
    assets: { config: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: true }, files: [
      { path: '/app.js', ...shared, content_type: 'application/javascript' },
      { path: '/index.html', ...record('<h1>fixture</h1>\n'), content_type: 'text/html; charset=utf-8' },
    ] },
    migrations: { table: 'd1_migrations', files: [{ name: '0001_baseline.sql', ...record('SELECT 1;\n') }] },
  };
  const manifestFile = path.join(release, 'manifest.json');
  const save = () => fs.writeFileSync(manifestFile, canonical(manifest));
  save();
  return { base, release, files, manifestFile, manifest, save, record };
}

export function format3Fixture(t, version = '0.2.0') {
  const f = format2Fixture(t, version);
  const { worker, assets, migrations, ...common } = f.manifest;
  const { d1_binding, assets_binding, vars_required: _varsRequired, modules, ...workerSettings } = worker;
  const crm = {
    worker: { ...workerSettings, modules },
    assets: { binding: assets_binding, ...assets },
    bindings: { d1: [{ name: d1_binding, database: 'crm' }, { name: 'INTAKE_DB', database: 'intake' }], mail: [] },
    vars: structuredClone(publishedVariables['wiser-crm']),
    migrations: { database: 'crm', ...migrations },
  };
  const intake = {
    worker: {
      main_module: 'worker.js', compatibility_date: '2025-04-01', compatibility_flags: [],
      modules: [{ name: 'worker.js', type: 'application/javascript+module', ...f.record('// worker.ts\nexport default {};\n') }],
      bundle_inputs: ['intake/worker.ts'],
    },
    assets: null,
    bindings: {
      d1: [{ name: 'INTAKE_DB', database: 'intake' }],
      mail: [{ name: 'NOTICE', destination_var: 'NOTICE_TO', sender_var: 'NOTICE_FROM' }],
    },
    vars: structuredClone(publishedVariables['wiser-crm-intake']),
    migrations: { database: 'intake', table: 'd1_migrations', files: [{ name: '0001_intake.sql', ...f.record('SELECT 2;\n') }] },
  };
  const manifest = { ...common, format: 3, apps: { 'wiser-crm': crm, 'wiser-crm-intake': intake } };
  const save = () => fs.writeFileSync(f.manifestFile, canonical(manifest));
  save();
  return { ...f, manifest, crm, intake, save };
}
