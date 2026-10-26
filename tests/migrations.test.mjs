import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { baseline, command, database, execute, preservationCase, preserves, root, sameShape, shape, snapshot, scratchRoot } from './migration-helpers.mjs';

const migrations = (await readdir(join(root, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
const migrationFiles = migrations.map((name) => join(root, 'migrations', name));
assert.equal(migrations[0], '0001_baseline.sql');

// The baseline is frozen at the fork commit it was copied from; later schema changes are migrations, which the drift test checks.
const BASELINE_COMMIT = '4dd02ea';

test('baseline equals the schema it was frozen from, table by table, column by column and index by index', async () => {
  const committed = command('git', ['show', `${BASELINE_COMMIT}:src/server/schema.sql`]);
  assert.equal(committed.status, 0, committed.output);
  assert.equal(await baseline(), committed.output, `Baseline bytes differ from ${BASELINE_COMMIT} schema`);
  const migrated = await database('baseline', join(root, 'migrations'));
  // This case intentionally applies only the baseline as later migrations grow.
  const { cp, mkdtemp } = await import('node:fs/promises');
  const baselineDirectory = await mkdtemp(join(scratchRoot, 'baseline-only-'));
  await cp(migrationFiles[0], join(baselineDirectory, migrations[0]));
  const baselineDb = await database('baseline-only', baselineDirectory);
  baselineDb.apply();
  await migrated.use((db) => execute(db, committed.output));
  sameShape(await baselineDb.use(shape), await migrated.use(shape));
});

test('schema drift: every migration matches the working tree schema', async () => {
  const migrated = await database('drift-migrated');
  const schemaDb = await database('drift-schema');
  migrated.apply();
  await schemaDb.use((db) => readFile(join(root, 'src/server/schema.sql'), 'utf8').then((sql) => execute(db, sql)));
  sameShape(await migrated.use(shape), await schemaDb.use(shape));
});

test('apply is idempotent and leaves the migration records unchanged', async () => {
  const local = await database('idempotent');
  local.apply();
  const records = (db) => db.prepare('SELECT * FROM d1_migrations ORDER BY id').all().then(({ results }) => results);
  const before = await local.use(records);
  assert.deepEqual(before.map(({ name }) => name), migrations);
  assert.match(local.apply(), /No migrations to apply/);
  assert.deepEqual(await local.use(records), before);
});

test('adoption keeps every seeded row and custom value; repeated adoption and apply change nothing', async () => {
  const { seed } = await import('./migration-helpers.mjs');
  const local = await database('adoption');
  const before = await local.use(async (db) => { await execute(db, await baseline()); await seed(db); return snapshot(db); });
  assert.equal(Object.keys(before).length, 20);
  for (const [name, { rows }] of Object.entries(before)) assert.equal(rows.length, name === 'contacts' ? 2 : 1, `Seed row missing in ${name}`);
  assert.equal(new Set(before.contacts.rows.map(({ cf_test }) => cf_test)).size, 2, 'Custom values must differ across rows');
  const adopted = local.adopt();
  assert.equal(adopted.status, 0, adopted.output);
  assert.match(adopted.output, /without running it/);
  const records = (db) => db.prepare('SELECT * FROM d1_migrations').all().then(({ results }) => results);
  const record = await local.use(records);
  assert.equal(record.length, 1);
  assert.equal(record[0].name, '0001_baseline.sql');
  assert.equal(record[0].id, 1);
  assert.ok(record[0].applied_at);
  // Existing installs first adopt the frozen baseline, then receive later files.
  const applied = local.apply();
  if (migrations.length === 1) assert.match(applied, /No migrations to apply/);
  const after = await local.use(snapshot);
  preserves(before, after);
  if (migrations.length === 1) assert.deepEqual(after, before);
  const appliedRecords = await local.use(records);
  assert.deepEqual(appliedRecords.map(({ name }) => name), migrations);
  const repeated = local.adopt();
  assert.equal(repeated.status, 0, repeated.output);
  assert.match(repeated.output, /already records the baseline and the schema matches; nothing changed/);
  assert.deepEqual(await local.use(records), appliedRecords);
  assert.deepEqual(await local.use(snapshot), after);
});

// Miniflare may lazily create its own _cf_METADATA on the first D1 read.
// Compare all application and SQLite history objects, excluding that internal table.
const rawSchema = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name != '_cf_METADATA' ORDER BY name").all().then(({ results }) => results);

test('adoption leaves an empty database alone and directs migrations apply', async () => {
  const local = await database('empty');
  const before = await local.use(rawSchema);
  const result = local.adopt();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /No baseline tables found.*migrations apply/);
  assert.deepEqual(await local.use(rawSchema), before);
});

for (const [label, alteration, missing] of [
  ['table', 'DROP TABLE insights;', 'table insights'],
  ['column', 'ALTER TABLE contacts DROP COLUMN last_contacted_at;', 'column contacts.last_contacted_at'],
]) {
  test(`adoption refuses a missing baseline ${label} without writing`, async () => {
    const local = await database(`partial-${label}`);
    await local.use(async (db) => execute(db, `${await baseline()}\n${alteration}`));
    const before = await local.use(rawSchema);
    const beforeRows = await local.use(snapshot);
    const result = local.adopt();
    assert.notEqual(result.status, 0, result.output);
    assert.ok(result.output.includes(missing), result.output);
    assert.deepEqual(await local.use(rawSchema), before);
    assert.deepEqual(await local.use(snapshot), beforeRows);
  });
}

test('adoption refuses remote or missing-local arguments before accessing a database', async () => {
  const script = join(root, 'migrations/adopt.mjs');
  for (const args of [[], ['db', '--remote', '--config', 'absent.json', '--persist-to', join(scratchRoot, 'unused')]]) {
    const result = command(process.execPath, [script, ...args]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Usage:|Unknown option/);
  }
});

test('every post-baseline migration keeps every record and every custom column', async (t) => {
  t.diagnostic(`${migrationFiles.length - 1} post-baseline migration(s) checked; fixture controls exercise the same preservation checker.`);
  if (migrationFiles.length === 1) {
    const fixtures = ['0002_add_column.sql', '0002_drop_custom_column.sql', '0002_restore_custom_default.sql']
      .map(name => join(root, 'tests/fixtures/migrations', name));
    for (const file of fixtures) {
      const sql = await readFile(file, 'utf8').catch(() => '');
      assert.ok(sql.trim(), `No post-baseline migrations; required preservation fixtures missing or empty: ${file}`);
    }
    await t.test('baseline-only chain: additive fixture passes', () => preservationCase([migrationFiles[0]], fixtures[0]));
    await t.test('baseline-only chain: missing custom column fails', () => assert.rejects(
      () => preservationCase([migrationFiles[0]], fixtures[1]), /Migration lost column contacts\.cf_test/));
    await t.test('baseline-only chain: restored custom defaults fail', () => assert.rejects(
      () => preservationCase([migrationFiles[0]], fixtures[2]), /Migration changed records in contacts/));
  }
  for (let index = 1; index < migrationFiles.length; index++) {
    await t.test(migrations[index], () => preservationCase(migrationFiles.slice(0, index), migrationFiles[index]));
  }
});

test('preservation fixture: adding a column passes', async () => {
  const { after } = await preservationCase([migrationFiles[0]], join(root, 'tests/fixtures/migrations/0002_add_column.sql'));
  assert.ok(after.contacts.columns.includes('migration_fixture'));
});

test('preservation fixture: rebuilding contacts without cf_test is detected', async (t) => {
  const run = () => preservationCase([migrationFiles[0]], join(root, 'tests/fixtures/migrations/0002_drop_custom_column.sql'));
  // The explicit planted run is intentionally red, using this same checker.
  if (process.env.WISER_MIGRATION_PLANTED_DROP === '1') return run();
  await assert.rejects(run, (error) => {
    assert.match(error.message, /Migration lost column contacts\.cf_test/);
    t.diagnostic(`Expected rejection: ${error.message}`);
    return true;
  });
});
