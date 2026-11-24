# Tests

Run from the repository root with the existing pnpm dependencies installed and
a Node version that can run the TypeScript unit tests directly. No test needs a
Cloudflare account, a deploy, or a published Clawnify package. Do not install or
open those packages; the fork uses its own `runtime/` links.

Run every suite in sequence to avoid contention between the local Workers:

```bash
for suite in tests/*.test.mjs intake/*.test.* worker/*.test.* worker/dev/*.test.ts release/*.test.mjs; do
  WRANGLER_SEND_METRICS=false node --test "$suite" || break
done
```

Run any suite individually:

```bash
WRANGLER_SEND_METRICS=false node --test tests/records.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/sign-in.e2e.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/instance.e2e.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/import.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/migrations.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/m2c-regressions.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/intake.e2e.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/intake-m1.e2e.test.mjs
WRANGLER_SEND_METRICS=false node --test tests/intake-bundle.test.mjs
node --test tests/theme.test.mjs
node --test tests/theme-contrast.test.mjs
node --test intake/worker.test.ts
node --test intake/notice.test.mjs
node --test worker/sign-in.test.ts
node --test worker/brand.test.mjs
node --test worker/instance.test.ts
node --test worker/dev/index.test.ts
node --test release/build.test.mjs
node --test release/clawnify-free.test.mjs
node --test release/sign.test.mjs
node --test release/upstream-report.test.mjs
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
| `tests/intake.e2e.test.mjs` | The public intake and CRM Workers share one intake D1, alongside the CRM's own D1. Covers the six fields a visitor types and the page path the form carries, take-in, claims, note read-back and retry, import parity, company isolation, routing, response privacy, read-only and retention. |
| `tests/intake-m1.e2e.test.mjs` | The real intake and CRM Workers enforce the honeypot and both throttle caps, process leads oldest first in batches of up to 50, and erase visitor fields and expired throttle data. D1-backed fixtures exercise UTC rollover, failed notice notes and notices still in flight. |
| `tests/intake-bundle.test.mjs` | Wrangler's dry-run metafile excludes CRM and Hono inputs. The intake config binds its D1 and one pinned mail destination, and the fork still edits ten upstream files. |
| `tests/theme.test.mjs` | Resolves tokens in cascade order and checks `DESIGN.wiser.md`, the overlay selector rules, literal inlining and the primary pill's class pair. |
| `tests/theme-contrast.test.mjs` | Checks all 152 Mist pairings against resolved light and dark CSS tokens, including text, focus, boundaries and decorative rules. Set `WISER_THEME_CONTRAST_REPORT=1` to print the ratio table. |
| `intake/worker.test.ts` | The body cap stops reading even with a false length, the exact limit is accepted, malformed forms get a generic refusal, and missing configuration returns 503. |
| `intake/notice.test.mjs` | A local send stand-in checks save-before-send, exact structured notice text and headers, the submitted page path and Referer fallback, configured recipient, valid and malformed sender names, outcomes, retry behavior and no send on throttled or honeypot posts. |
| `worker/sign-in.test.ts` | Wrapper policy in isolation with real token verification and runtime identity: all sign-in pass-list cases except bundle/install/count cases 7 to 9, plus algorithm restrictions, key rotation, configuration, concurrent identities, and downstream-call isolation. |
| `worker/brand.test.mjs` | Fits 223 colours to Mist’s accent roles in both modes, including greys and saturated boundary colours. Checks the brand’s independent validation and fallbacks. |
| `worker/instance.test.ts` | Signed-in and unsigned brand responses, instance identity and unnamed refusal; authentication before policy; writable unset/empty/false and fail-closed flags; all 12 writing GET routes and their HEAD equivalents; downstream isolation and reads/assets during upgrades. |
| `tests/instance.e2e.test.mjs` | Instance and upgrade policy through the real local Worker for staff and agent, plus an exact inventory of every live upstream GET route against the wrapper's read/write classification. Re-audit existing handlers and helpers when upstream changes them; the inventory catches new routes, not changed effects on an existing path. |
| `tests/release-instance.test.mjs` | Always checks format 2 and the published format 3 variable set. With `WISER_TEST_RELEASES` below, also checks `OWNER_EMAIL` required only for the CRM, F1 10, all release checks PASS, and the embedded version and verified caller through each emitted production Worker. |
| `worker/dev/index.test.ts` | Local-host and enable-flag guards, local sign-in cookie behavior, cross-site refusal, assertion precedence, cookie removal, missing keys and invalid credentials. |
| `release/clawnify-free.test.mjs` | Synthetic fixtures for the lockfile, install-log and bundle-input checks, including refusal of registry packages, disguised paths and invalid evidence. See `release/README.md` for release evidence commands; these unit tests do not perform an install. |
| `release/upstream-report.test.mjs` | Scratch upstream/fork histories, clean and conflicting trial merges, F10/F1 stops, frozen-lockfile failures, independent checks, metadata-only licence watch, workflow warnings, unchanged caller refs/index/worktrees and cleanup. Every network and package-manager operation is stubbed. Optional break-and-restore controls: `WISER_REPORT_CONTROLS=1 node --test release/upstream-report.test.mjs`. |

`tests/local-worker.mjs` is the shared integration harness, not a test file. It
starts the real `worker/dev/index.ts` using Wrangler's `unstable_startWorker`,
then sends HTTP requests to `127.0.0.1` on an assigned free port. It generates an
RS256 key pair and JWKS for each run, authenticates only through tokens verified
by the real wrapper, and migrates fresh local D1 state using Wrangler
`d1 migrations apply --local --persist-to`. It reads the live OpenAPI document
before any scenario. No application or identity implementation is mocked.

Keys, configuration, databases and build scratch stay under
`wiser-crm-local-tests/` in the invoking environment's `TMPDIR`. Metrics, environment-file loading, remote bindings,
inspector, watching and external Worker fetches are disabled. Teardown disposes
the Worker after success or failure and checks its public port is closed. The
non-local Host case still connects only to `127.0.0.1`; the local entry returns
403 before token verification. Pass-list case 10 is
`worker/sign-in.test.ts`'s `workers.dev` case: an address Access does not cover
reaches the wrapper without a credential, gets 401, and calls neither app nor
assets. The foreign-Host integration check proves only the local entry guard.

The intake suite asks the harness to start a second `unstable_startWorker` on a
separate loopback port. Both Workers use the same local persistence path and
intake database ID. Wrangler applies the CRM and intake migrations from their
own configurations. The harness omits the deployed mail binding from its
scratch configuration and uses Wrangler's installed Miniflare for direct D1
assertions and fixture setup.

`tests/migration-helpers.mjs` is the migration suite's shared helper. Its scratch
root is `wiser-crm-migration-tests/` under `TMPDIR`; it uses local Wrangler migrations and
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

After building two real releases as `release/README.md` describes, run the
production bundles locally, with their JWKS fetch intercepted by the harness:

```bash
WRANGLER_SEND_METRICS=false WISER_TEST_RELEASES=/absolute/out1/wiser-crm/0.3.2,/absolute/out2/wiser-crm/0.3.2 node --test tests/release-instance.test.mjs
```

This verifies the bytes stored by the release builder (including their hashes
and sizes), without a deployment or a request to an external key server.

## When a suite fails on the local harness

A failure reading `SQLITE_BUSY`, "Your worker restarted mid-request" or a stray
503 where another status was expected can be the local harness and not the code
under test. Run that suite once more and count it failing only if it fails
again.

Look before rerunning when the same line fails more than once. A handler that
answers before it has read the whole request body makes the next request on
that connection fail with "Your worker restarted mid-request", about one run in
three. Read or cancel the body before answering, as `worker/people.ts` `drain`
does for a refused oversized body.

A Worker's own D1 call can fail while a test's inspection client reads the same
database file, with `D1_ERROR: Failed to parse body as JSON, got: Error:
internal error; reference = …`. Miniflare raises it after the statement has
run, so a write may already have committed. Code that retries it must be safe
to run twice, as `worker/take-in.ts` is. A test of such a retry lets the real
statement commit before it throws, as `failAfterCommit` in
`tests/intake.e2e.test.mjs` does. A background job that discards its rejection
leaves no other trace, so log the discarded error while diagnosing it.

The harness silences every Worker's output (`WRANGLER_LOG: 'none'` and
`logLevel: 'none'` in `tests/local-worker.mjs`), so a temporary log line in a
Worker prints nothing through it. A trace raises both for its own run, and adds
one control line on a path every run takes. Read a silent trace as a result
only once that control line has printed.
