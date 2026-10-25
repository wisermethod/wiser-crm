#!/usr/bin/env node
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const baselineName = '0001_baseline.sql';
const migrationTable = 'd1_migrations';
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/** Adopt only a complete baseline. Never execute the baseline on the target. */
export async function adoptLocal({ configPath, databaseName, persistTo }) {
  // No remote proxies, development secrets, assets or application code are loaded.
  process.env.WRANGLER_SEND_METRICS = 'false';
  process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
  const { getPlatformProxy, unstable_readConfig, unstable_splitSqlQuery } = await import('wrangler');
  const config = unstable_readConfig({ config: resolve(configPath) });
  const matches = config.d1_databases.filter((db) => db.database_name === databaseName || db.binding === databaseName);
  if (matches.length !== 1) throw new Error(`Expected one configured D1 database named ${databaseName}.`);
  const selected = matches[0];
  if (selected.migrations_table && selected.migrations_table !== migrationTable) {
    throw new Error(`Adoption requires Wrangler's default ${migrationTable} table.`);
  }

  const scratch = await mkdtemp(join(tmpdir(), 'wiser-crm-adopt-'));
  const proxies = [];
  try {
    const temporaryConfig = join(scratch, 'wrangler.json');
    await writeFile(temporaryConfig, JSON.stringify({
      name: 'wiser-crm-adoption', compatibility_date: '2025-04-01',
      d1_databases: [{
        binding: 'DB', database_name: selected.database_name,
        database_id: selected.database_id || selected.database_name,
      }],
    }));
    async function open(persist) {
      const proxy = await getPlatformProxy({
        configPath: temporaryConfig, persist, remoteBindings: false, envFiles: [],
      });
      proxies.push(proxy);
      return proxy.env.DB;
    }
    // CLI --persist-to names the state root; getPlatformProxy expects its v3 child.
    const target = await open({ path: join(resolve(persistTo), 'v3') });
    const tables = (await target.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results;
    const haveTables = new Set(tables.map(({ name }) => name));
    const hasHistory = haveTables.has(migrationTable);
    if (hasHistory) {
      const names = (await target.prepare(`SELECT name FROM ${migrationTable} ORDER BY id`).all()).results.map(({ name }) => name);
      const files = (await readdir(new URL('.', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
      if (!names.length) throw new Error(`Refusing ${migrationTable} history: empty. Nothing changed.`);
      if (files[0] !== baselineName || names.length > files.length || names.some((name, index) => name !== files[index])) {
        throw new Error(`Refusing ${migrationTable} history: names must be an ordered prefix of the migration files (${names.join(', ')}). Nothing changed.`);
      }
    }

    // Use SQLite's own interpretation of the frozen baseline, not a SQL parser.
    const reference = await open(false);
    const sql = await readFile(new URL(baselineName, import.meta.url), 'utf8');
    await reference.batch(unstable_splitSqlQuery(sql).map((statement) => reference.prepare(statement)));
    const requiredTables = (await reference.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all()).results.map(({ name }) => name);
    if (!hasHistory && !requiredTables.some((name) => haveTables.has(name))) {
      return 'No baseline tables found; nothing changed. Run wrangler d1 migrations apply.';
    }

    const mismatches = [];
    const rows = async (db, pragma, name) => (await db.prepare(`PRAGMA ${pragma}(${quote(name)})`).all()).results;
    for (const table of requiredTables) {
      if (!haveTables.has(table)) {
        mismatches.push(`missing table ${table}`);
        continue;
      }
      const required = (await reference.prepare(`PRAGMA table_info(${quote(table)})`).all()).results;
      const actual = (await target.prepare(`PRAGMA table_info(${quote(table)})`).all()).results;
      for (const column of required) {
        const found = actual.find(({ name }) => name === column.name);
        if (!found) {
          mismatches.push(`missing column ${table}.${column.name}`);
          continue;
        }
        for (const property of ['type', 'notnull', 'dflt_value', 'pk']) {
          if (found[property] !== column[property]) mismatches.push(`column ${table}.${column.name} ${property} differs`);
        }
      }
      const actualIndexes = await rows(target, 'index_list', table);
      for (const index of await rows(reference, 'index_list', table)) {
        const found = actualIndexes.find(({ name }) => name === index.name);
        if (!found) {
          mismatches.push(`missing index ${table}.${index.name}`);
          continue;
        }
        for (const property of ['unique', 'partial']) {
          if (found[property] !== index[property]) mismatches.push(`index ${table}.${index.name} ${property} differs`);
        }
        // cids depend on table column order; only index column order matters.
        const columns = async db => (await rows(db, 'index_info', index.name)).sort((a, b) => a.seqno - b.seqno).map(({ name }) => name);
        if (!isDeepStrictEqual(await columns(target), await columns(reference))) {
          mismatches.push(`index columns differ: ${table}.${index.name}`);
        }
      }
      if (!isDeepStrictEqual(await rows(target, 'foreign_key_list', table), await rows(reference, 'foreign_key_list', table))) {
        mismatches.push(`foreign keys differ: ${table}`);
      }
    }
    if (mismatches.length) throw new Error(`Refusing incompatible baseline; ${mismatches.join(', ')}. Nothing changed.`);
    if (hasHistory) return `${migrationTable} already records the baseline and the schema matches; nothing changed.`;

    // The same DDL and INSERT used by Wrangler 4.93.1, in one atomic D1 batch.
    await target.batch([
      target.prepare(`CREATE TABLE IF NOT EXISTS ${migrationTable}(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );`),
      target.prepare(`INSERT INTO ${migrationTable} (name) VALUES (?)`).bind(baselineName),
    ]);
    return `Adopted ${baselineName} without running it; recorded in ${migrationTable}.`;
  } finally {
    await Promise.all(proxies.map((proxy) => proxy.dispose()));
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' }, local: { type: 'boolean' }, 'persist-to': { type: 'string' },
    },
  });
  if (positionals.length !== 1 || !values.config || !values.local || !values['persist-to']) {
    throw new Error('Usage: node migrations/adopt.mjs <database> --config <file> --local --persist-to <dir>. Only local adoption is supported.');
  }
  await mkdir(resolve(values['persist-to']), { recursive: true });
  console.log(await adoptLocal({
    configPath: values.config, databaseName: positionals[0], persistTo: values['persist-to'],
  }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
