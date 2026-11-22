#!/usr/bin/env node
// Unsigned release assembly. Only built-ins; no package source is inspected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './sign.mjs';
import { APPS, BRAND_OPTIONAL_VARS, CRM, INTAKE, INTAKE_INPUT, MIGRATION_TABLE, MIGRATION_NAME, compareMigrations, checkIntakeInputs } from './format3.mjs';

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
    if (!['--commit', '--version', '--out', '--f1-limit', '--offline-store'].includes(flag)) throw new Error(`unknown flag: ${flag}`);
    if (Object.hasOwn(flags, flag)) throw new Error(`duplicate flag: ${flag}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing value: ${flag}`);
    flags[flag] = argv[++i];
  }
  const repo = fs.realpathSync(repository);
  if (!VERSION.test(flags['--version'] ?? '')) throw new Error('--version must be x.y.z without leading zeroes');
  if (!path.isAbsolute(flags['--out'] ?? '')) throw new Error('--out must be absolute');
  const out = destination(flags['--out']);
  const release = destination(path.join(out, CRM, flags['--version']));
  if (inside(out, repo) || inside(release, repo)) throw new Error('--out must be outside the repository');
  if (fs.existsSync(release)) throw new Error('release directory already exists');
  if (!/^(0|[1-9][0-9]*)$/.test(flags['--f1-limit'] ?? '') || !Number.isSafeInteger(Number(flags['--f1-limit']))) throw new Error('--f1-limit must be a nonnegative safe integer');
  const commit = flags['--commit'];
  if (!SHA.test(commit ?? '')) throw new Error('--commit must be a full 40-character lowercase hex commit held by the fork');
  if (git(repo, ['rev-parse', '--verify', `${commit}^{commit}`]).trim() !== commit) throw new Error('--commit is not held by the fork');
  const tracked = git(repo, ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean);
  if (tracked.some(protectedPath)) throw new Error('commit contains a protected memory or .env path; refusing to copy it');
  let offlineStore;
  if (Object.hasOwn(flags, '--offline-store')) {
    if (!path.isAbsolute(flags['--offline-store'])) throw new Error('--offline-store must be absolute');
    offlineStore = destination(flags['--offline-store']);
    if (!fs.statSync(offlineStore).isDirectory() || inside(offlineStore, repo)) throw new Error('--offline-store must be an existing store outside the repository');
  }
  return { repo, commit, version: flags['--version'], out, release, f1Limit: Number(flags['--f1-limit']), offlineStore };
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
  return files.sort();
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

function collectModules(workerDir, mainModule, store) {
  const names = filesUnder(workerDir).filter(name => name !== 'README.md' && name !== 'meta.json' && !name.endsWith('.map'));
  if (!names.includes(mainModule)) throw new Error('main module missing from Wrangler output');
  return names.map(name => ({ name, type: moduleType(name), ...store(path.join(workerDir, name)) }));
}

function collectMigrations(migrationsDir, store) {
  const sqlFiles = filesUnder(migrationsDir).filter(name => name.endsWith('.sql'));
  const stray = sqlFiles.filter(name => !MIGRATION_NAME.test(name));
  if (stray.length) throw new Error(`unnumbered migration file: ${stray.join(', ')}`);
  return sqlFiles.sort(compareMigrations).map(name => ({ name, ...store(path.join(migrationsDir, name)) }));
}

function application(app, { config, workerDir, mainModule, migrationsDir, table, assetsDir, bundleInputs }, store) {
  const spec = APPS[app];
  const intake = app === INTAKE;
  const optional = BRAND_OPTIONAL_VARS[app];
  const expectedVars = [...spec.required, ...optional];
  const vars = Object.keys(config.vars ?? {});
  if (vars.length !== expectedVars.length || !expectedVars.every(name => vars.includes(name))) {
    throw new Error(`unsupported release configuration: ${app} install variables`);
  }
  const [localD1] = config.d1_databases ?? [];
  const localBinding = intake ? 'INTAKE_DB' : 'DB';
  if (config.d1_databases?.length !== 1 || localD1?.binding !== localBinding || !config.compatibility_date) {
    throw new Error(`unsupported release configuration: ${app} D1 binding or Worker date`);
  }
  const mail = config.send_email ?? [];
  if (intake) {
    if (config.assets || mail.length !== 1 || mail[0].name !== spec.mail[0].name
      || !mail[0].destination_address || mail[0].destination_address !== config.vars.NOTICE_TO) {
      throw new Error('unsupported release configuration: intake assets or pinned mail binding');
    }
    checkIntakeInputs(bundleInputs);
  } else if (config.assets?.run_worker_first !== true || config.assets.binding !== 'ASSETS' || mail.length) {
    throw new Error('unsupported release configuration: CRM assets or mail binding');
  }
  const worker = {
    main_module: mainModule,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags ?? [],
    modules: collectModules(workerDir, mainModule, store),
  };
  if (intake) worker.bundle_inputs = bundleInputs;
  return {
    worker,
    assets: intake ? null : {
      binding: config.assets.binding,
      config: {
        html_handling: config.assets.html_handling ?? 'auto-trailing-slash',
        not_found_handling: config.assets.not_found_handling ?? 'none',
        run_worker_first: true,
      },
      files: filesUnder(assetsDir).map(name => ({
        path: '/' + name, ...store(path.join(assetsDir, name)), content_type: contentType(name),
      })),
    },
    bindings: { d1: spec.d1, mail: spec.mail },
    vars: { required: spec.required, optional },
    migrations: { database: spec.database, table, files: collectMigrations(migrationsDir, store) },
  };
}

// Collect the bytes, write to an exclusive destination and run the same
// validation as the signer. A failed check removes only this build's output.
export function assemble({ release, version, source, checks, intake, created = new Date().toISOString(), ...crm }) {
  requirePass(checks);
  if (!SHA.test(source.commit) || !SHA.test(source.upstream_commit) || source.repository !== 'wisermethod/wiser-crm' || !Number.isSafeInteger(source.f1.count) || source.f1.count < 0 || !Number.isSafeInteger(source.f1.limit) || source.f1.count > source.f1.limit) throw new Error('invalid source provenance or F1 limit');
  if (!VERSION.test(version)) throw new Error('invalid version');
  const stored = new Map();
  function store(file) {
    const bytes = fs.readFileSync(file);
    const hash = sha256(bytes);
    stored.set(hash, bytes);
    return { sha256: hash, size: bytes.length };
  }
  const manifest = {
    format: 3, app: CRM, version, created,
    source: { repository: source.repository, commit: source.commit, upstream_commit: source.upstream_commit, f1: { count: source.f1.count, limit: source.f1.limit } },
    checks: Object.fromEntries(CHECKS.map(name => [name, checks[name]])),
    apps: {
      [CRM]: application(CRM, crm, store),
      [INTAKE]: application(INTAKE, { ...intake, table: MIGRATION_TABLE }, store),
    },
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.mkdirSync(path.dirname(release), { recursive: true });
  fs.mkdirSync(release); // Exclusive; never merge into or remove somebody else's output.
  let checked;
  try {
    fs.mkdirSync(path.join(release, 'files'));
    for (const [hash, contents] of stored) fs.writeFileSync(path.join(release, 'files', hash), contents, { flag: 'wx' });
    fs.writeFileSync(path.join(release, 'manifest.json'), bytes, { flag: 'wx' });
    checked = checkRelease(release);
  } catch (e) {
    fs.rmSync(release, { recursive: true, force: true });
    throw e;
  }
  return { release_directory: release, manifest_sha256: checked.manifestHash, file_count: checked.fileCount, total_bytes: checked.totalBytes, checks: manifest.checks, count: source.f1.count };
}

function workerOutput(configFile, workerDir) {
  const dir = path.dirname(configFile);
  const config = readConfig(configFile);
  const meta = JSON.parse(fs.readFileSync(path.join(workerDir, 'meta.json'), 'utf8'));
  const entries = Object.entries(meta.outputs ?? {}).filter(([name, value]) => value.entryPoint
    && path.resolve(dir, value.entryPoint) === path.resolve(dir, config.main) && /\.m?js$/.test(name));
  if (entries.length !== 1) throw new Error('Wrangler metadata must name exactly one Worker entry');
  const [outfile, output] = entries[0];
  const mainModule = path.relative(workerDir, path.resolve(dir, outfile)).split(path.sep).join('/');
  const migrationsDir = path.resolve(dir, config.d1_databases[0].migrations_dir);
  return { config, meta, output, workerDir, mainModule, migrationsDir };
}

function intakeBundleInputs(checkout, configFile, { meta, output }) {
  const dir = path.dirname(configFile);
  const inputs = Object.keys(meta.inputs ?? {});
  const names = inputs.map(input => {
    const file = path.resolve(dir, input);
    const name = path.relative(checkout, file).split(path.sep).join('/');
    if (!INTAKE_INPUT.test(name) || fs.realpathSync(file) !== file) throw new Error('release intake bundle inputs escaped intake source files');
    return name;
  }).sort();
  checkIntakeInputs(names);
  if (!Array.isArray(output.imports) || output.imports.length || !output.inputs
    || inputs.length !== Object.keys(output.inputs).length
    || !inputs.every(input => output.inputs[input]?.bytesInOutput > 0)) {
    throw new Error('release intake bundle inputs must all contribute to one Worker with no module imports');
  }
  return names;
}

export function build(options) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiser-crm-build-')));
  process.stderr.write(`build evidence: ${work}\n`);
  const checkout = path.join(work, 'checkout');
  const dirs = Object.fromEntries(['store', 'cache', 'config', 'data', 'tmp', 'wrangler-logs', 'worker', 'intake'].map(name => [name, path.join(work, name)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  const env = { ...process.env, CI: 'true', TMPDIR: dirs.tmp, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_LOG_PATH: dirs['wrangler-logs'], XDG_CACHE_HOME: dirs.cache, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, npm_config_cache: dirs.cache, npm_config_cache_dir: dirs.cache, npm_config_store_dir: dirs.store };
  const run = (program, args, name, cwd = checkout) => command(program, args, { cwd, env, log: path.join(work, name) });
  run('git', ['clone', '--no-hardlinks', '--no-checkout', '--', options.repo, checkout], 'clone.log', work);
  run('git', ['checkout', '--detach', options.commit], 'checkout.log');
  if (git(checkout, ['status', '--porcelain']).trim()) throw new Error('checkout is not clean');
  noScopeRegistry(checkout);
  if (fs.readdirSync(dirs.store).length || fs.readdirSync(dirs.cache).length) throw new Error('store and cache must start empty');
  const install = options.offlineStore
    ? ['--offline', '--ignore-scripts', '--config.side-effects-cache=false']
    : [];
  run('pnpm', ['--store-dir', options.offlineStore ?? dirs.store, `--config.cache-dir=${dirs.cache}`, '--registry=https://registry.npmjs.org', 'install', '--frozen-lockfile', '--reporter=ndjson', ...install], 'install.ndjson');
  const checker = path.join(checkout, 'release/clawnify-free.mjs');
  const check = (i, args) => checkCommand(process.execPath, [checker, ...args], { cwd: checkout, env, log: path.join(work, `check-${CHECKS[i]}.log`) }, LABELS[i]);
  const crmConfig = path.join(checkout, 'wrangler.wiser.jsonc');
  const intakeConfig = path.join(checkout, 'intake/wrangler.jsonc');
  const workerBuild = (config, outdir, log, extra = []) => run('pnpm', [
    'exec', 'wrangler', 'deploy', '--dry-run', '--config', config, ...extra,
    '--outdir', outdir, '--metafile', path.join(outdir, 'meta.json'),
  ], log);
  let crm, intake;
  return runChecks({
    lockfile: () => check(0, ['lockfile', checkout]),
    install_log: () => check(1, ['install-log', checkout, path.join(work, 'install.ndjson')]),
    bundle_inputs: () => {
      run(process.execPath, ['release/ui-inputs.mjs', path.join(work, 'ui-inputs.json')], 'ui-build.log');
      workerBuild(crmConfig, dirs.worker, 'worker-build.log', ['--define', `__WISER_RELEASE_VERSION__:${JSON.stringify(options.version)}`]);
      workerBuild(intakeConfig, dirs.intake, 'intake-build.log');
      crm = workerOutput(crmConfig, dirs.worker);
      intake = workerOutput(intakeConfig, dirs.intake);
      intake.bundleInputs = intakeBundleInputs(checkout, intakeConfig, intake);
      const workerInputs = { inputs: {
        ...crm.meta.inputs,
        ...Object.fromEntries(intake.bundleInputs.map(name => [name, {}])),
      } };
      const record = path.join(work, 'worker-inputs.json');
      fs.writeFileSync(record, JSON.stringify(workerInputs, null, 2) + '\n', { flag: 'wx' });
      return check(2, ['bundle-inputs', checkout, record, path.join(work, 'ui-inputs.json')]);
    },
  }, checks => {
    const upstream = git(options.repo, ['merge-base', options.commit, 'clawnify/main']).trim();
    const changed = git(options.repo, ['diff', '--name-only', '--no-renames', '--diff-filter=MD', '-z', upstream, options.commit]).split('\0').filter(Boolean);
    fs.writeFileSync(path.join(work, 'f1.json'), JSON.stringify({ commit: options.commit, upstream_commit: upstream, count: changed.length, limit: options.f1Limit, files: changed }, null, 2) + '\n', { flag: 'wx' });
    if (changed.length > options.f1Limit) throw new Error(`F1 count ${changed.length} exceeds limit ${options.f1Limit}`);
    crm.assetsDir = path.resolve(checkout, crm.config.assets.directory);
    if (![crm.assetsDir, crm.migrationsDir, intake.migrationsDir].every(dir => inside(fs.realpathSync(dir), checkout))) {
      throw new Error('assets or migrations directory escapes checkout');
    }
    crm.table = /CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)\(/.exec(fs.readFileSync(path.join(crm.migrationsDir, 'README.md'), 'utf8'))?.[1];
    if (!crm.table) throw new Error('migration table absent from migrations/README.md');
    if (intake.config.d1_databases[0].migrations_table && intake.config.d1_databases[0].migrations_table !== MIGRATION_TABLE) {
      throw new Error('intake migrations must use Wrangler default d1_migrations table');
    }
    return assemble({
      ...crm, intake, release: options.release, version: options.version,
      source: { repository: 'wisermethod/wiser-crm', commit: options.commit, upstream_commit: upstream, f1: { count: changed.length, limit: options.f1Limit } },
      checks,
    });
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
