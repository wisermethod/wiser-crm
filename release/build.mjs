#!/usr/bin/env node
// Unsigned release assembly. Only built-ins; no package source is inspected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = 'wiser-crm';
const CHECKS = ['lockfile', 'install_log', 'bundle_inputs'];
const LABELS = ['LOCKFILE', 'INSTALL-LOG', 'BUNDLE-INPUTS'];
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA = /^[0-9a-f]{40}$/;
const inside = (file, root) => file.toLowerCase() === root.toLowerCase() || file.toLowerCase().startsWith(root.toLowerCase() + path.sep);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const protectedPath = file => file.split(path.sep).some(part => /^memory$/i.test(part) || /^\.env(?:\.|$)/i.test(part));

// Resolve the nearest existing ancestor, including a symlinked destination.
function destination(file) {
  const parts = [];
  let ancestor = path.resolve(file);
  while (!fs.existsSync(ancestor)) {
    // A dangling symlink is not a new destination.
    try { fs.lstatSync(ancestor); throw new Error('dangling output symlink'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    parts.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const result = path.join(fs.realpathSync(ancestor), ...parts);
  if (protectedPath(result)) throw new Error('refusing a memory or .env path');
  return result;
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout;
}

export function argumentsFor(argv, repository) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--commit', '--version', '--out', '--f1-limit'].includes(flag)) throw new Error(`unknown flag: ${flag}`);
    if (Object.hasOwn(flags, flag)) throw new Error(`duplicate flag: ${flag}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing value: ${flag}`);
    flags[flag] = argv[++i];
  }
  const repo = fs.realpathSync(repository);
  if (!VERSION.test(flags['--version'] ?? '')) throw new Error('--version must be x.y.z without leading zeroes');
  if (!path.isAbsolute(flags['--out'] ?? '')) throw new Error('--out must be absolute');
  const out = destination(flags['--out']);
  const release = destination(path.join(out, APP, flags['--version']));
  if (inside(out, repo) || inside(release, repo)) throw new Error('--out must be outside the repository');
  if (fs.existsSync(release)) throw new Error('release directory already exists');
  if (!/^(0|[1-9][0-9]*)$/.test(flags['--f1-limit'] ?? '') || !Number.isSafeInteger(Number(flags['--f1-limit']))) throw new Error('--f1-limit must be a nonnegative safe integer');
  const commit = flags['--commit'];
  if (!SHA.test(commit ?? '')) throw new Error('--commit must be a full 40-character lowercase hex commit held by the fork');
  if (git(repo, ['rev-parse', '--verify', `${commit}^{commit}`]).trim() !== commit) throw new Error('--commit is not held by the fork');
  const tracked = git(repo, ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean);
  if (tracked.some(protectedPath)) throw new Error('commit contains a protected memory or .env path; refusing to copy it');
  return { repo, commit, version: flags['--version'], out, release, f1Limit: Number(flags['--f1-limit']) };
}

// All child stdout/stderr stays in evidence files; stdout of this CLI is one JSON object.
function command(program, args, { cwd, env, log }) {
  const fd = fs.openSync(log, 'wx');
  let result;
  try { result = spawnSync(program, args, { cwd, env, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0]} failed (exit ${result.status ?? 'unavailable'}); log: ${log}${result.error ? `; ${result.error.message}` : ''}`);
}

export function checkCommand(program, args, options, label) {
  try { command(program, args, options); }
  catch (e) { throw new Error(`${label}: FAIL; ${e.message}`); }
  const output = fs.readFileSync(options.log, 'utf8');
  if (output.trim().split(/\r?\n/).at(-1) !== `${label}: PASS`) throw new Error(`${label}: FAIL (no PASS verdict); log: ${options.log}`);
  return 'PASS';
}

export function runChecks(checks, assemble) {
  const verdicts = {};
  for (const [i, name] of CHECKS.entries()) {
    verdicts[name] = checks[name]();
    if (verdicts[name] !== 'PASS') throw new Error(`${LABELS[i]}: FAIL; release blocked`);
  }
  return assemble(verdicts);
}

function requirePass(checks) {
  if (Object.keys(checks).length !== CHECKS.length || CHECKS.some(name => checks[name] !== 'PASS')) throw new Error('all three S10 checks must be PASS; release blocked');
}

// Refuse a registry-scoped dependency before running the package manager. This
// safety preflight does not replace S10. file: packages are allowed so an entirely
// local stand-in can exercise the real release-blocking check after installation.
export function noScopeRegistry(repo) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, value] of Object.entries(manifest[group] ?? {})) {
      if (/@clawnify/i.test(name) && !/^(link:|file:)\.?(?:\/|runtime\/)/.test(value)) throw new Error('scope registry safety preflight refused a nonlocal dependency');
    }
  }
  const lock = fs.readFileSync(path.join(repo, 'pnpm-lock.yaml'), 'utf8');
  let decoded = lock;
  for (let i = 0; i < 5; i++) decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  for (const line of decoded.split(/\r?\n/)) {
    if (!/@clawnify/i.test(line)) continue;
    // Only dependency keys and local-file package/snapshot keys are safe.
    if (!/^\s+['"]?@clawnify\/[a-z0-9-]+(?:@file:(?:\.\/)?[a-z0-9_-][a-z0-9_./-]*)?['"]?:\s*(?:\{\})?\s*$/i.test(line)) throw new Error('scope registry safety preflight refused lockfile metadata');
  }
}

// Current config is JSON; accept JSONC comments and trailing commas as well.
export function readConfig(file) {
  const text = fs.readFileSync(file, 'utf8');
  const tokens = text.match(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|[^"/]+|\//g) ?? [];
  const uncommented = tokens.map(token => token.startsWith('//') || token.startsWith('/*') ? ' ' : token).join('');
  return JSON.parse(uncommented.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, end) => end ?? match));
}

function filesUnder(root, prefix = '') {
  const files = [];
  for (const name of fs.readdirSync(path.join(root, prefix)).sort()) {
    const relative = path.posix.join(prefix, name);
    if (protectedPath(relative)) throw new Error('refusing a protected input path');
    const stat = fs.lstatSync(path.join(root, relative));
    if (stat.isDirectory()) files.push(...filesUnder(root, relative));
    else if (stat.isFile()) files.push(relative);
    else throw new Error(`refusing nonregular release input: ${relative}`);
  }
  return files;
}

export function moduleType(name) {
  const types = { '.js': 'application/javascript+module', '.mjs': 'application/javascript+module', '.cjs': 'application/javascript', '.wasm': 'application/wasm', '.txt': 'text/plain', '.html': 'text/plain', '.bin': 'application/octet-stream' };
  const type = types[path.extname(name)];
  if (!type) throw new Error(`unknown emitted Worker module type: ${name}`);
  return type;
}

function contentType(name) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm' })[path.extname(name)] ?? 'application/octet-stream';
}

// Collect and validate everything before creating the destination. Used by the
// CLI and small fixture tests; there is no CLI switch to bypass checks.
export function assemble({ release, version, source, checks, config, workerDir, mainModule, assetsDir, migrationsDir, table, created = new Date().toISOString() }) {
  requirePass(checks);
  if (!SHA.test(source.commit) || !SHA.test(source.upstream_commit) || source.repository !== 'wisermethod/wiser-crm' || !Number.isSafeInteger(source.f1.count) || source.f1.count < 0 || !Number.isSafeInteger(source.f1.limit) || source.f1.count > source.f1.limit) throw new Error('invalid source provenance or F1 limit');
  if (!VERSION.test(version) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error('invalid version or migration table');
  if (config.assets?.run_worker_first !== true || config.d1_databases?.length !== 1 || !config.assets.binding || !config.compatibility_date) throw new Error('unsupported release configuration');
  const stored = new Map();
  function store(file) {
    const bytes = fs.readFileSync(file);
    const hash = sha256(bytes);
    stored.set(hash, bytes);
    return { sha256: hash, size: bytes.length };
  }
  const safeName = name => /^[A-Za-z0-9_./-]+$/.test(name) && !name.includes('..') && name.split('/').every(part => part && part !== '.') && name !== 'metadata';
  const moduleNames = filesUnder(workerDir).filter(name => name !== 'README.md' && name !== 'meta.json' && !name.endsWith('.map'));
  if (!moduleNames.includes(mainModule)) throw new Error('main module missing from Wrangler output');
  const modules = moduleNames.map(name => {
    if (!safeName(name)) throw new Error('unsafe module name');
    return { name, type: moduleType(name), ...store(path.join(workerDir, name)) };
  });
  const assets = filesUnder(assetsDir).map(name => {
    if (!safeName(name)) throw new Error('unsafe asset path');
    return { path: '/' + name, ...store(path.join(assetsDir, name)), content_type: contentType(name) };
  });
  // Only numbered SQL files are migrations, and filenames are their identity; the
  // README and the adoption helper beside them are not carried. An unnumbered
  // .sql file stops the build rather than being skipped or guessed at.
  const sqlFiles = filesUnder(migrationsDir).filter(name => name.endsWith('.sql'));
  const stray = sqlFiles.filter(name => !/^\d+_[A-Za-z0-9_-]+\.sql$/.test(name));
  if (stray.length) throw new Error(`unnumbered migration file: ${stray.join(', ')}`);
  const migrations = sqlFiles.sort((a, b) => {
    const an = Number(/^(\d+)_/.exec(a)[1]), bn = Number(/^(\d+)_/.exec(b)[1]);
    return an - bn || (a < b ? -1 : a > b ? 1 : 0);
  }).map(name => {
    if (!safeName(name)) throw new Error('unsafe migration name');
    return { name, ...store(path.join(migrationsDir, name)) };
  });
  const manifest = {
    format: 2, app: APP, version, created,
    source: { repository: source.repository, commit: source.commit, upstream_commit: source.upstream_commit, f1: { count: source.f1.count, limit: source.f1.limit } },
    checks: Object.fromEntries(CHECKS.map(name => [name, checks[name]])),
    worker: { main_module: mainModule, compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags ?? [], d1_binding: config.d1_databases[0].binding, assets_binding: config.assets.binding, vars_required: Object.keys(config.vars ?? {}), modules },
    assets: { config: { html_handling: config.assets.html_handling ?? 'auto-trailing-slash', not_found_handling: config.assets.not_found_handling ?? 'none', run_worker_first: true }, files: assets },
    migrations: { table, files: migrations },
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.mkdirSync(path.dirname(release), { recursive: true });
  fs.mkdirSync(release); // Exclusive; never merge into or remove somebody else's output.
  try {
    fs.mkdirSync(path.join(release, 'files'));
    for (const [hash, contents] of stored) fs.writeFileSync(path.join(release, 'files', hash), contents, { flag: 'wx' });
    fs.writeFileSync(path.join(release, 'manifest.json'), bytes, { flag: 'wx' });
  } catch (e) {
    fs.rmSync(release, { recursive: true, force: true });
    throw e;
  }
  return { release_directory: release, manifest_sha256: sha256(bytes), file_count: stored.size, total_bytes: [...stored.values()].reduce((n, bytes) => n + bytes.length, 0), checks: manifest.checks, count: source.f1.count };
}

export function build(options) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiser-crm-build-')));
  process.stderr.write(`build evidence: ${work}\n`);
  const checkout = path.join(work, 'checkout');
  const dirs = Object.fromEntries(['store', 'cache', 'config', 'data', 'tmp', 'wrangler-logs', 'worker'].map(name => [name, path.join(work, name)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  const env = { ...process.env, CI: 'true', TMPDIR: dirs.tmp, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: dirs['wrangler-logs'], XDG_CACHE_HOME: dirs.cache, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, npm_config_cache: dirs.cache, npm_config_cache_dir: dirs.cache, npm_config_store_dir: dirs.store };
  const run = (program, args, name, cwd = checkout) => command(program, args, { cwd, env, log: path.join(work, name) });
  run('git', ['clone', '--no-hardlinks', '--no-checkout', '--', options.repo, checkout], 'clone.log', work);
  run('git', ['checkout', '--detach', options.commit], 'checkout.log');
  if (git(checkout, ['status', '--porcelain']).trim()) throw new Error('checkout is not clean');
  noScopeRegistry(checkout);
  if (fs.readdirSync(dirs.store).length || fs.readdirSync(dirs.cache).length) throw new Error('store and cache must start empty');
  run('pnpm', ['--store-dir', dirs.store, `--config.cache-dir=${dirs.cache}`, '--registry=https://registry.npmjs.org', 'install', '--frozen-lockfile', '--reporter=ndjson'], 'install.ndjson');
  const checker = path.join(checkout, 'release/clawnify-free.mjs');
  const check = (i, args) => checkCommand(process.execPath, [checker, ...args], { cwd: checkout, env, log: path.join(work, `check-${CHECKS[i]}.log`) }, LABELS[i]);
  return runChecks({
    lockfile: () => check(0, ['lockfile', checkout]),
    install_log: () => check(1, ['install-log', checkout, path.join(work, 'install.ndjson')]),
    bundle_inputs: () => {
      run(process.execPath, ['release/ui-inputs.mjs', path.join(work, 'ui-inputs.json')], 'ui-build.log');
      run('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--config', 'wrangler.wiser.jsonc', '--outdir', dirs.worker, '--metafile', path.join(dirs.worker, 'meta.json')], 'worker-build.log');
      return check(2, ['bundle-inputs', checkout, path.join(dirs.worker, 'meta.json'), path.join(work, 'ui-inputs.json')]);
    },
  }, checks => {
    const upstream = git(options.repo, ['merge-base', options.commit, 'clawnify/main']).trim();
    const changed = git(options.repo, ['diff', '--name-only', '--no-renames', '--diff-filter=MD', '-z', upstream, options.commit]).split('\0').filter(Boolean);
    fs.writeFileSync(path.join(work, 'f1.json'), JSON.stringify({ commit: options.commit, upstream_commit: upstream, count: changed.length, limit: options.f1Limit, files: changed }, null, 2) + '\n', { flag: 'wx' });
    if (changed.length > options.f1Limit) throw new Error(`F1 count ${changed.length} exceeds limit ${options.f1Limit}`);
    const config = readConfig(path.join(checkout, 'wrangler.wiser.jsonc'));
    const meta = JSON.parse(fs.readFileSync(path.join(dirs.worker, 'meta.json'), 'utf8'));
    const entries = Object.entries(meta.outputs ?? {}).filter(([name, value]) => value.entryPoint && path.resolve(checkout, value.entryPoint) === path.resolve(checkout, config.main) && /\.(m?js)$/.test(name));
    if (entries.length !== 1) throw new Error('Wrangler metadata must name exactly one Worker entry');
    const mainModule = path.relative(dirs.worker, path.resolve(checkout, entries[0][0])).split(path.sep).join('/');
    const migrationsDir = path.resolve(checkout, config.d1_databases[0].migrations_dir);
    if (!inside(migrationsDir, checkout)) throw new Error('migrations directory escapes checkout');
    const table = /CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)\(/.exec(fs.readFileSync(path.join(migrationsDir, 'README.md'), 'utf8'))?.[1];
    if (!table) throw new Error('migration table absent from migrations/README.md');
    return assemble({ release: options.release, version: options.version, source: { repository: 'wisermethod/wiser-crm', commit: options.commit, upstream_commit: upstream, f1: { count: changed.length, limit: options.f1Limit } }, checks, config, workerDir: dirs.worker, mainModule, assetsDir: path.resolve(checkout, config.assets.directory), migrationsDir, table });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    process.stdout.write(JSON.stringify(build(argumentsFor(process.argv.slice(2), repo))) + '\n');
  } catch (e) {
    process.stderr.write(`release build: ${e.message}\n`);
    process.exitCode = 1;
  }
}
