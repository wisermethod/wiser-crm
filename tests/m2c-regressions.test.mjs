import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { baseline, database, execute, preservationCase, root, scratchRoot, seed } from './migration-helpers.mjs';

function command(executable, args, cwd) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Child suites must really run, not inherit Node's recursive-run guard.
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  assert.ifError(result.error);
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// Copy only named source files. Never traverse dependencies, environment files,
// memory directories or Git history. Schema mutations happen only in scratch.
async function forkCopy() {
  const copy = await mkdtemp(join(scratchRoot, 'fork-'));
  for (const file of ['package.json', 'src/server/schema.sql', 'migrations/0001_baseline.sql',
    'migrations/adopt.mjs', 'tests/migration-helpers.mjs', 'tests/migrations.test.mjs',
    'tests/sign-in.e2e.test.mjs', 'tests/local-worker.mjs',
    'tests/fixtures/migrations/0002_add_column.sql', 'tests/fixtures/migrations/0002_drop_custom_column.sql',
    'tests/fixtures/migrations/0002_restore_custom_default.sql']) {
    const destination = join(copy, file);
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(join(root, file), destination);
  }
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'));
  return copy;
}

const historyDDL = `CREATE TABLE d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

async function state(db) {
  const schema = (await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name != '_cf_METADATA' ORDER BY name").all()).results;
  const rows = {};
  for (const { name, type } of schema) {
    if (type === 'table') rows[name] = (await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()).results;
  }
  return { schema, rows };
}

for (const [label, change, history, diagnostic] of [
  ['column type', sql => sql.replace("status TEXT NOT NULL DEFAULT 'lead'", "status INTEGER NOT NULL DEFAULT 'lead'"), null, /column contacts\.status.*type/i],
  ['missing unique index', sql => `${sql}\nDROP INDEX idx_views_default;`, null, /index.*idx_views_default/i],
  ['empty history and missing table', sql => `${sql}\nDROP TABLE insights;`, '', /d1_migrations.*empty/i],
  ['unknown history', sql => sql, 'not-a-migration.sql', /history.*prefix|not-a-migration\.sql/i],
  ['recorded baseline with changed type', sql => sql.replace("status TEXT NOT NULL DEFAULT 'lead'", "status INTEGER NOT NULL DEFAULT 'lead'"), '0001_baseline.sql', /column contacts\.status.*type/i],
]) {
  test(`M2c adoption rejects ${label} with exit 1 and no writes`, async () => {
    // Build altered schemas before seeding when the alteration changes a type.
    const altered = await database('altered');
    await altered.use(async db => {
      // Missing-table input must retain rows in every remaining table.
      const sql = change(await baseline());
      if (label === 'empty history and missing table') {
        await execute(db, await baseline());
        await seed(db);
        await execute(db, 'DROP TABLE insights;');
      } else {
        await execute(db, sql);
        await seed(db);
      }
      if (history !== null) {
        await execute(db, historyDDL);
        if (history) await db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(history).run();
      }
    });
    const before = await altered.use(state);
    const result = altered.adopt();
    const after = await altered.use(state);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, diagnostic);
    assert.deepEqual(after, before, 'Refused adoption wrote schema, history or application rows');
    if (history === null) assert.equal(after.rows.d1_migrations, undefined);
  });
}

for (const [label, from, to, diagnostic] of [
  ['foreign key', 'company_id TEXT REFERENCES companies(id) ON DELETE SET NULL', 'company_id TEXT REFERENCES companies(id) ON DELETE CASCADE', /foreign keys? differ.*contacts/i],
  ['autoindex columns', 'UNIQUE(entity_type, key)', 'UNIQUE(entity_type, label)', /index columns differ.*sqlite_autoindex_custom_field_defs/i],
]) {
  test(`M2c drift detects ${label} in a scratch fork`, async () => {
    const copy = await forkCopy();
    const schema = join(copy, 'src/server/schema.sql');
    const original = await readFile(schema, 'utf8');
    assert.ok(original.includes(from));
    await writeFile(schema, original.replace(from, to));
    const result = command(process.execPath, ['--test', '--test-name-pattern=^schema drift:', join(copy, 'tests/migrations.test.mjs')], copy);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, diagnostic);
  });
}

test('M2c adoption test applies a later migration after adopting and preserves old values', async () => {
  const copy = await forkCopy();
  await cp(join(copy, 'tests/fixtures/migrations/0002_add_column.sql'), join(copy, 'migrations/0002_add_column.sql'));
  const helper = join(copy, 'tests/migration-helpers.mjs');
  await writeFile(helper, (await readFile(helper, 'utf8')).replace('apply() {', "apply() { console.log('M2C_APPLY_AFTER_ADOPT');"));
  const result = command(process.execPath, ['--test', '--test-name-pattern=^adoption keeps every seeded row', join(copy, 'tests/migrations.test.mjs')], copy);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /M2C_APPLY_AFTER_ADOPT/, 'Adoption test skipped apply() when 0002 exists');
});

test('M2c production preservation test refuses zero migrations without fixtures', async () => {
  const copy = await forkCopy();
  await rm(join(copy, 'tests/fixtures/migrations'), { recursive: true });
  const result = command(process.execPath, ['--test', '--test-name-pattern=^every post-baseline migration', join(copy, 'tests/migrations.test.mjs')], copy);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /No post-baseline migrations.*fixtures/i);
});

test('M2c preservation rejects a rebuild that restores the custom default on every row', async () => {
  const fixture = join(root, 'tests/fixtures/migrations/0002_restore_custom_default.sql');
  await assert.rejects(() => preservationCase([join(root, 'migrations/0001_baseline.sql')], fixture), /Migration changed records in contacts/);
});

test('M2c running sign-in suite covers every unsigned surface and run route', async () => {
  const copy = await forkCopy();
  const requests = join(copy, 'requests.jsonl');
  const helper = join(copy, 'tests/local-worker.mjs');
  let source = await readFile(helper, 'utf8');
  source = "import { appendFile } from 'node:fs/promises';\n" + source.replace("const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');", `const root = ${JSON.stringify(root)};`);
  source = source.replace("assert.ok(path.startsWith('/'), 'Requests must be local paths');", `await appendFile(${JSON.stringify(requests)}, JSON.stringify({ method, path, unsigned: !token, host: headers.Host ?? '127.0.0.1' }) + '\\n');\n    assert.ok(path.startsWith('/'), 'Requests must be local paths');`);
  await writeFile(helper, source);
  const result = command(process.execPath, ['--test', join(copy, 'tests/sign-in.e2e.test.mjs')], copy);
  assert.equal(result.status, 0, result.output);
  const observed = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const [method, paths] of [['GET', ['/', '/api/contacts', '/llms.txt', '/contacts/1']], ['POST', ['/api/email-sync/run', '/api/ai-columns/run', '/api/meetings/run']]]) {
    for (const path of paths) assert.ok(observed.some(request => request.unsigned && request.host === '127.0.0.1' && request.method === method && request.path === path), `Missing unsigned ${method} ${path} through running wrapper`);
  }
  assert.doesNotMatch(result.output, /case 10: non-local Host/);
});
