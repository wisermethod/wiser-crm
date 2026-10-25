# Wiser CRM release, format 2

This extends the Cloudflare Worker proof's provisional format 1 for a real Wiser
CRM release. The builder creates `<out>/wiser-crm/<version>/`, refusing an existing
release directory. Versions match
`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`.
The release base supplies the address; no local path or download address appears
in the manifest.

## Files and signature

- `manifest.json`: UTF-8 JSON, two-space indentation and a final LF.
- `manifest.sig`: raw 64-byte Ed25519 signature over the exact manifest bytes.
  It is absent from an unsigned build. A later operator-controlled signing step
  completes the release; the builder never creates a key or a signature.
- `files/<sha256>`: module, asset and migration-directory bytes, keyed by their
  lowercase 64-character SHA-256 hex digest, without an extension. Identical
  contents share one file, even across categories. No unreferenced files belong
  in this directory.

The manifest has exactly this shape and key order. Angle-bracket strings and
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
    "vars_required": ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "AGENT_CLIENT_ID"],
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

## Changes from format 1

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
   remain format 1's. No key is created by building or testing.
