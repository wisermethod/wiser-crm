#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
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
    if (haveTables.has(migrationTable)) {
      return `${migrationTable} already exists; nothing changed.`;
    }

    // Use SQLite's own interpretation of the frozen baseline, not a SQL parser.
    const reference = await open(false);
    const sql = await readFile(new URL(baselineName, import.meta.url), 'utf8');
    await reference.batch(unstable_splitSqlQuery(sql).map((statement) => reference.prepare(statement)));
    const requiredTables = (await reference.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all()).results.map(({ name }) => name);
    if (!requiredTables.some((name) => haveTables.has(name))) {
      return 'No baseline tables found; nothing changed. Run wrangler d1 migrations apply.';
    }

    const missing = [];
    for (const table of requiredTables) {
      if (!haveTables.has(table)) {
        missing.push(`table ${table}`);
        continue;
      }
      const required = (await reference.prepare(`PRAGMA table_info(${quote(table)})`).all()).results;
      const actual = (await target.prepare(`PRAGMA table_info(${quote(table)})`).all()).results;
      const columns = new Set(actual.map(({ name }) => name));
      for (const { name } of required) {
        if (!columns.has(name)) missing.push(`column ${table}.${name}`);
      }
    }
    if (missing.length) throw new Error(`Refusing incomplete baseline; missing ${missing.join(', ')}. Nothing changed.`);

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
