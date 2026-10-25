#!/usr/bin/env node
// Dependency-free checks of metadata only. No package source is opened.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const groups = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
const aliases = new Set(['app', 'connections', 'db', 'queue', 'services']);
const inside = (p, root) => p === root || p.startsWith(root + path.sep);
const unquote = s => s.replace(/^(['"])(.*)\1$/, '$2');
// Decode repeatedly so mixed-case and nested URL encoding cannot hide a name.
function decoded(s) {
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (next === s) break;
    s = next;
  }
  return s;
}
const scoped = s => /@clawnify/i.test(decoded(s));
function metadataPath(p) {
  const real = fs.realpathSync(p);
  if ([path.resolve(p), real].some(candidate => candidate.split(path.sep).some(s => /^(node_modules|\.pnpm|\.pnpm-store|stores?|memory)$/i.test(s)) || /^\.env(?:\.|$)/i.test(path.basename(candidate)))) {
    throw new Error(`refusing to open protected input: ${p}`);
  }
  return real;
}
function read(p) {
  const real = metadataPath(p);
  console.log(`read: ${real}`);
  return fs.readFileSync(real, 'utf8');
}
function realOrResolved(p) {
  // realpath reads directory metadata, never file contents; links cannot escape runtime/.
  try { return fs.realpathSync(p); }
  catch (e) { if (e.code === 'ENOENT') return path.resolve(p); throw e; }
}
function runtimeLink(repo, from, value) {
  if (typeof value !== 'string' || !value.startsWith('link:')) return false;
  const target = realOrResolved(path.resolve(from, value.slice(5)));
  return inside(target, path.join(repo, 'runtime')) && target !== path.join(repo, 'runtime');
}

// pnpm v9 writes block mappings with quoted package keys. This intentionally
// parses only that format; a different version/shape fails closed, not via a
// permissive YAML loader with dependencies or package-source reads.
function lockRows(text) {
  if (!/^lockfileVersion:\s*['"]?9\.0['"]?\s*$/m.test(text)) throw new Error('expected pnpm lockfileVersion 9.0');
  const rows = [], stack = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^( *)(?:(['"])(.*?)\2|([^'"].*?)):\s*(.*)$/.exec(line);
    if (!m) {
      if (scoped(line)) rows.push({ line: i + 1, key: '', value: line, parents: [] });
      continue;
    }
    const row = { line: i + 1, indent: m[1].length, key: m[3] ?? m[4], value: unquote(m[5]), parents: [] };
    while (stack.length && stack.at(-1).indent >= row.indent) stack.pop();
    row.parents = [...stack];
    rows.push(row);
    stack.push(row);
  }
  return rows;
}
export function lockfile(repo, text) {
  const rows = lockRows(text), findings = [];
  for (const row of rows) {
    const section = row.parents[0]?.key;
    if (scoped(row.key)) {
      if (['packages', 'snapshots'].includes(section)) {
        findings.push(`line ${row.line}: ${section} key names the scope: ${row.key}`);
      } else if (section === 'importers' && row.parents.length === 3 && groups.has(row.parents[2].key)) {
        const children = rows.filter(r => r.parents.at(-1) === row);
        const version = children.find(r => r.key === 'version');
        const from = path.resolve(repo, row.parents[1].key);
        if (!version || !version.value.startsWith('link:')) {
          findings.push(`line ${version?.line ?? row.line}: importer resolves ${row.key} to ${version?.value ?? '(missing link: version)'}`);
        } else if (!runtimeLink(repo, from, version.value)) {
          findings.push(`line ${version.line}: link outside runtime/: ${row.key} -> ${version.value}`);
        }
        const spec = children.find(r => r.key === 'specifier');
        if (spec && !runtimeLink(repo, from, spec.value)) findings.push(`line ${spec.line}: importer specifier is not a runtime link: ${row.key} -> ${spec.value}`);
      } else findings.push(`line ${row.line}: unexpected scope key: ${row.key}`);
    }
    if (scoped(row.value)) findings.push(`line ${row.line}: tarball or resolution/value names the scope: ${row.key}: ${row.value}`);
  }
  if (!rows.some(r => r.key === 'importers' && r.parents.length === 0)) findings.push('line 1: missing importers mapping');
  return findings;
}

// Include keys as well as values: manifest dependency names are JSON keys.
function strings(obj, trail = [], out = []) {
  if (typeof obj === 'string') out.push({ trail, value: obj, isKey: false });
  else if (obj && typeof obj === 'object') for (const [key, value] of Object.entries(obj)) {
    out.push({ trail: [...trail, key], value: key, isKey: true });
    strings(value, [...trail, key], out);
  }
  return out;
}
export function installLog(repo, text) {
  const findings = [];
  let events = 0;
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`invalid NDJSON at line ${i + 1}`); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.name !== 'string') throw new Error(`invalid event at line ${i + 1}`);
    events++;
    const refs = strings(event).filter(r => scoped(r.value));
    for (const ref of refs) {
      const t = ref.trail;
      let allowed = false;
      if (event.name === 'pnpm:package-manifest' && typeof event.prefix === 'string' && realOrResolved(event.prefix) === repo && ['initial', 'updated'].includes(t[0])) {
        const manifest = event[t[0]];
        if (manifest?.name === '@clawnify/open-crm') {
          if (!ref.isKey && t.length === 2 && t[1] === 'name' && ref.value === '@clawnify/open-crm') allowed = true;
          if (t.length === 3 && groups.has(t[1]) && /^@clawnify\//i.test(t[2])) {
            const name = t[2].slice('@clawnify/'.length);
            const value = manifest[t[1]][t[2]];
            allowed = aliases.has(name) && value === `link:./runtime/${name}` && runtimeLink(repo, repo, value);
            if (!allowed) findings.push(`line ${i + 1}: manifest scope dependency is not an allowed runtime link: ${t[2]} -> ${value}`);
          }
        }
      } else if (event.name === 'pnpm:root' && !ref.isKey && t.length === 2 && t[1] === 'name' && /^@clawnify\/[^/]+$/i.test(ref.value)) {
        const linkedFrom = event[t[0]]?.linkedFrom;
        allowed = typeof linkedFrom === 'string' && inside(realOrResolved(path.resolve(repo, linkedFrom)), path.join(repo, 'runtime'));
        if (!allowed) findings.push(`line ${i + 1}: pnpm:root missing linkedFrom under runtime/: ${ref.value} -> ${linkedFrom ?? '(missing)'}`);
      }
      if (!allowed) findings.push(`line ${i + 1}: ${event.name} unexpected scope at $.${t.join('.')}: ${ref.value}`);
    }
  }
  if (!events) findings.push('line 1: no install events');
  return findings;
}

// Fixed bundler-internal categories. Rollup reserves NUL-prefixed ids for
// synthetic modules (Vite helpers and CommonJS proxies); these are not files.
// Vite also emits its preload helper under this exact non-NUL id.
const internalIds = [id => id.startsWith('\0'), id => id === 'vite/preload-helper.js'];
// Wrangler's handleNodeJSGlobals synthesizes these two onLoad modules under its
// package directory, without creating files. Permit exactly these basenames,
// only for Worker inputs and only beneath the locked Wrangler package.
const wranglerVirtualNames = new Set([
  '_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-console',
  '_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-process',
]);
function wranglerVirtual(repo, id, pins) {
  const absolute = path.resolve(repo, id);
  const parts = path.relative(repo, absolute).split(path.sep);
  if (parts.length !== 6 || parts[0] !== 'node_modules' || parts[1] !== '.pnpm' || parts[3] !== 'node_modules' || parts[4] !== 'wrangler' || !wranglerVirtualNames.has(parts[5])) return false;
  if (!pins.some(p => p.name === 'wrangler' && (parts[2] === `wrangler@${p.version}` || parts[2].startsWith(`wrangler@${p.version}_`)))) return false;
  try { return fs.realpathSync(path.dirname(absolute)) === path.dirname(absolute); } catch { return false; }
}
function packagePins(text) {
  return lockRows(text).filter(r => r.parents.length === 1 && r.parents[0].key === 'packages').map(r => {
    const m = /^(@[^/]+\/[^@]+|[^@/]+)@([^()]+)(?:\(.*\))?$/.exec(r.key);
    return m && { name: m[1], version: m[2] };
  }).filter(Boolean);
}
export function bundleInputs(repo, lockText, worker, ui) {
  const pins = packagePins(lockText), findings = [];
  if (!worker?.inputs || typeof worker.inputs !== 'object' || Array.isArray(worker.inputs)) throw new Error('Worker metafile must have an inputs object');
  if (!ui || ui.root !== repo || !Array.isArray(ui.chunks) || !ui.chunks.length) throw new Error('UI input record must have this repository root and nonempty chunks');
  const workerIds = Object.keys(worker.inputs);
  if (!workerIds.length) findings.push('worker: no bundle inputs');
  const entries = workerIds.map(id => ['worker', id]);
  for (const chunk of ui.chunks) {
    if (typeof chunk.fileName !== 'string' || !Array.isArray(chunk.modules) || !chunk.modules.length || chunk.modules.some(id => typeof id !== 'string')) throw new Error('invalid or empty UI chunk modules');
    entries.push(...chunk.modules.map(id => [`ui:${chunk.fileName}`, id]));
  }
  for (const [source, id] of entries) {
    const label = `${source}: ${JSON.stringify(id)}`;
    // Strip only Vite's query suffix. Resolve links before deciding ownership.
    const file = id.split('?')[0];
    const real = id.includes('\0') ? null : (() => { try { return fs.realpathSync(path.resolve(repo, file)); } catch { return null; } })();
    if (scoped(id) || (real && scoped(real))) {
      if (real && inside(real, path.join(repo, 'runtime'))) continue;
      findings.push(`${label}: scope input outside runtime/`);
      continue;
    }
    if (internalIds.some(accept => accept(id))) continue;
    if (source === 'worker' && wranglerVirtual(repo, id, pins)) continue;
    if (!real) { findings.push(`${label}: input path cannot be resolved`); continue; }
    if (!inside(real, repo)) { findings.push(`${label}: input outside fork -> ${real}`); continue; }
    const parts = path.relative(repo, real).split(path.sep);
    if (!parts.includes('node_modules')) continue;
    if (parts[0] === 'node_modules' && parts[1] === '.pnpm' && parts[3] === 'node_modules') {
      const name = parts[4]?.startsWith('@') ? parts.slice(4, 6).join('/') : parts[4];
      const allowed = pins.some(pin => pin.name === name && (parts[2] === `${name.replace('/', '+')}@${pin.version}` || parts[2].startsWith(`${name.replace('/', '+')}@${pin.version}_`)));
      const tail = parts.slice(name?.startsWith('@') ? 6 : 5);
      if (allowed && !tail.includes('node_modules')) continue;
      findings.push(`${label}: package not listed in lockfile packages: ${name} (${parts[2]})`);
    } else findings.push(`${label}: dependency is not a locked .pnpm package -> ${real}`);
  }
  console.log(`inputs: worker ${workerIds.length}; UI ${entries.length - workerIds.length}; locked package pins ${pins.length}`);
  return findings;
}

export function main(args) {
  const [command, repoArg, ...inputs] = args;
  const check = { lockfile: 'LOCKFILE', 'install-log': 'INSTALL-LOG', 'bundle-inputs': 'BUNDLE-INPUTS' }[command];
  const counts = { lockfile: 0, 'install-log': 1, 'bundle-inputs': 2 };
  if (!check || !repoArg || inputs.length !== counts[command]) {
    console.error('usage: clawnify-free.mjs lockfile <repo> | install-log <repo> <ndjson> | bundle-inputs <repo> <worker-metafile> <ui-inputs.json>');
    return 2;
  }
  try {
    const repo = fs.realpathSync(repoArg);
    console.log(`repo: ${repo}`);
    let findings;
    if (command === 'lockfile') findings = lockfile(repo, read(path.join(repo, 'pnpm-lock.yaml')));
    else if (command === 'install-log') findings = installLog(repo, read(inputs[0]));
    else findings = bundleInputs(repo, read(path.join(repo, 'pnpm-lock.yaml')), JSON.parse(read(inputs[0])), JSON.parse(read(inputs[1])));
    for (const finding of findings) console.log(finding);
    console.log(`${check}: ${findings.length ? 'FAIL' : 'PASS'}`);
    return findings.length ? 1 : 0;
  } catch (e) {
    console.log(`input error: ${e.message}`);
    console.log(`${check}: FAIL`);
    return 2;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
