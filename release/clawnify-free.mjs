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
  // Event prefixes only. Runtime targets use the strict tree walker below.
  try { return fs.realpathSync(p); }
  catch (e) { if (e.code === 'ENOENT') return path.resolve(p); throw e; }
}
// Read directory metadata only. Follow internal directory links once, so a
// cycle cannot loop and a link cannot hide an unchecked subtree.
function runtimeTree(repo, target) {
  const runtime = path.join(repo, 'runtime'), findings = [], visited = new Set();
  function visit(file) {
    try {
      const stat = fs.lstatSync(file);
      const real = fs.realpathSync(file); // ENOENT is a failure, including dangling links.
      if (!inside(real, runtime) || real === runtime) {
        findings.push(`runtime link outside runtime/: ${file} -> ${real}`);
        return;
      }
      if (stat.isSymbolicLink()) { visit(real); return; }
      if (!stat.isDirectory() || visited.has(real)) return;
      visited.add(real);
      for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    } catch (e) { findings.push(`runtime target missing or unreadable: ${file} (${e.code ?? e.message})`); }
  }
  visit(target);
  return findings;
}
function runtimeLink(repo, from, value, findings) {
  if (typeof value !== 'string' || !value.startsWith('link:')) return false;
  const target = path.resolve(from, value.slice(5));
  const errors = runtimeTree(repo, target);
  findings.push(...errors);
  return !errors.length;
}

// Inline maps (resolution, engines, etc.) are kept as scope-scanned values,
// but their keys must obey the same uniqueness rule as block mappings.
function checkFlow(value, line) {
  if (!/^[{[]/.test(value)) return;
  let i = 0;
  const fail = () => { throw new Error(`unrecognized lockfile line ${line}`); };
  const space = () => { while (/\s/.test(value[i] ?? '') && i < value.length) i++; };
  function scalar(key = false) {
    space();
    const quote = value[i];
    if (quote === "'" || quote === '"') {
      i++; let result = '';
      while (i < value.length) {
        if (value[i] === quote) {
          if (quote === "'" && value[i + 1] === quote) { result += quote; i += 2; continue; }
          i++; return result;
        }
        result += value[i++];
      }
      fail();
    }
    const start = i;
    while (i < value.length && !',}]'.includes(value[i]) && !(key && value[i] === ':')) i++;
    const result = value.slice(start, i).trim();
    if (!result) fail();
    return result;
  }
  function node() {
    space();
    if (value[i] !== '{' && value[i] !== '[') { scalar(); return; }
    const mapping = value[i++] === '{', end = mapping ? '}' : ']', keys = new Set();
    space();
    if (value[i] === end) { i++; return; }
    while (i < value.length) {
      if (mapping) {
        const key = scalar(true);
        if (keys.has(key)) throw new Error(`duplicate key ${key} at lockfile line ${line}`);
        keys.add(key); space();
        if (value[i++] !== ':') fail();
      }
      node(); space();
      if (value[i] === end) { i++; return; }
      if (value[i++] !== ',') fail();
      space();
      if (value[i] === end) { i++; return; }
    }
    fail();
  }
  node(); space();
  if (i !== value.length) fail();
}

// Read pnpm v9's block mappings and scalar block sequences explicitly. All
// values (including inline flow values) remain visible to the scope scan.
// Unsupported syntax fails closed rather than being dropped or YAML-decoded.
function lockRows(text) {
  const lines = text.split(/\r?\n/);
  if (lines.find(line => line.trim() && !line.trimStart().startsWith('#')) !== "lockfileVersion: '9.0'") {
    throw new Error("first non-comment line must be lockfileVersion: '9.0'");
  }
  if (text.includes('\\')) throw new Error('backslash in lockfile');
  const rows = [], stack = [], root = { keys: new Set() };
  for (const [i, line] of lines.entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = /^ */.exec(line)[0].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1) ?? root;
    const fail = () => { throw new Error(`unrecognized lockfile line ${i + 1}`); };
    if (line.includes('\t') || (parent !== root && parent.value !== '')) fail();
    const seq = /^( *)- (.+)$/.exec(line);
    if (seq) {
      const scalar = seq[2].trimEnd();
      // pnpm emits plain or single-quoted scalars, never nested list mappings.
      const quoted = /^'(?:[^']|'')*'$/.test(scalar);
      const plain = !/^(?:\s|[-?:](?:\s|$)|[[\]{},&*!|>'"%@`#])/.test(scalar) && !/:($|\s)|\s#/.test(scalar);
      if (parent === root || (!quoted && !plain) || parent.kind === 'mapping' || (parent.childIndent !== undefined && parent.childIndent !== indent)) fail();
      parent.kind = 'sequence'; parent.childIndent = indent;
      rows.push({ line: i + 1, indent, key: '', value: unquote(scalar).replace(/''/g, "'"), parents: [...stack] });
      continue;
    }
    const m = /^( *)(?:'((?:[^']|'')*)'|"([^"\n]*)"|([^'"\s][^\n]*?)):(?: +|$)(.*)$/.exec(line);
    if (!m || parent.kind === 'sequence' || (parent.childIndent !== undefined && parent.childIndent !== indent)) fail();
    const key = m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3] ?? m[4].trimEnd();
    const value = m[5].trimEnd();
    if (/^[?!&*{}[\],>#%|`]/.test(key)) fail();
    if (/^[|>]/.test(value)) throw new Error(`block scalar at lockfile line ${i + 1}`);
    if ((value.startsWith("'") && !/^'(?:[^']|'')*'$/.test(value)) || (value.startsWith('"') && !/^"[^"\n]*"$/.test(value))) fail();
    checkFlow(value, i + 1);
    if (parent.keys.has(key)) throw new Error(`duplicate key ${key} at lockfile line ${i + 1}`);
    parent.keys.add(key); parent.kind = 'mapping'; parent.childIndent = indent;
    const row = { line: i + 1, indent, key, value: unquote(value).replace(/''/g, "'"), parents: [...stack], keys: new Set() };
    rows.push(row); stack.push(row);
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
        } else if (!runtimeLink(repo, from, version.value, findings)) {
          findings.push(`line ${version.line}: link outside runtime/: ${row.key} -> ${version.value}`);
        }
        const spec = children.find(r => r.key === 'specifier');
        if (spec && !runtimeLink(repo, from, spec.value, findings)) findings.push(`line ${spec.line}: importer specifier is not a runtime link: ${row.key} -> ${spec.value}`);
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
            allowed = aliases.has(name) && value === `link:./runtime/${name}` && runtimeLink(repo, repo, value, findings);
            if (!allowed) findings.push(`line ${i + 1}: manifest scope dependency is not an allowed runtime link: ${t[2]} -> ${value}`);
          }
        }
      } else if (event.name === 'pnpm:root' && !ref.isKey && t.length === 2 && t[1] === 'name' && /^@clawnify\/[^/]+$/i.test(ref.value)) {
        const linkedFrom = event[t[0]]?.linkedFrom;
        allowed = typeof linkedFrom === 'string' && runtimeLink(repo, repo, `link:${linkedFrom}`, findings);
        if (!allowed) findings.push(`line ${i + 1}: pnpm:root missing linkedFrom under runtime/: ${ref.value} -> ${linkedFrom ?? '(missing)'}`);
      }
      if (!allowed) findings.push(`line ${i + 1}: ${event.name} unexpected scope at $.${t.join('.')}: ${ref.value}`);
    }
  }
  if (!events) findings.push('line 1: no install events');
  return findings;
}

// The real Vite record has exactly these three pathless NUL helpers. Other
// NUL IDs carry file paths and must pass the ordinary ownership/pin checks.
const internalIds = new Set([
  '\0commonjsHelpers.js',
  '\0vite/modulepreload-polyfill.js',
  '\0vite/preload-helper.js',
  'vite/preload-helper.js', // Vite also emits this exact non-NUL helper.
]);
// Wrangler's handleNodeJSGlobals synthesizes these two onLoad modules under its
// package directory, without creating files. Permit exactly these basenames,
// only for Worker inputs and only beneath the locked Wrangler package.
const wranglerVirtualNames = new Set([
  '_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-console',
  '_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-process',
]);
function wranglerDirectory(lockText, pins) {
  const versions = pins.filter(p => p.name === 'wrangler');
  if (versions.length !== 1) return null;
  const base = `wrangler@${versions[0].version}`;
  const snapshots = lockRows(lockText).filter(r => r.parents.length === 1 && r.parents[0].key === 'snapshots' && (r.key === base || r.key.startsWith(base + '(')));
  // pnpm's directory encoding for the exact snapshot (including its peers).
  const directories = new Set(snapshots.map(r => r.key.replaceAll('/', '+').replaceAll(')(', '_').replaceAll('(', '_').replaceAll(')', '')));
  if (!directories.size) return base; // Synthetic no-peer fixture without a snapshot.
  return directories.size === 1 ? [...directories][0] : null;
}
function wranglerVirtual(repo, id, directory) {
  const absolute = path.resolve(repo, id);
  const parts = path.relative(repo, absolute).split(path.sep);
  if (!directory || parts.length !== 6 || parts[0] !== 'node_modules' || parts[1] !== '.pnpm' || parts[2] !== directory || parts[3] !== 'node_modules' || parts[4] !== 'wrangler' || !wranglerVirtualNames.has(parts[5])) return false;
  try { fs.lstatSync(absolute); return false; }
  catch (e) { if (e.code !== 'ENOENT') return false; }
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
  const wranglerDir = wranglerDirectory(lockText, pins);
  if (!worker?.inputs || typeof worker.inputs !== 'object' || Array.isArray(worker.inputs)) throw new Error('Worker metafile must have an inputs object');
  if (!ui || ui.root !== repo || !Array.isArray(ui.chunks) || !ui.chunks.length || !Array.isArray(ui.assets) || !Array.isArray(ui.publicFiles)) throw new Error('UI input record must have this repository root and nonempty chunks');
  const workerIds = Object.keys(worker.inputs);
  if (!workerIds.length) findings.push('worker: no bundle inputs');
  const entries = workerIds.map(id => ['worker', id]);
  for (const chunk of ui.chunks) {
    if (typeof chunk.fileName !== 'string' || !Array.isArray(chunk.modules) || !chunk.modules.length || chunk.modules.some(id => typeof id !== 'string')) throw new Error('invalid or empty UI chunk modules');
    entries.push(...chunk.modules.map(id => [`ui:${chunk.fileName}`, id]));
  }
  for (const asset of ui.assets) {
    if (typeof asset.fileName !== 'string' || !Array.isArray(asset.originalFileNames) || asset.originalFileNames.some(id => typeof id !== 'string')) throw new Error('invalid UI asset origins');
    entries.push(...asset.originalFileNames.map(id => [`ui:asset:${asset.fileName}`, id]));
  }
  if (ui.publicFiles.some(id => typeof id !== 'string')) throw new Error('invalid UI public files');
  entries.push(...ui.publicFiles.map(id => ['ui:public', id]));
  for (const [source, id] of entries) {
    const label = `${source}: ${JSON.stringify(id)}`;
    // CommonJS proxy IDs have one NUL prefix and one trailing query. Helpers
    // are exempt only by exact ID; every path otherwise takes the same checks.
    const file = (id.startsWith('\0') ? id.slice(1) : id).replace(/\?[^?]*$/, '');
    const real = (() => { try { return fs.realpathSync(path.resolve(repo, file)); } catch { return null; } })();
    if (scoped(id) || (real && scoped(real))) {
      if (!real || !inside(real, path.join(repo, 'runtime'))) {
        findings.push(`${label}: scope input outside runtime/`);
        continue;
      }
    }
    if (real && inside(real, path.join(repo, 'runtime'))) {
      const root = path.join(repo, 'runtime', path.relative(path.join(repo, 'runtime'), real).split(path.sep)[0]);
      findings.push(...runtimeTree(repo, root).map(error => `${label}: ${error}`));
      continue;
    }
    if (internalIds.has(id)) continue;
    // Reserve these basenames: a real file cannot fall through to the ordinary
    // locked-package allowance, and a lookalike directory is never synthetic.
    if (wranglerVirtualNames.has(path.basename(file))) {
      if (source === 'worker' && wranglerVirtual(repo, file, wranglerDir)) continue;
      findings.push(`${label}: invalid Wrangler virtual input`);
      continue;
    }
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
