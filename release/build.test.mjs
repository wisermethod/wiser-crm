import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { argumentsFor, assemble, checkCommand, moduleType, noScopeRegistry, readConfig, runChecks, sha256 } from './build.mjs';

const repo = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const commit = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const builder = fileURLToPath(new URL('./build.mjs', import.meta.url));
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiser-crm-build-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (name, bytes) => {
    const file = path.join(base, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  return { base, write, args: ['--commit', commit, '--version', '0.1.0', '--out', path.join(base, 'out'), '--f1-limit', '10'] };
}

for (const version of ['01.0.0', '1.01.0', '1.0.01', '1.0', '1.0.0-beta', 'v1.0.0', '../bad']) {
  test(`refuses version ${version}`, t => {
    const f = fixture(t); f.args[3] = version;
    assert.throws(() => argumentsFor(f.args, repo), /--version/);
    assert.equal(fs.existsSync(path.join(f.base, 'out')), false);
  });
}
test('refuses repository and symlinked repository destinations', t => {
  const f = fixture(t);
  for (const out of [repo, path.join(repo, 'dist', 'release')]) {
    f.args[5] = out;
    assert.throws(() => argumentsFor(f.args, repo), /outside the repository/);
  }
  fs.symlinkSync(repo, path.join(f.base, 'alias'));
  f.args[5] = path.join(f.base, 'alias', 'new-out');
  assert.throws(() => argumentsFor(f.args, repo), /outside the repository/);
});
test('refuses an existing release without changing it', t => {
  const f = fixture(t);
  const marker = f.write('out/wiser-crm/0.1.0/keep', 'untouched');
  assert.throws(() => argumentsFor(f.args, repo), /already exists/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'untouched');
});
test('refuses an unknown commit and malformed commit with CLI exit 1', t => {
  const f = fixture(t);
  for (const bad of ['0'.repeat(40), 'HEAD', 'bad', '-x']) {
    f.args[1] = bad;
    const result = spawnSync(process.execPath, [builder, ...f.args], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(f.base, 'out')), false);
  }
});
test('requires absolute output, all flags, safe limit and no unknown or repeated flags', t => {
  const f = fixture(t);
  for (const args of [[], [...f.args, '--unknown', 'x'], [...f.args, '--out', f.base], f.args.slice(0, -1), f.args.slice(0, -2), f.args.map(x => x === '10' ? '-1' : x), f.args.map(x => x === '10' ? '1.5' : x), f.args.map(x => x === '10' ? '9007199254740992' : x)]) assert.throws(() => argumentsFor(args, repo));
  f.args[5] = 'relative';
  assert.throws(() => argumentsFor(f.args, repo), /absolute/);
});
test('accepts a held commit and a new absolute release destination', t => {
  const f = fixture(t), parsed = argumentsFor(f.args, repo);
  assert.equal(parsed.commit, commit);
  assert.equal(parsed.f1Limit, 10);
  assert.equal(parsed.release, path.join(f.base, 'out/wiser-crm/0.1.0'));
  assert.equal(fs.existsSync(parsed.release), false);
});

function assemblyFixture(t) {
  const f = fixture(t);
  f.write('worker/index.js', 'export default {};\n');
  f.write('worker/data.bin', Buffer.from([0, 1, 255]));
  f.write('worker/README.md', 'Wrangler evidence');
  f.write('worker/index.js.map', '{}');
  f.write('worker/meta.json', '{}');
  f.write('assets/index.html', '<h1>fixture</h1>\n');
  f.write('assets/assets/app.js', 'export default {};\n'); // Cross-category dedup.
  f.write('migrations/0010_later.sql', 'SELECT 10;\n');
  f.write('migrations/0002_next.sql', 'SELECT 2;\n');
  f.write('migrations/README.md', 'Migration instructions\n');
  f.write('migrations/adopt.mjs', '// adoption helper\n');
  const options = { release: path.join(f.base, 'out/wiser-crm/0.1.0'), version: '0.1.0', created: '2026-10-25T12:00:00.000Z', source: { repository: 'wisermethod/wiser-crm', commit: 'a'.repeat(40), upstream_commit: 'b'.repeat(40), f1: { count: 10, limit: 10 } }, checks: { lockfile: 'PASS', install_log: 'PASS', bundle_inputs: 'PASS' }, config: { main: 'worker/index.ts', compatibility_date: '2025-04-01', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB' }], assets: { binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true }, vars: { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', AGENT_CLIENT_ID: '' } }, workerDir: path.join(f.base, 'worker'), mainModule: 'index.js', assetsDir: path.join(f.base, 'assets'), migrationsDir: path.join(f.base, 'migrations'), table: 'd1_migrations' };
  return { ...f, options };
}

test('fixture matches FORMAT.md field for field, key order, exact bytes, hashes and sizes', t => {
  const f = assemblyFixture(t), result = assemble(f.options);
  const ref = (name, text) => ({ name, sha256: sha256(Buffer.from(text)), size: Buffer.byteLength(text) });
  const module = (name, type, text) => { const { sha256, size } = ref(name, text); return { name, type, sha256, size }; };
  const asset = (name, content_type, text) => { const { sha256, size } = ref(name, text); return { path: name, sha256, size, content_type }; };
  const expected = {
    format: 2, app: 'wiser-crm', version: '0.1.0', created: '2026-10-25T12:00:00.000Z',
    source: { repository: 'wisermethod/wiser-crm', commit: 'a'.repeat(40), upstream_commit: 'b'.repeat(40), f1: { count: 10, limit: 10 } },
    checks: { lockfile: 'PASS', install_log: 'PASS', bundle_inputs: 'PASS' },
    worker: { main_module: 'index.js', compatibility_date: '2025-04-01', compatibility_flags: ['nodejs_compat'], d1_binding: 'DB', assets_binding: 'ASSETS', vars_required: ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'AGENT_CLIENT_ID'], modules: [module('data.bin', 'application/octet-stream', Buffer.from([0, 1, 255])), module('index.js', 'application/javascript+module', 'export default {};\n')] },
    assets: { config: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: true }, files: [asset('/assets/app.js', 'application/javascript', 'export default {};\n'), asset('/index.html', 'text/html; charset=utf-8', '<h1>fixture</h1>\n')] },
    migrations: { table: 'd1_migrations', files: [ref('0002_next.sql', 'SELECT 2;\n'), ref('0010_later.sql', 'SELECT 10;\n')] },
  };
  const actualBytes = fs.readFileSync(path.join(f.options.release, 'manifest.json'));
  assert.equal(actualBytes.toString(), JSON.stringify(expected, null, 2) + '\n');
  assert.equal(result.manifest_sha256, sha256(actualBytes));
  assert.deepEqual(fs.readdirSync(f.options.release).sort(), ['files', 'manifest.json']);
  const records = [...expected.worker.modules, ...expected.assets.files, ...expected.migrations.files];
  const hashes = [...new Set(records.map(file => file.sha256))].sort();
  assert.deepEqual(fs.readdirSync(path.join(f.options.release, 'files')).sort(), hashes);
  for (const file of records) {
    const bytes = fs.readFileSync(path.join(f.options.release, 'files', file.sha256));
    assert.equal(sha256(bytes), file.sha256);
    assert.equal(bytes.length, file.size);
  }
  assert.equal(result.file_count, hashes.length);
  assert.equal(result.total_bytes, hashes.reduce((n, hash) => n + fs.statSync(path.join(f.options.release, 'files', hash)).size, 0));
});

test('a fake failing check blocks assembly and every subsequent check', t => {
  const f = assemblyFixture(t);
  const fake = f.write('fake-check.mjs', "console.log('LOCKFILE: FAIL'); process.exitCode = 1;\n");
  let called = false;
  assert.throws(() => runChecks({ lockfile: () => checkCommand(process.execPath, [fake], { cwd: f.base, env: process.env, log: path.join(f.base, 'fake.log') }, 'LOCKFILE'), install_log: () => { called = true; }, bundle_inputs: () => { called = true; } }, checks => { called = true; return assemble({ ...f.options, checks }); }), /LOCKFILE: FAIL/);
  assert.equal(called, false);
  assert.equal(fs.existsSync(f.options.release), false);
  assert.match(fs.readFileSync(path.join(f.base, 'fake.log'), 'utf8'), /LOCKFILE: FAIL/);
});
test('an exit-zero fake without PASS and every non-PASS verdict block assembly', t => {
  const f = assemblyFixture(t), fake = f.write('fake-check.mjs', "console.log('LOCKFILE: FAIL');\n");
  assert.throws(() => checkCommand(process.execPath, [fake], { cwd: f.base, env: process.env, log: path.join(f.base, 'fake.log') }, 'LOCKFILE'), /no PASS verdict/);
  for (const name of ['lockfile', 'install_log', 'bundle_inputs']) for (const verdict of ['FAIL', 'SKIP', undefined]) {
    const checks = { ...f.options.checks, [name]: verdict };
    assert.throws(() => assemble({ ...f.options, checks }), /must be PASS/);
    assert.equal(fs.existsSync(f.options.release), false);
  }
});
test('F1 overflow, unknown module type, missing main and symlink inputs leave no release', t => {
  const f = assemblyFixture(t);
  assert.throws(() => assemble({ ...f.options, source: { ...f.options.source, f1: { count: 11, limit: 10 } } }), /F1/);
  assert.throws(() => assemble({ ...f.options, mainModule: 'missing.js' }), /main module missing/);
  assert.throws(() => moduleType('unexpected.ext'), /unknown emitted/);
  fs.symlinkSync(path.join(f.base, 'assets/index.html'), path.join(f.base, 'worker/link.js'));
  assert.throws(() => assemble(f.options), /nonregular/);
  assert.equal(fs.existsSync(f.options.release), false);
});
test('configuration reads JSONC without stripping URL strings', t => {
  const f = fixture(t), file = f.write('config.jsonc', '{ // comment\n "url": "https://example.test/a,b}", /* comment */ "ok": true,\n}\n');
  assert.deepEqual(readConfig(file), { url: 'https://example.test/a,b}', ok: true });
});
test('scope safety refuses registry metadata before installation, permits only local fixture inputs', t => {
  const f = fixture(t);
  f.write('package.json', JSON.stringify({ dependencies: { '@clawnify/app': '0.4.1' } }));
  f.write('pnpm-lock.yaml', '');
  assert.throws(() => noScopeRegistry(f.base), /nonlocal dependency/);
  f.write('package.json', JSON.stringify({ dependencies: { '@clawnify/app': 'link:./runtime/app' } }));
  f.write('pnpm-lock.yaml', "packages:\n  '@clawnify/app@0.4.1': {}\n");
  assert.throws(() => noScopeRegistry(f.base), /lockfile metadata/);
  f.write('pnpm-lock.yaml', "importers:\n  .:\n    dependencies:\n      '@clawnify/app':\n        version: link:runtime/app\n");
  assert.doesNotThrow(() => noScopeRegistry(f.base));
  f.write('package.json', JSON.stringify({ dependencies: { '@clawnify/integrations': 'file:./stand-in' } }));
  f.write('pnpm-lock.yaml', "packages:\n  '@clawnify/integrations@file:stand-in':\n    resolution: {directory: stand-in, type: directory}\nsnapshots:\n  '@clawnify/integrations@file:stand-in': {}\n");
  assert.doesNotThrow(() => noScopeRegistry(f.base));
});

test('an unnumbered migration file stops assembly; the README and helper are not carried', t => {
  const f = assemblyFixture(t);
  f.write('migrations/hotfix.sql', 'SELECT 1;\n');
  assert.throws(() => assemble(f.options), /unnumbered migration file: hotfix\.sql/);
  assert.equal(fs.existsSync(f.options.release), false);
});
