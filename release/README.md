# Release checks

Run from a clean checkout with an empty pnpm store and cache. Use the same checkout for all three checks and keep the NDJSON install log and both input records with the release evidence.

1. `node release/clawnify-free.mjs lockfile .`
2. `pnpm install --frozen-lockfile --reporter=ndjson > /absolute/scratch/install.ndjson`, then `node release/clawnify-free.mjs install-log . /absolute/scratch/install.ndjson`.
3. `node release/ui-inputs.mjs /absolute/scratch/ui-inputs.json`, then `WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --config wrangler.wiser.jsonc --outdir /absolute/scratch/worker --metafile /absolute/scratch/worker-meta.json`, then `node release/clawnify-free.mjs bundle-inputs . /absolute/scratch/worker-meta.json /absolute/scratch/ui-inputs.json`.

A release build is blocked when any check prints FAIL or exits nonzero. Run `node --test release/clawnify-free.test.mjs` before using the checks; also prove each check fails against a local stand-in installed under a Clawnify name. Never fetch the published scope packages for a control.

The lockfile check permits scope aliases only through links into our runtime. The install-log check permits only the root manifest and runtime-link events to name the scope, including encoded names. The bundle check permits our files, dependencies pinned in the lockfile and the fixed bundler-internal IDs documented in the script. It reads metadata and resolves paths, never package source.

These checks prove the recorded install and bundle inputs exclude the seven published Clawnify packages. They do not inspect dependency contents, detect code copied into another name, prove runtime behavior, or authenticate records supplied by another builder. Rebuild from the release checkout; do not reuse old logs or input records. The parser supports pnpm lockfile version 9.0.

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
and cache, runs the three unchanged S10 checks, builds both bundles, and counts
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
