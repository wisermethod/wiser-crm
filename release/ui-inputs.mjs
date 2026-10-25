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
const chunks = [], assets = [], publicFiles = [];
let publicDir;
// Record lexical paths as well as letting C resolve them: a scope-named file
// or an escaping public symlink must not disappear from the input evidence.
function publicInputs(dir, ancestors = new Set()) {
  const real = fs.realpathSync(dir);
  if (ancestors.has(real)) throw new Error(`publicDir symlink cycle: ${dir}`);
  const next = new Set([...ancestors, real]);
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) publicInputs(file, next);
    else publicFiles.push(file);
  }
}
process.chdir(repo);
await build({
  root: repo,
  configFile: path.join(repo, 'vite.config.ts'),
  // Release checkouts start clean; recording also preserves any prior outputs.
  build: { emptyOutDir: false },
  // Keep upstream's config and its plugins; append only the metadata recorder.
  plugins: [{
    name: 'wiser-release-inputs',
    configResolved(config) { publicDir = config.publicDir; },
    // Later generateBundle hooks can still emit assets (including Vite HTML).
    writeBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') chunks.push({ fileName: output.fileName, modules: Object.keys(output.modules).sort() });
        else if (output.type === 'asset') {
          // Rollup versions expose the plural field or the older singular one.
          const origins = output.originalFileNames ?? (output.originalFileName ? [output.originalFileName] : []);
          assets.push({ fileName: output.fileName, originalFileNames: [...new Set(origins)].sort() });
        }
      }
      if (publicDir) {
        try { fs.lstatSync(publicDir); }
        catch (e) { if (e.code === 'ENOENT') return; throw e; }
        publicInputs(publicDir);
      }
    },
  }],
});
if (!chunks.length) throw new Error('Vite emitted no chunks');
fs.writeFileSync(target, JSON.stringify({ root: repo, chunks, assets, publicFiles }, null, 2) + '\n', { flag: 'wx' });
console.log(`UI inputs: ${target}; ${chunks.length} chunk(s), ${chunks.reduce((n, c) => n + c.modules.length, 0)} module entries`);
