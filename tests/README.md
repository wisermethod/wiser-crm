# Tests

Run from the repository root with the existing pnpm dependencies installed and
a Node version that can run the TypeScript unit tests directly. No test needs a
Cloudflare account, a deploy, or a published Clawnify package. Do not install or
open those packages; the fork uses its own `runtime/` links.

Run every suite:

```bash
WRANGLER_SEND_METRICS=false node --test tests/records.test.mjs tests/sign-in.e2e.test.mjs tests/import.test.mjs tests/migrations.test.mjs worker/sign-in.test.ts worker/dev/index.test.ts release/clawnify-free.test.mjs
```

Run any suite individually:

```bash
WRANGLER_SEND_METRICS=false node --test tests/records.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/sign-in.e2e.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/import.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/migrations.test.mjs
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
| `tests/sign-in.e2e.test.mjs` | Pass-list cases 1 to 6, 10 and 11 through the running local Worker: missing/forged/expired/wrong-audience/wrong-issuer tokens, supplied identity headers, public job routes including an encoded path, person/agent contact reads, non-local Host refusal, and three platform-only routes. Each request's expected HTTP status is explicit. |
| `tests/import.test.mjs` | Three contacts followed by two overlapping and one new row leave four contacts; matching ignores case, fills a missing phone and preserves existing nonblank values and status. Same email with another first name creates a fifth contact and leaves the earlier records unchanged. |
| `tests/migrations.test.mjs` | Frozen baseline equality, working-schema drift, idempotent apply/adoption, safe refusal of partial adoption, and preservation of seeded records and custom columns through each later migration. Passing and destructive fixtures exercise the preservation checker even with a baseline-only chain. |
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
403 before token verification. Production-address 401 policy is also covered
by `worker/sign-in.test.ts`, independently of that local guard.

`tests/migration-helpers.mjs` is the migration suite's shared helper. Its scratch
root is `/private/tmp/wiser-crm-m2a/`; it uses local Wrangler migrations and
`getPlatformProxy`, disposing every proxy. The SQL files in
`tests/fixtures/migrations/` are the additive and destructive controls. To run
the deliberate destructive control as a failing test:

```bash
WRANGLER_SEND_METRICS=false WISER_MIGRATION_PLANTED_DROP=1 node --test --test-name-pattern='preservation fixture: rebuilding contacts without cf_test is detected' tests/migrations.test.mjs
```

Do not publish keys or tokens from scratch. The helpers print request paths,
statuses and port cleanup, never credentials. Scratch directories remain for
inspection; remove them only when no concurrent run is using them.
