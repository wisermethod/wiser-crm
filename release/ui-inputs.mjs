#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repo = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
if (process.argv.length !== 3) {
  console.error('usage: node release/ui-inputs.mjs <inputs.json outside repository>');
  process.exit(2);
}
const output = path.resolve(process.argv[2]);
// Resolve the parent before writing so a symlink cannot send this into the repo.
const parent = fs.realpathSync(path.dirname(output));
const target = path.join(parent, path.basename(output));
if (target === repo || target.startsWith(repo + path.sep) || fs.existsSync(target)) {
  console.error('inputs output must be a new file outside the repository');
  process.exit(2);
}
const chunks = [];
process.chdir(repo);
await build({
  root: repo,
  configFile: path.join(repo, 'vite.config.ts'),
  // Keep upstream's config and its plugins; append only the metadata recorder.
  plugins: [{
    name: 'wiser-release-inputs',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) if (output.type === 'chunk') {
        chunks.push({ fileName: output.fileName, modules: Object.keys(output.modules).sort() });
      }
    },
  }],
});
if (!chunks.length) throw new Error('Vite emitted no chunks');
fs.writeFileSync(target, JSON.stringify({ root: repo, chunks }, null, 2) + '\n', { flag: 'wx' });
console.log(`UI inputs: ${target}; ${chunks.length} chunk(s), ${chunks.reduce((n, c) => n + c.modules.length, 0)} module entries`);
