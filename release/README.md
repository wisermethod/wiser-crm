# Release checks

Run from a clean checkout with an empty pnpm store and cache. Use the same checkout for all three checks and keep the NDJSON install log and both input records with the release evidence.

1. `node release/clawnify-free.mjs lockfile .`
2. `pnpm install --frozen-lockfile --reporter=ndjson > /absolute/scratch/install.ndjson`, then `node release/clawnify-free.mjs install-log . /absolute/scratch/install.ndjson`.
3. `node release/ui-inputs.mjs /absolute/scratch/ui-inputs.json`, then `WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --config wrangler.wiser.jsonc --outdir /absolute/scratch/worker --metafile /absolute/scratch/worker-meta.json`, then `node release/clawnify-free.mjs bundle-inputs . /absolute/scratch/worker-meta.json /absolute/scratch/ui-inputs.json`.

A release build is blocked when any check prints FAIL or exits nonzero. Run `node --test release/clawnify-free.test.mjs` before using the checks; also prove each check fails against a local stand-in installed under a Clawnify name. Never fetch the published scope packages for a control.

The lockfile check permits scope aliases only through links into our runtime.
The install-log check permits only the root manifest and runtime-link events to
name the scope, including encoded names. A runtime link is trusted only after its tree is walked with `lstat`: every nested link must exist and resolve inside
`runtime/`. The bundle check covers chunk modules, emitted asset origins and
files under Vite's configured `publicDir`. NUL-prefixed file IDs receive the
same scope, ownership and lockfile-pin checks as other paths. Only the named
pathless helpers and the two absent Wrangler virtual modules in the exact
locked package directory have fixed exceptions. These checks read metadata
and resolve paths, never package source.

Each check covers only the strings and paths it resolves. Contents, copied code and other builders' records are outside them. The checks do not establish
runtime behavior or authenticate supplied evidence. Rebuild from the release
checkout; do not reuse old logs or input records. The parser accepts pnpm
lockfile version 9.0 block mappings and plain or single-quoted scalar block
sequences, scanning every value for the scope. It rejects other unread syntax,
backslashes, block scalars, duplicate mapping keys and any file whose first
non-comment line is not `lockfileVersion: '9.0'`.

## Build a release of a commit

The unsigned release contract is [FORMAT.md](FORMAT.md), format 2. Run the
builder from this fork, with its existing Node and pnpm tools available:

```sh
node --test release/build.test.mjs release/clawnify-free.test.mjs
TMPDIR=/absolute/scratch node release/build.mjs \
  --commit <40-character-fork-commit> --version 0.1.0 \
  --out /absolute/output/outside-the-repository --f1-limit 10
```

The builder clones with `--no-hardlinks`, checks out the commit detached and
requires a clean tree. It installs the frozen lockfile into a new empty store
and cache, runs the three S10 checks, builds both bundles, and counts
upstream files against `git merge-base <commit> clawnify/main` in this fork.
That ref must already exist locally; the builder never fetches it. A safety
preflight refuses scope registry dependencies before installation; it permits
local `file:` stand-ins for control runs. Any failed check or excessive F1 count
blocks assembly. An invalid argument or existing release destination is refused.

Each run keeps its checkout, install NDJSON, check outputs, UI input record,
Wrangler metadata, build logs and F1 list in a new `wiser-crm-build-*` directory
under `TMPDIR`. Its location is printed on stderr. Stores, caches, XDG state and
Wrangler logs are isolated there; Wrangler metrics are disabled and its only
deployment command is a dry run. Stdout contains one JSON result with the release
directory, manifest digest, unique file count and bytes, check verdicts and F1
count. The manifest records the built commit, configuration, modules, assets and
every migration-directory file, each stored by content digest.

The result is `<out>/wiser-crm/<version>/manifest.json` and `files/`, with no
`manifest.sig`. Building and testing create no signing key and no signature.
The operator's later signing step completes the release. To compare two builds,
use different output bases and ignore only the manifest's `created` field;
retain and report any other differences.
