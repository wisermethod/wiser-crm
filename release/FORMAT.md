# Wiser CRM release, format 3

Format 3 carries the CRM and its public intake Worker in one Wiser CRM release.
The builder creates `<out>/wiser-crm/<version>/`, refusing an existing
release directory. Versions match
`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`.
The release base supplies the address; no local path or download address appears
in the manifest.

## Files and signature

- `manifest.json`: UTF-8 JSON, two-space indentation and a final LF.
- `manifest.sig`: raw 64-byte Ed25519 signature over the exact manifest bytes.
  It is absent from an unsigned build. A later operator-controlled signing step
  completes the release; see `release/sign.mjs` and [Sign a release](README.md#sign-a-release).
  The builder never creates a key or a signature.
- `files/<sha256>`: module, asset and migration-directory bytes, keyed by their
  lowercase 64-character SHA-256 hex digest, without an extension. Identical
  contents share one file, even across categories. No unreferenced files belong
  in this directory.

## Format 3

Read the numeric `format` field before choosing a schema. Apply the existing
format 2 rules to a 2, and the rules below to a 3. Refuse any other format.
The signature always covers the original manifest bytes. A format 2 release
retains its original bytes, path, signature and verification rules.

Format 3 retains the top-level fields `format`, `app`, `version`, `created`,
`source` and `checks`, in that order. The remaining field is `apps`. The
top-level `app` is still `wiser-crm` and names the release path and signing
key. App selection takes place inside that signed release. The Wiser CRM
release has exactly these two app entries, in the order shown. Each nested
object has the field set and key order shown. Digests and sizes are
illustrative.

```json
{
  "wiser-crm": {
    "worker": {
      "main_module": "index.js",
      "compatibility_date": "2025-04-01",
      "compatibility_flags": ["nodejs_compat"],
      "modules": [
        {"name": "index.js", "type": "application/javascript+module", "sha256": "<sha256>", "size": 0}
      ]
    },
    "assets": {
      "binding": "ASSETS",
      "config": {
        "html_handling": "auto-trailing-slash",
        "not_found_handling": "single-page-application",
        "run_worker_first": true
      },
      "files": [
        {"path": "/index.html", "sha256": "<sha256>", "size": 0, "content_type": "text/html; charset=utf-8"}
      ]
    },
    "bindings": {
      "d1": [{"name": "DB", "database": "crm"}, {"name": "INTAKE_DB", "database": "intake"}],
      "mail": []
    },
    "vars": {
      "required": ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "AGENT_CLIENT_ID", "WISER_INSTANCE", "WISER_READ_ONLY"],
      "optional": ["BRAND_NAME", "BRAND_ACCENT"]
    },
    "migrations": {
      "database": "crm",
      "table": "d1_migrations",
      "files": [
        {"name": "0001_baseline.sql", "sha256": "<sha256>", "size": 0}
      ]
    }
  },
  "wiser-crm-intake": {
    "worker": {
      "main_module": "worker.js",
      "compatibility_date": "2025-04-01",
      "compatibility_flags": [],
      "modules": [
        {"name": "worker.js", "type": "application/javascript+module", "sha256": "<sha256>", "size": 0}
      ],
      "bundle_inputs": ["intake/notice.ts", "intake/submissions.ts", "intake/throttle.ts", "intake/worker.ts"]
    },
    "assets": null,
    "bindings": {
      "d1": [{"name": "INTAKE_DB", "database": "intake"}],
      "mail": [{"name": "NOTICE", "destination_var": "NOTICE_TO", "sender_var": "NOTICE_FROM"}]
    },
    "vars": {
      "required": ["INTAKE_ORIGIN", "INTAKE_RETURN_URL", "NOTICE_TO", "NOTICE_FROM"],
      "optional": ["INTAKE_MAX_PER_ADDRESS_PER_DAY", "INTAKE_MAX_PER_HOUR", "CRM_URL", "NOTICE_FROM_NAME"]
    },
    "migrations": {
      "database": "intake",
      "table": "d1_migrations",
      "files": [
        {"name": "0001_intake.sql", "sha256": "<sha256>", "size": 0}
      ]
    }
  }
}
```

- An app can have no assets, represented by `assets: null`. Intake must use
  null. For that app, a verifier fetches only the other declared content and
  an installer omits both upload metadata for assets and the assets binding.
  Neither opens an assets upload session. CRM requires its `ASSETS` binding
  and files.
- The only database declarations for this release are the three shown.
  `database` is a logical ID. An install resolves `crm` and `intake` to
  distinct D1 database IDs, and both Workers receive the same ID for
  `intake`. The CRM applies its migrations to `crm` only. Intake owns the
  migrations that create the intake schema, and they apply once to `intake`
  before either Worker uses it. Each list starts with the named baseline,
  uses the `d1_migrations` table and retains the filename, order and hash
  rules below. A digest shared by apps is stored once.
- Each app can have at most one mail binding. The CRM has none. The intake
  declaration shown here pins the destination to the value of the required
  install input `NOTICE_TO`. The sender is the required install input
  `NOTICE_FROM` and is passed only as a Worker variable. Values and
  literal addresses are forbidden in the manifest, including configuration
  placeholders. Refuse a deploy with a missing or empty destination or
  sender. The Worker's plain-text `NOTICE_TO` must use the same address as
  the upload metadata's pin. The upload metadata part carries the following
  object in its `bindings` list as observed in S1. The angle-bracket string
  is substituted only at install time.

  ```json
  {"name":"NOTICE","type":"send_email","destination_address":"<NOTICE_TO install input>"}
  ```

- The variable declarations are exactly the names and required/optional
  lists shown, in that order. A format 3 release declares one of two variable
  sets. In the 0.2.0 set, the CRM's optional list is empty and intake's is
  `["INTAKE_MAX_PER_ADDRESS_PER_DAY", "INTAKE_MAX_PER_HOUR", "CRM_URL"]`.
  The set shown above adds the brand variables. Both apps in a release must
  use the same set. Before the first install write, require values
  for both apps' required inputs and refuse undeclared variable names.
  Use the forms under [Install variables](#install-variables). Preserve the
  CRM's existing empty-string setting for `WISER_READ_ONLY`. Omit an optional
  variable when the install omits it. No default values are serialized.
- The intake Worker is one bundled ECMAScript module. Its `bundle_inputs`
  list is the sorted, repository-relative Wrangler/esbuild input graph,
  including `intake/worker.ts`. Each input is an immediate `intake/` source
  file with a lowercase letter followed by lowercase letters, digits or
  hyphens and a `.ts` extension. The builder resolves metafile paths from
  the intake config directory, refuses imports or inputs outside that
  source set and requires the one self-contained JavaScript output. The
  checker also matches the declared source list to the emitted module's
  esbuild source section comments in the hashed bytes. This verifies
  ordinary build output and detects a mismatch between the list and the
  bundle. It relies on Wrangler's input evidence and source comments for
  provenance. Arbitrary JavaScript has no independently recoverable source
  graph.
- Both apps come from the same commit recorded under `source`. S10's
  bundle-input check covers both Workers and the CRM UI. The source, check,
  compatibility, path, MIME, byte limits and signature rules below still
  apply, including the 1 MiB manifest limit, 25 MiB per file and 64 MiB total
  counted across all records in both apps. Paths and module or migration
  names are unique within their list, and binding and variable names are
  unique within the Worker that uses them. Format 3 checks the documented
  ordering of all file lists.

## Install variables

The CRM uses these forms in formats 2 and 3. The brand variables are optional and appear in the newer format 3 set.

| Variable | Form the Worker enforces | Code |
| --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | The full address `https://<team>.cloudflareaccess.com`. Use a lowercase team label of 1–63 ASCII letters, digits or hyphens with an alphanumeric first and last character. Supply exactly that address, with no port, trailing slash or other URL parts. Access assertions must use this issuer. | [`worker/sign-in.ts`](../worker/sign-in.ts) `isConfigured` and `signIn` |
| `ACCESS_AUD` | A nonempty string of ASCII letters, digits, underscores or hyphens. Access assertions must include this audience. | [`worker/sign-in.ts`](../worker/sign-in.ts) `isConfigured` and `signIn` |
| `AGENT_CLIENT_ID` | An empty or missing value disables agent sign-in only. For agent sign-in it must exactly match the verified assertion's `common_name` when its `sub` is empty. Staff sign-in is unaffected. | [`worker/sign-in.ts`](../worker/sign-in.ts) `signIn` |
| `WISER_INSTANCE` | After verifying an Access assertion, `GET` and `HEAD /api/wiser/instance` return 503 if the name is empty or missing and report the value as supplied otherwise. Before this route, an unsigned request returns 401 when sign-in is configured, or 503 with `Sign-in is not configured.` when sign-in is unconfigured. | [`worker/sign-in.ts`](../worker/sign-in.ts) `signIn` |
| `WISER_READ_ONLY` | An empty string or exactly `false` allows writes, as does an unset value at runtime. Every other value activates read-only mode. | [`worker/sign-in.ts`](../worker/sign-in.ts) `signIn` |
| `BRAND_NAME` | 1–40 Unicode characters after trimming. Control characters, `<`, `>` and line breaks anywhere in the input are refused. An omitted or invalid value uses Wiser CRM in the navigation and page title. | [`worker/brand.ts`](../worker/brand.ts) `displayName` and `installBrand` |
| `BRAND_ACCENT` | Exactly `#` followed by six ASCII hexadecimal digits. The CRM fits light and dark tones to Mist's surfaces. An omitted or invalid value uses Mist's teal. | [`worker/brand.ts`](../worker/brand.ts) `installBrand` and `fitAccent` |

Format 3 also declares these intake Worker variables.

| Variable | Form the Worker enforces | Code |
| --- | --- | --- |
| `INTAKE_ORIGIN` | A nonempty string that exactly matches the request's `Origin` header. The literal `null` is refused. | [`intake/worker.ts`](../intake/worker.ts) `fetch` |
| `INTAKE_RETURN_URL` | A nonempty string accepted as the HTTP `Location` header value for the 303 response. The Worker applies the header constructor's checks without parsing the value as a URL. | [`intake/worker.ts`](../intake/worker.ts) `fetch` and `reply` |
| `NOTICE_TO` | A missing or empty value skips the notice. Any other string is passed as the destination to the mail binding without a syntax check. If sending ultimately fails, the Worker records a failed notice. | [`intake/notice.ts`](../intake/notice.ts) `sendNotice` |
| `NOTICE_FROM` | A missing or empty value skips the notice. Any other string is passed as the sender's email to the mail binding without a syntax check. If sending ultimately fails, the Worker records a failed notice. | [`intake/notice.ts`](../intake/notice.ts) `sendNotice` |
| `INTAKE_MAX_PER_ADDRESS_PER_DAY` | A value that converts via `Number()` to a positive safe integer. Missing or rejected values use 5. | [`intake/throttle.ts`](../intake/throttle.ts) `limit` and `saveWithinThrottle` |
| `INTAKE_MAX_PER_HOUR` | A value that converts via `Number()` to a positive safe integer. Missing or rejected values use 60. | [`intake/throttle.ts`](../intake/throttle.ts) `limit` and `saveWithinThrottle` |
| `CRM_URL` | If supplied and nonempty, the text is appended to the notice after removing CR, LF, U+2028 and U+2029. The Worker applies no URL syntax check. | [`intake/notice.ts`](../intake/notice.ts) `sendNotice`, `body` and `singleLine` |
| `NOTICE_FROM_NAME` | Optional in the newer format 3 set. 1–60 Unicode characters after trimming. Control characters, line breaks, angle brackets, double quotes, commas, semicolons, colons, at signs and backslashes anywhere in the input are refused. An omitted or invalid value uses Wiser CRM as the sender name. | [`intake/notice.ts`](../intake/notice.ts) `senderName` and `sendNotice` |

## Format 2

The format 2 manifest has exactly this shape and key order. Angle-bracket strings and
zero sizes below are explanatory; real digests, commits and sizes are measured.

```json
{
  "format": 2,
  "app": "wiser-crm",
  "version": "0.1.0",
  "created": "<UTC ISO timestamp>",
  "source": {
    "repository": "wisermethod/wiser-crm",
    "commit": "<40 lowercase hex characters>",
    "upstream_commit": "<40 lowercase hex characters>",
    "f1": {
      "count": 10,
      "limit": 10
    }
  },
  "checks": {
    "lockfile": "PASS",
    "install_log": "PASS",
    "bundle_inputs": "PASS"
  },
  "worker": {
    "main_module": "index.js",
    "compatibility_date": "2025-04-01",
    "compatibility_flags": ["nodejs_compat"],
    "d1_binding": "DB",
    "assets_binding": "ASSETS",
    "vars_required": ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "AGENT_CLIENT_ID", "WISER_INSTANCE", "WISER_READ_ONLY"],
    "modules": [
      {"name": "index.js", "type": "application/javascript+module", "sha256": "<sha256>", "size": 0}
    ]
  },
  "assets": {
    "config": {
      "html_handling": "auto-trailing-slash",
      "not_found_handling": "single-page-application",
      "run_worker_first": true
    },
    "files": [
      {"path": "/index.html", "sha256": "<sha256>", "size": 0, "content_type": "text/html; charset=utf-8"}
    ]
  },
  "migrations": {
    "table": "d1_migrations",
    "files": [
      {"name": "0001_baseline.sql", "sha256": "<sha256>", "size": 0}
    ]
  }
}
```

Each file record names a digest and a nonnegative integer byte length. Module
names are relative module specifiers; asset paths are absolute URL paths.
Modules and assets sort by relative filename, recursively, using case-sensitive
lexical order. `main_module` names the one entry in Wrangler's esbuild output
metadata for the configured Worker entry. The module list contains the files
Wrangler emits for upload; its generated `README.md`, `meta.json` and source maps
are build evidence rather than Worker modules.

Module `type` is the Cloudflare multipart part MIME type, derived from the
emitted file extension: `.js` and `.mjs` are
`application/javascript+module`, `.cjs` is `application/javascript`, `.wasm` is
`application/wasm`, `.txt` and `.html` are `text/plain`, and `.bin` is
`application/octet-stream`. An unknown extension stops assembly rather than
guessing a type. These names match Wrangler 4.93.1's `moduleTypeMimeType` mapping
in `wrangler-dist/cli.js`. Assets retain format 1's per-file `content_type`.

The source count is the number of upstream-tracked paths modified or deleted
at the built commit, with renames disabled:
`git diff --name-only --no-renames --diff-filter=MD <upstream_commit> <commit>`.
`upstream_commit` is `git merge-base <commit> clawnify/main` in the source fork
at build time. The limit is the operator-supplied `--f1-limit`. An excess stops
assembly. All three checks must print their own PASS verdict and exit zero;
anything else stops assembly. Their names refer to S10's unchanged lockfile,
clean-install-log and combined Worker/UI-input checks.

The migration table is read from the Wrangler table DDL documented in
`migrations/README.md`. Only the numbered SQL files in that directory are
carried, unchanged, sorted by numeric prefix with lexical ties: they are what
Wrangler executes. The README and the adoption helper beside them are not part
of a release, and an unnumbered `.sql` file stops assembly.
Filenames are migration identity. A consumer preserves Wrangler's table and
history semantics described in that README, including recording applied SQL
filenames rather than introducing a second migration history.

## Format 2 changes from format 1

`WISER_INSTANCE` is the install's connection label. The instance response
reports it alongside the verified caller, the read-only boolean and the
release version embedded by `release/build.mjs`. Other builds use `dev`.
`WISER_READ_ONLY` stops writing methods and writing GET/HEAD routes during
an upgrade. See [Install variables](#install-variables) for the accepted values.

1. `format` becomes 2 because a format-1 validator rejects both the new fields
   and any migration. The provisional connector proof needs a format-2 consumer
   before it can accept this release.
2. `source` records the fork and upstream commits and F1's count and limit so a
   signed manifest identifies exactly what was built and the limit it met.
3. `checks` records three mandatory PASS verdicts so the release carries the
   checks that blocked its assembly. These are builder assertions, backed by
   retained logs and input records, not independent attestations.
4. `worker.vars_required` carries variable names, in configuration order, read
   from `wrangler.wiser.jsonc`. An install supplies values; no value or identity
   credential enters the manifest.
5. `assets.config.run_worker_first` is true as configured, preserving the
   wrapper's verification before static asset handling. Other Worker and asset
   fields retain format 1's meaning; HTML handling defaults to Cloudflare's
   `auto-trailing-slash` when the config leaves it unset.
6. `migrations` becomes `{ table, files }` because this release has a Wrangler
   migration history and migration bytes to carry. Their storage and digest
   rules are the same as modules and assets.
7. `manifest.sig` is absent until the operator signs. The signature algorithm,
   exact signed bytes, content-addressed layout and `<app>/<version>/` layout
   remain format 1's. The builder creates no key.
