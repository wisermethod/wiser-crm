# Release checks

Run from a clean checkout with an empty pnpm store and cache. Use the same checkout for all three checks and keep the NDJSON install log and both input records with the release evidence.

1. `node release/clawnify-free.mjs lockfile .`
2. `pnpm install --frozen-lockfile --reporter=ndjson > /absolute/scratch/install.ndjson`, then `node release/clawnify-free.mjs install-log . /absolute/scratch/install.ndjson`.
3. `node release/ui-inputs.mjs /absolute/scratch/ui-inputs.json`, then `WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --config wrangler.wiser.jsonc --outdir /absolute/scratch/worker --metafile /absolute/scratch/worker-meta.json`, then `node release/clawnify-free.mjs bundle-inputs . /absolute/scratch/worker-meta.json /absolute/scratch/ui-inputs.json`.

A release build is blocked when any check prints FAIL or exits nonzero. Run `node --test release/clawnify-free.test.mjs` before using the checks; also prove each check fails against a local stand-in installed under a Clawnify name. Never fetch the published scope packages for a control.

The lockfile check permits scope aliases only through links into our runtime. The install-log check permits only the root manifest and runtime-link events to name the scope, including encoded names. The bundle check permits our files, dependencies pinned in the lockfile and the fixed bundler-internal IDs documented in the script. It reads metadata and resolves paths, never package source.

These checks prove the recorded install and bundle inputs exclude the seven published Clawnify packages. They do not inspect dependency contents, detect code copied into another name, prove runtime behavior, or authenticate records supplied by another builder. Rebuild from the release checkout; do not reuse old logs or input records. The parser supports pnpm lockfile version 9.0.
