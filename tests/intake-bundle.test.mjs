import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));

test('6: the public intake bundle excludes CRM modules and Hono and binds only intake D1', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'wiser-intake-bundle-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const configPath = join(root, 'intake/wrangler.jsonc');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const configFields = ['compatibility_date', 'compatibility_flags', 'd1_databases', 'main', 'name', 'send_email', 'send_metrics', 'vars'];
  assert.deepEqual(Object.keys(config).filter((key) => !configFields.includes(key)), []);
  assert.deepEqual(Object.keys(config.vars).sort(), [
    'CRM_URL', 'INTAKE_MAX_PER_ADDRESS_PER_DAY', 'INTAKE_MAX_PER_HOUR', 'INTAKE_ORIGIN', 'INTAKE_RETURN_URL',
    'NOTICE_FROM', 'NOTICE_FROM_NAME', 'NOTICE_TO',
  ]);
  assert.deepEqual(config.send_email, [{ name: 'NOTICE', destination_address: config.vars.NOTICE_TO }]);
  assert.deepEqual(config.d1_databases.map((db) => db.binding), ['INTAKE_DB']);
  const require = createRequire(import.meta.url);
  const wrangler = resolve(dirname(require.resolve('wrangler')), '../bin/wrangler.js');
  const metafile = join(scratch, 'meta.json');
  const outdir = join(scratch, 'out');
  const result = spawnSync(process.execPath, [
    wrangler, 'deploy', '--dry-run', '--config', configPath, '--outdir', outdir, '--metafile', metafile,
  ], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: {
      ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false',
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_LOG_PATH: join(scratch, 'logs'),
      XDG_CONFIG_HOME: join(scratch, 'config'), CI: 'true',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { inputs } = JSON.parse(await readFile(metafile, 'utf8'));
  const paths = Object.keys(inputs).map((input) => relative(root, resolve(dirname(configPath), input)));
  t.diagnostic(`Wrangler metafile inputs: ${paths.join(', ')}`);
  assert.ok(paths.includes('intake/worker.ts'), 'The metafile must include the real intake entry');
  const forbidden = paths.filter((path) =>
    /^(?:src|runtime|worker)\//.test(path) || /(?:^|\/)(?:hono(?:[@/]|$)|@hono\/)/.test(path));
  assert.deepEqual(forbidden, [], 'The intake bundle must exclude all CRM inputs and Hono');
});

test('15: exactly ten upstream files are edited', () => {
  const base = spawnSync('git', ['merge-base', 'HEAD', 'clawnify/main'], { cwd: root, encoding: 'utf8' });
  assert.ifError(base.error);
  assert.equal(base.status, 0, base.stderr);
  const diff = spawnSync('git', ['diff', '--name-only', '--no-renames', '--diff-filter=MD', base.stdout.trim()], {
    cwd: root, encoding: 'utf8',
  });
  assert.ifError(diff.error);
  assert.equal(diff.status, 0, diff.stderr);
  assert.equal(diff.stdout.trim().split('\n').filter(Boolean).length, 10, diff.stdout);
});
