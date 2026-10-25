# Tests

Run from the repository root with the existing pnpm dependencies installed and
a Node version that can run the TypeScript unit tests directly. No test needs a
Cloudflare account, a deploy, or a published Clawnify package. Do not install or
open those packages; the fork uses its own `runtime/` links.

Run every suite:

```bash
WRANGLER_SEND_METRICS=false node --test tests/records.test.mjs tests/sign-in.e2e.test.mjs tests/import.test.mjs tests/migrations.test.mjs tests/m2c-regressions.test.mjs worker/sign-in.test.ts worker/dev/index.test.ts release/clawnify-free.test.mjs release/build.test.mjs
```

Run any suite individually:

```bash
WRANGLER_SEND_METRICS=false node --test tests/records.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/sign-in.e2e.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/import.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/migrations.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/m2c-regressions.test.mjs
node --test worker/sign-in.test.ts
node --test worker/dev/index.test.ts
node --test release/clawnify-free.test.mjs
```

Also check both application and Wiser types:

```bash
pnpm typecheck
pnpm exec tsc --noEmit -p tsconfig.wiser.json
```

| File | What it proves |
|---|---|
| `tests/records.test.mjs` | A person's verified token creates, reads, updates one field without losing other fields, and deletes a company, a contact linked to it and a deal linked to both. Deleted records return 404 and leave the lists. A note returns the creation acknowledgement and appears in the contact timeline; live OpenAPI offers only GET/POST activities and no activity detail route. |
| `tests/sign-in.e2e.test.mjs` | Pass-list cases 1 to 6 and 11 through the running local Worker: unsigned root, API, llms, deep-link and run-route requests; forged/expired/wrong-audience/wrong-issuer tokens, supplied identity headers, public job routes including an encoded path, person/agent contact reads, non-local Host refusal, and three platform-only routes. Each request's expected HTTP status is explicit. |
| `tests/import.test.mjs` | Three contacts followed by two overlapping and one new row leave four contacts; matching ignores case, fills a missing phone and preserves existing nonblank values and status. Same email with another first name creates a fifth contact and leaves the earlier records unchanged. |
| `tests/migrations.test.mjs` | Frozen baseline equality, working-schema drift, idempotent apply/adoption, safe refusal of partial adoption, and preservation of seeded records and custom columns through each later migration. Passing and destructive fixtures exercise the preservation checker even with a baseline-only chain. |
| `tests/m2c-regressions.test.mjs` | Adoption refusals leave schema, history and rows unchanged; scratch-fork foreign-key and autoindex drift, adopt-then-upgrade, missing preservation controls, default-restoring rebuild, and observed running-wrapper unsigned request coverage. |
| `worker/sign-in.test.ts` | Wrapper policy in isolation with real token verification and runtime identity: all sign-in pass-list cases except bundle/install/count cases 7 to 9, plus algorithm restrictions, key rotation, configuration, concurrent identities, and downstream-call isolation. |
| `worker/dev/index.test.ts` | Local-host and enable-flag guards, local sign-in cookie behavior, cross-site refusal, assertion precedence, cookie removal, missing keys and invalid credentials. |
| `release/clawnify-free.test.mjs` | Synthetic fixtures for the lockfile, install-log and bundle-input checks, including refusal of registry packages, disguised paths and invalid evidence. See `release/README.md` for release evidence commands; these unit tests do not perform an install. |

`tests/local-worker.mjs` is the shared integration harness, not a test file. It
starts the real `worker/dev/index.ts` using Wrangler's `unstable_startWorker`,
then sends HTTP requests to `127.0.0.1` on an assigned free port. It generates an
RS256 key pair and JWKS for each run, authenticates only through tokens verified
by the real wrapper, and migrates fresh local D1 state using Wrangler
`d1 migrations apply --local --persist-to`. It reads the live OpenAPI document
before any scenario. No application or identity implementation is mocked.

Keys, configuration, databases and build scratch stay under
`/private/tmp/wiser-crm-m2b/`. Metrics, environment-file loading, remote bindings,
inspector, watching and external Worker fetches are disabled. Teardown disposes
the Worker after success or failure and checks its public port is closed. The
non-local Host case still connects only to `127.0.0.1`; the local entry returns
403 before token verification. Pass-list case 10 is
`worker/sign-in.test.ts`'s `workers.dev` case: an address Access does not cover
reaches the wrapper without a credential, gets 401, and calls neither app nor
assets. The foreign-Host integration check proves only the local entry guard.

`tests/migration-helpers.mjs` is the migration suite's shared helper. Its scratch
root is `/private/tmp/wiser-crm-m2c/`; it uses local Wrangler migrations and
`getPlatformProxy`, disposing every proxy. The SQL files in
`tests/fixtures/migrations/` are the additive and destructive controls. Schema comparison includes every
table's foreign keys, and every index's name, unique/partial flags and ordered
columns, including autoindexes for table-level uniqueness. Table column order
stays ignored. Adoption is always followed by apply and a comparison of every
old value, including two distinct custom values on two contacts. With only the
baseline, the production preservation test requires and runs its fixtures;
missing or empty fixtures fail instead of checking zero files. The default
restoration fixture rebuilds contacts and restores dependent records, so the
lost custom values are what fail. To run
the deliberate destructive control as a failing test:

```bash
WRANGLER_SEND_METRICS=false WISER_MIGRATION_PLANTED_DROP=1 node --test --test-name-pattern='preservation fixture: rebuilding contacts without cf_test is detected' tests/migrations.test.mjs
```

Do not publish keys or tokens from scratch. The helpers print request paths,
statuses and port cleanup, never credentials. Scratch directories remain for
inspection; remove them only when no concurrent run is using them.
