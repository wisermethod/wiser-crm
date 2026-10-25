import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const scratchRoot = '/private/tmp/wiser-crm-m2c';
await mkdir(scratchRoot, { recursive: true });
Object.assign(process.env, {
  WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true',
  CLOUDFLARE_CF_FETCH_ENABLED: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  WRANGLER_LOG_PATH: join(scratchRoot, 'wrangler-logs'),
  XDG_CONFIG_HOME: join(scratchRoot, 'config'), TMPDIR: `${scratchRoot}/`, CI: 'true',
});
const require = createRequire(import.meta.url);
const wranglerCli = resolve(dirname(require.resolve('wrangler')), '../bin/wrangler.js');
const { getPlatformProxy, unstable_splitSqlQuery } = await import('wrangler');
export const quote = (name) => `"${name.replaceAll('"', '""')}"`;

export function command(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, env: process.env, encoding: 'utf8', timeout: 120_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.ifError(result.error);
  return { status: result.status, output };
}

export async function database(label, migrations = join(root, 'migrations')) {
  const directory = await mkdtemp(join(scratchRoot, `${label}-`));
  const config = join(directory, 'wrangler.json');
  const persist = join(directory, 'state');
  await writeFile(config, JSON.stringify({
    name: 'wiser-crm-migrations-test', compatibility_date: '2025-04-01',
    d1_databases: [{ binding: 'DB', database_name: 'test-db', database_id: 'test-db', migrations_dir: migrations }],
  }));
  return {
    directory, config, persist,
    async use(fn) {
      const proxy = await getPlatformProxy({ configPath: config, persist: { path: join(persist, 'v3') }, remoteBindings: false, envFiles: [] });
      try { return await fn(proxy.env.DB); } finally { await proxy.dispose(); }
    },
    apply() {
      const result = command(process.execPath, [wranglerCli, 'd1', 'migrations', 'apply', 'test-db', '--config', config, '--local', '--persist-to', persist], directory);
      assert.equal(result.status, 0, result.output);
      return result.output;
    },
    adopt(extra = []) {
      return command(process.execPath, [join(root, 'migrations/adopt.mjs'), 'test-db', '--config', config, '--local', '--persist-to', persist, ...extra], directory);
    },
  };
}

export async function execute(db, sql) {
  const statements = unstable_splitSqlQuery(sql);
  if (statements.length) await db.batch(statements.map((statement) => db.prepare(statement)));
}

export async function tableNames(db) {
  return (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name").all()).results.map(({ name }) => name);
}

export async function shape(db) {
  const tables = {};
  const foreignKeys = {};
  const indexes = [];
  for (const name of await tableNames(db)) {
    tables[name] = (await db.prepare(`PRAGMA table_info(${quote(name)})`).all()).results
      .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
      .sort((a, b) => a.name.localeCompare(b.name));
    foreignKeys[name] = (await db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()).results;
    for (const index of (await db.prepare(`PRAGMA index_list(${quote(name)})`).all()).results) {
      const columns = (await db.prepare(`PRAGMA index_info(${quote(index.name)})`).all()).results
        .sort((a, b) => a.seqno - b.seqno).map(({ name }) => name);
      const { sql } = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").bind(index.name).first();
      indexes.push({ name: index.name, table: name, unique: index.unique, partial: index.partial, columns, sql });
    }
  }
  indexes.sort((a, b) => a.name.localeCompare(b.name));
  return { tables, foreignKeys, indexes };
}

export function sameShape(actual, expected) {
  for (const [table, columns] of Object.entries(expected.tables)) {
    assert.ok(actual.tables[table], `Missing table ${table}`);
    for (const column of columns) {
      const found = actual.tables[table].find(({ name }) => name === column.name);
      assert.ok(found, `Missing column ${table}.${column.name}`);
      assert.deepEqual(found, column, `Column differs: ${table}.${column.name}`);
    }
    for (const column of actual.tables[table]) {
      assert.ok(columns.some(({ name }) => name === column.name), `Unexpected column ${table}.${column.name}`);
    }
    assert.deepEqual(actual.foreignKeys[table], expected.foreignKeys[table], `Foreign keys differ: ${table}`);
  }
  assert.deepEqual(Object.keys(actual.tables), Object.keys(expected.tables), 'Table names differ');
  for (const index of expected.indexes) {
    const found = actual.indexes.find(({ name }) => name === index.name);
    assert.ok(found, `Missing index ${index.table}.${index.name}`);
    assert.deepEqual(found.columns, index.columns, `Index columns differ: ${index.table}.${index.name}`);
    for (const property of ['table', 'unique', 'partial', 'sql']) {
      assert.equal(found[property], index[property], `Index ${property} differs: ${index.table}.${index.name}`);
    }
  }
  assert.deepEqual(actual.indexes.map(({ name }) => name), expected.indexes.map(({ name }) => name), 'Index names differ');
}

/** Include every field and FK, with one related row in every table. */
export async function seed(db) {
  await execute(db, 'ALTER TABLE contacts ADD COLUMN "cf_test" TEXT;');
  const names = await tableNames(db);
  const info = new Map();
  const refs = new Map();
  for (const name of names) {
    info.set(name, (await db.prepare(`PRAGMA table_info(${quote(name)})`).all()).results);
    refs.set(name, (await db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()).results);
  }
  const values = new Map(names.map((table) => [table, Object.fromEntries(info.get(table).map((column) => [
    column.name, /INT|REAL|NUM|DEC|BOOL/i.test(column.type) ? 1 : `seed:${table}:${column.name}`,
  ]))]));
  for (const table of names) {
    for (const fk of refs.get(table)) values.get(table)[fk.from] = values.get(fk.table)[fk.to];
  }
  values.get('contacts').cf_test = 'custom value survives';
  const inserted = new Set();
  while (inserted.size < names.length) {
    const ready = names.filter((name) => !inserted.has(name) && refs.get(name).every((fk) => fk.table === name || inserted.has(fk.table)));
    assert.ok(ready.length, 'Seed requires a policy for new cyclic foreign keys');
    for (const table of ready) {
      const row = values.get(table);
      const columns = Object.keys(row);
      await db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote)}) VALUES (${columns.map(() => '?')})`).bind(...Object.values(row)).run();
      inserted.add(table);
    }
  }
  const secondContact = { ...values.get('contacts'), id: 'seed:contacts:second-id', cf_test: 'second custom value survives' };
  await db.prepare(`INSERT INTO contacts (${Object.keys(secondContact).map(quote)}) VALUES (${Object.keys(secondContact).map(() => '?')})`)
    .bind(...Object.values(secondContact)).run();
}

export async function snapshot(db) {
  const tables = {};
  for (const table of await tableNames(db)) {
    tables[table] = {
      columns: (await db.prepare(`PRAGMA table_info(${quote(table)})`).all()).results.map(({ name }) => name),
      rows: (await db.prepare(`SELECT * FROM ${quote(table)}`).all()).results,
    };
  }
  return tables;
}

export function preserves(before, after) {
  // Check columns before rows so a rebuild names the lost custom field directly.
  for (const [table, { columns }] of Object.entries(before)) {
    assert.ok(after[table], `Migration lost table ${table}`);
    for (const column of columns) assert.ok(after[table].columns.includes(column), `Migration lost column ${table}.${column}`);
  }
  for (const [table, { columns, rows }] of Object.entries(before)) {
    const projected = after[table].rows.map((row) => Object.fromEntries(columns.map((name) => [name, row[name]])));
    const sort = (items) => items.map((row) => JSON.stringify(row)).sort();
    assert.deepEqual(sort(projected), sort(rows), `Migration changed records in ${table}`);
  }
}

export async function preservationCase(files, nextFile) {
  const directory = await mkdtemp(join(scratchRoot, 'migration-chain-'));
  for (const file of files) await cp(file, join(directory, file.split('/').at(-1)));
  const local = await database('preservation', directory);
  local.apply();
  const before = await local.use(async (db) => { await seed(db); return snapshot(db); });
  await cp(nextFile, join(directory, nextFile.split('/').at(-1)));
  local.apply();
  const after = await local.use(snapshot);
  preserves(before, after);
  return { before, after };
}

export const baseline = () => readFile(join(root, 'migrations/0001_baseline.sql'), 'utf8');
