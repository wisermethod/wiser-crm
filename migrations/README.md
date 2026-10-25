# D1 migrations

Wrangler owns migration execution and its history. `0001_baseline.sql` is a
byte-for-byte copy of `src/server/schema.sql` at fork commit `4dd02ea`. Leave it
unchanged once any database has applied or adopted it. Only numbered SQL files
belong in this directory; Wrangler ignores this README and `adopt.mjs`.

Both Wiser Wrangler configurations set the D1 binding's `migrations_dir` to
`migrations`. For a fresh local database, from the repository root:

```sh
WRANGLER_SEND_METRICS=false pnpm exec wrangler d1 migrations apply wiser-crm-db \
  --config wrangler.local.jsonc --local --persist-to /private/tmp/wiser-crm-m2c/local
```

Wrangler 4.93.1 keeps this table (including SQLite's `sqlite_sequence` for the
autoincrement key):

```sql
CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
```

It reads all records ordered by `id`, compares their `name` values to `.sql`
filenames, and applies only absent filenames, sorted by their numeric prefix.
It appends `INSERT INTO d1_migrations (name) VALUES ('<filename>');` to each
migration's SQL. A second apply reports `No migrations to apply!`. Filenames,
including `0001_baseline.sql`, are the migration identity. Do not rename or
rewrite an applied migration. There is no checksum column. A later hosted
migrate action using Cloudflare's D1 API must keep the same table, column
definitions and filename records; this directory adds no separate runner.

These details were checked in the installed Wrangler 4.93.1 distribution,
`wrangler-dist/cli.js`: default name at line 179481; pending-name comparison
at 181183 to 181231; ordered history read at 181244 to 181270; table DDL at
181274 to 181301; apply order and history insertion at 181389 to 181458.

## Adopt an existing baseline

A database created directly from `schema.sql` has no history. Stop application
writes during adoption and migration, and take the provider's backup or bookmark
before a production upgrade. For a local copy:

```sh
WRANGLER_SEND_METRICS=false node migrations/adopt.mjs wiser-crm-db \
  --config wrangler.local.jsonc --local --persist-to /private/tmp/wiser-crm-m2c/local
```

The script requires a config, a configured database name (or binding), `--local`
and an explicit persistence directory. Remote adoption is unsupported and
`--remote` is rejected. It uses only Node and the installed Wrangler. It disables
remote bindings and fetches of Cloudflare development metadata, and reads no
development secrets or application code. Temporary reference files use Node's
temporary directory; set `TMPDIR=/private/tmp/wiser-crm-m2c/` for this local gate.

Adoption compares each baseline table against a reference database made from
`0001_baseline.sql`. Each baseline column must match its `type`, `notnull`,
`dflt_value` and `pk` from `PRAGMA table_info`. Every baseline index, including
SQLite autoindexes for primary keys and table-level uniqueness, must have the
same name, `unique` and `partial` flags from `PRAGMA index_list`, and the same
ordered columns from `PRAGMA index_info`. Each table's `PRAGMA foreign_key_list`
must match. Extra columns, indexes and tables are allowed; table column order
is ignored. A mismatch names the table, column, index or foreign keys and exits
1 before any application or history write.

If `d1_migrations` exists, its `name` values, ordered by `id`, must form a
nonempty prefix of the SQL filenames in this directory. Empty history, unknown
names, gaps and out-of-order names are refused with exit 1. A valid prefix
still undergoes the complete baseline schema check. Only a recorded baseline
with a matching schema succeeds without writing; existing history is never
trusted as evidence of schema compatibility.

Without history, a matching baseline is adopted atomically by creating
Wrangler's table and recording `0001_baseline.sql`, without executing that SQL
on the target. If none of the baseline tables exist, it writes no schema or
history and directs you to `migrations apply`. A partial baseline is refused
before any target write. An unrelated table does not make a database a partial
baseline. After successful adoption, always run Wrangler's migrations apply
command to receive later migrations.

## Write an upgrade

When an upstream merge changes `src/server/schema.sql`, compare it with the
previous merged version. Add the next unused zero-padded numbered SQL file,
for example `0002_contact_source.sql`, containing the changes an existing
database needs. Prefer additive `ALTER TABLE ... ADD COLUMN` and explicit
index changes. Keep schema.sql as the fresh-install definition and migrations
as the path from the frozen baseline to that definition. Run the drift test
after writing the migration. The baseline equivalence test reads `schema.sql`
at `4dd02ea`, the commit the baseline was frozen from; the drift test reads the
current working schema. Never regenerate the baseline to
make a drift failure disappear.

**No migration rebuilds a table without carrying every column it finds there,
including every member-created custom column and its values.** Custom fields
are real columns added by the app's `ALTER TABLE`, not JSON. A fixed
create-copy-drop-rename column list cannot satisfy this rule for arbitrary
custom fields. If a change needs such a rebuild, resolve that design before
shipping SQL. A migration must also preserve every existing record.

```sh
node --test tests/migrations.test.mjs
```

The tests use Wrangler's local `getPlatformProxy` for D1 setup, seeding and
inspection, and real `wrangler d1 migrations apply --local --persist-to` for
application. Every database has its own directory under
`/private/tmp/wiser-crm-m2c/`. The preservation check seeds a row in every
table, two contacts with different `contacts.cf_test` values, then compares every old column and value across
each post-baseline migration. Fixtures under `tests/fixtures/migrations/`
prove an added column passes, a rebuild that drops `cf_test` fails, and a
rebuild that restores only its default loses the distinct per-row values. They
never enter the production migration directory.
