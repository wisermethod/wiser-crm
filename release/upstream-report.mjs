#!/usr/bin/env node
// Metadata and a disposable trial merge only. No registry response is persisted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { noScopeRegistry } from './build.mjs';

export const WATCH = ['app', 'connections', 'db', 'integrations', 'queue', 'routes', 'services'];
export const F9 = 'the lockfile needs regenerating after the merge, which a session does';
// What pnpm acts on beyond the lockfile: these must reach the install unchanged from HEAD.
export const INSTALL_CONFIG = ['pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs'];
// Root package.json keys a merge may change before install; every other key, scripts and the
// pnpm field included, reaches pnpm unchanged from HEAD. The licence is F10's.
export const DESCRIPTIVE = ['name', 'version', 'description', 'keywords', 'author', 'contributors', 'homepage', 'bugs', 'repository', 'funding', 'license'];
const protectedPath = file => file.split(/[\\/]/).some(p => /^memory$/i.test(p) || /^\.env(?:\.|$)/i.test(p));
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const lines = text => String(text ?? '').trimEnd().split(/\r?\n/).slice(-40).join('\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const names = text => {
  // Scan strings, including comments and repeatedly URL-encoded names, not YAML nodes.
  for (let i = 0; i < 5; i++) text = text.replace(/%([0-9a-f]{2})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  return [...new Set((text.match(/@clawnify\/[a-z0-9._~-]+/gi) ?? []).map(s => s.toLowerCase()))].sort();
};

export function runCommand(program, args, options) {
  if (options.log) {
    const fd = fs.openSync(options.log, 'wx');
    let result;
    try { result = spawnSync(program, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', fd, fd] }); }
    finally { fs.closeSync(fd); }
    return { status: result.status, output: lines(fs.readFileSync(options.log, 'utf8')), error: Boolean(result.error) };
  }
  const result = spawnSync(program, args, { cwd: options.cwd, env: options.env, encoding: options.binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, output: options.binary ? result.stdout : (result.stdout ?? '') + (result.stderr ?? ''), error: Boolean(result.error) };
}

export function argumentsFor(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--repo', '--upstream', '--out', '--workflows'].includes(flag) || Object.hasOwn(flags, flag)) throw new Error('unknown or duplicate argument');
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('missing argument value');
    flags[flag] = argv[++i];
  }
  if (!flags['--repo'] || !flags['--upstream'] || !flags['--out']) throw new Error('required: --repo <checkout> --upstream <ref> --out <directory>');
  return { repo: flags['--repo'], upstream: flags['--upstream'], out: flags['--out'], workflows: flags['--workflows'] };
}

function safeDestination(directory) {
  let ancestor = path.resolve(directory);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    try { fs.lstatSync(ancestor); throw new Error('dangling output symlink'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
  }
  const dest = path.join(fs.realpathSync(ancestor), ...suffix);
  if (protectedPath(path.resolve(directory)) || protectedPath(dest)) throw new Error('protected output path');
  return dest;
}

class Stop extends Error {}
const stop = why => { throw new Stop(why); };

export async function runReport(options, injected = {}) {
  const run = injected.run ?? runCommand;
  const fetchMetadata = injected.fetch ?? globalThis.fetch;
  const repo = fs.realpathSync(options.repo), out = safeDestination(options.out);
  if (protectedPath(repo) || inside(out, repo) || inside(repo, out)) throw new Error('output must be separate from the checkout');
  fs.mkdirSync(out, { recursive: true });
  const markdownFile = path.join(out, 'upstream-report.md'), jsonFile = path.join(out, 'upstream-report.json');
  if ([markdownFile, jsonFile, path.join(out, 'install.ndjson')].some(f => fs.existsSync(f))) throw new Error('report output already exists');
  const summary = { created: (injected.now?.() ?? new Date()).toISOString(), verdict: '', stops: [], alerts: [], commits: [], f10: [], merge: { status: 'skipped', conflicts: [] }, f1: null, steps: [], licence_watch: [], workflow: { state: 'not supplied', warning: false } };
  // Git/pnpm never receive the issue token or the caller's other credentials.
  const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), CI: 'true', WRANGLER_SEND_METRICS: 'false', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NPM_CONFIG_USERCONFIG: '/dev/null' };
  // GIT_CONFIG_GLOBAL drops the safe.directory entry actions/checkout writes, so name it here.
  const gitResult = (cwd, args, binary = false) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'safe.directory=*', '-C', cwd, ...args], { cwd, env, binary });
  const git = (cwd, args, binary = false) => {
    const r = gitResult(cwd, args, binary);
    if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed`);
    return r.output;
  };
  const treePaths = ref => git(repo, ['ls-tree', '-r', '--name-only', '-z', ref]).split('\0').filter(Boolean);
  const read = (ref, file) => git(repo, ['show', `${ref}:${file}`]);
  function metadata(ref) {
    const files = treePaths(ref);
    if (files.some(protectedPath)) stop('protected memory or .env path in source; no copy made');
    if (!files.includes('LICENSE') || !files.includes('pnpm-lock.yaml')) stop('F10: required LICENSE or pnpm-lock.yaml is missing');
    const licenses = {};
    for (const file of files.filter(f => path.posix.basename(f) === 'package.json' && !f.split('/').includes('node_modules'))) {
      const manifest = JSON.parse(read(ref, file));
      licenses[file] = Object.hasOwn(manifest, 'license') ? { license: manifest.license } : { missing: true };
    }
    return { license_sha256: hash(git(repo, ['show', `${ref}:LICENSE`], true)), licenses, scope: names(read(ref, 'pnpm-lock.yaml')) };
  }
  let temporary;
  try {
    if (git(repo, ['status', '--porcelain']).trim()) stop('caller checkout is not clean');
    const head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    const upstream = git(repo, ['rev-parse', '--verify', '--end-of-options', `${options.upstream}^{commit}`]).trim();
    const last = git(repo, ['merge-base', head, upstream]).trim();
    summary.last = last; summary.new = upstream;
    // Upstream commits HEAD lacks, whatever the merge bases; F10 compares from the last merged commit.
    for (const commit of git(repo, ['rev-list', '--reverse', `${head}..${upstream}`]).trim().split('\n').filter(Boolean)) {
      const [id, date, ...subject] = git(repo, ['show', '-s', '--format=%h%n%cs%n%s', commit]).trimEnd().split('\n');
      const files = [...new Set(git(repo, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '-r', '-m', commit]).split('\0').filter(Boolean))];
      summary.commits.push({ id, date, subject: subject.join('\n'), files });
    }
    if (summary.commits.length) {
      const before = metadata(last), after = metadata(upstream);
      if (before.license_sha256 !== after.license_sha256) summary.f10.push({ field: 'LICENSE SHA-256', before: before.license_sha256, after: after.license_sha256 });
      for (const file of [...new Set([...Object.keys(before.licenses), ...Object.keys(after.licenses)])].sort()) {
        const a = Object.hasOwn(before.licenses, file) ? before.licenses[file] : { absent: true };
        const b = Object.hasOwn(after.licenses, file) ? after.licenses[file] : { absent: true };
        if (canonical(a) !== canonical(b)) summary.f10.push({ field: `${file} license`, before: a, after: b });
      }
      if (canonical(before.scope) !== canonical(after.scope)) summary.f10.push({ field: 'pnpm-lock.yaml @clawnify/ names', before: before.scope, after: after.scope });
      if (summary.f10.length) stop(`F10: ${summary.f10.map(c => c.field).join('; ')} changed`);
      // Clone instead of a linked worktree, with no remote back to the caller's checkout.
      metadata(head);
      temporary = fs.realpathSync(fs.mkdtempSync(path.join(injected.tmpdir ?? os.tmpdir(), 'wiser-crm-upstream-')));
      const copy = path.join(temporary, 'checkout');
      git(temporary, ['clone', '--no-hardlinks', '--no-checkout', '--', repo, copy]);
      git(copy, ['checkout', '--detach', head]);
      git(copy, ['remote', 'remove', 'origin']);
      summary.merge.status = 'attempted';
      const merge = gitResult(copy, ['-c', 'user.name=Wiser upstream report', '-c', 'user.email=upstream-report@invalid', 'merge', '--no-ff', '--no-commit', upstream]);
      if (merge.error || merge.status !== 0) {
        summary.merge.conflicts = git(copy, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
        summary.merge.status = summary.merge.conflicts.length ? 'conflict' : 'failed';
        stop(summary.merge.conflicts.length ? `merge conflicts: ${summary.merge.conflicts.join(', ')}` : 'trial merge failed');
      }
      summary.merge.status = 'clean';
      const merged = git(copy, ['write-tree']).trim();
      const files = git(copy, ['diff', '--name-only', '--no-renames', '--diff-filter=MD', '-z', upstream, merged]).split('\0').filter(Boolean);
      summary.f1 = { count: files.length, limit: 10, files };
      if (summary.f1.count > summary.f1.limit) stop(`F1: ${summary.f1.count} upstream files exceeds limit 10`);
      for (const name of ['cache', 'config', 'data', 'home', 'store', 'tmp', 'wrangler-logs']) fs.mkdirSync(path.join(temporary, name));
      Object.assign(env, { HOME: path.join(temporary, 'home'), TMPDIR: path.join(temporary, 'tmp'), XDG_CACHE_HOME: path.join(temporary, 'cache'), XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_DATA_HOME: path.join(temporary, 'data'), npm_config_cache: path.join(temporary, 'cache'), npm_config_store_dir: path.join(temporary, 'store'), WRANGLER_LOG_PATH: path.join(temporary, 'wrangler-logs') });
      function step(name, program, args, label, log) {
        const result = run(program, args, { cwd: copy, env, log: log ?? path.join(temporary, `${name}.log`) });
        const output = lines(result.output);
        const pass = !result.error && result.status === 0 && (!label || output.trim().split(/\r?\n/).at(-1) === `${label}: PASS`);
        const record = { name, command: [program === process.execPath ? 'node' : program, ...args].join(' '), status: pass ? 'PASS' : 'FAIL', exit: result.status ?? null, output };
        summary.steps.push(record);
        return record;
      }
      const lock = step('lockfile', process.execPath, ['release/clawnify-free.mjs', 'lockfile', copy], 'LOCKFILE');
      if (lock.status !== 'PASS') stop('lockfile check failed; no install attempted');
      // The release build's own preflight, then the scripts and settings pnpm runs or reads at install.
      try { noScopeRegistry(copy); } catch { stop('scope preflight refused a nonlocal @clawnify/ dependency or lockfile entry; no install attempted'); }
      const ours = JSON.parse(read(head, 'package.json')), mergedManifest = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8'));
      const keys = [...new Set([...Object.keys(ours), ...Object.keys(mergedManifest)])].filter(key => !DESCRIPTIVE.includes(key)).sort();
      const changed = keys.filter(key => canonical(ours[key]) !== canonical(mergedManifest[key]));
      if (changed.length) stop(`root package.json changed by the merge (${changed.join(', ')}); a session reviews it and regenerates the lockfile before any install`);
      const headFiles = treePaths(head);
      const patches = Object.values(ours.pnpm?.patchedDependencies ?? {}).filter(file => typeof file === 'string');
      for (const file of [...INSTALL_CONFIG, ...patches]) {
        const before = headFiles.includes(file) ? git(repo, ['show', `${head}:${file}`], true) : null;
        const after = fs.existsSync(path.join(copy, file)) ? fs.readFileSync(path.join(copy, file)) : null;
        if ((before === null) !== (after === null) || (before && !Buffer.from(before).equals(after))) stop(`${file} changed by the merge; a session reviews it before any install`);
      }
      // Read the documented command as argv, never execute README text through a shell.
      const readme = fs.readFileSync(path.join(copy, 'tests/README.md'), 'utf8');
      const suite = /Run every suite:\s*```(?:bash|sh)\r?\nWRANGLER_SEND_METRICS=false node --test ([^\r\n]+)\r?\n```/.exec(readme)?.[1].split(/\s+/);
      if (!suite?.length || suite.some(f => !/^[A-Za-z0-9_./-]+\.(?:mjs|[cm]?ts|js)$/.test(f) || f.split('/').includes('..') || protectedPath(f) || f.split('/').includes('node_modules'))) stop('full suite command in tests/README.md is missing or unsupported');
      const install = step('install', 'pnpm', ['install', '--frozen-lockfile', '--reporter=ndjson'], null, path.join(out, 'install.ndjson'));
      const audit = step('install-log', process.execPath, ['release/clawnify-free.mjs', 'install-log', copy, path.join(out, 'install.ndjson')], 'INSTALL-LOG');
      if (install.status !== 'PASS') {
        // The complete install log is inspected; the diagnostic may precede its tail.
        const log = fs.readFileSync(path.join(out, 'install.ndjson'), 'utf8');
        stop(/ERR_PNPM_(?:OUTDATED_LOCKFILE|FROZEN_LOCKFILE|LOCKFILE_CONFIG_MISMATCH)|cannot install with ["']?frozen-lockfile|cannot proceed with the frozen installation/i.test(log) ? `F9: ${F9}` : 'pnpm install failed');
      }
      if (audit.status !== 'PASS') stop('install-log check failed; builds and tests skipped');
      // These checks are independent once installation and its audit pass.
      step('typecheck', 'pnpm', ['typecheck']);
      step('wiser-typecheck', 'pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.wiser.json']);
      step('build', 'pnpm', ['build']);
      step('tests', process.execPath, ['--test', ...suite]);
      const failed = summary.steps.filter(s => s.status !== 'PASS');
      if (failed.length) stop(`failed steps: ${failed.map(s => s.name).join(', ')}`);
    }
  } catch (e) {
    summary.stops.push(e instanceof Stop ? e.message : `report check could not complete: ${e.message.startsWith('git ') ? e.message : 'unreadable or invalid input/command'}`);
  } finally {
    if (temporary) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); }
      catch { summary.stops.push('temporary clone cleanup failed'); }
    }
  }
  for (const name of WATCH) {
    const entry = { name: `@clawnify/${name}`, status: 'unread' };
    try {
      const response = await fetchMetadata(`https://registry.npmjs.org/@clawnify%2F${name}/latest`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('unread');
      const answer = await response.json();
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('invalid metadata');
      const selected = Object.fromEntries(['version', 'license', 'licenses'].map(field => [field, answer[field] ?? null]));
      Object.assign(entry, selected, { status: 'read' });
      const declared = value => typeof value === 'string' ? Boolean(value.trim()) && !/^unlicensed$/i.test(value.trim()) : Array.isArray(value) ? value.some(declared) : value && typeof value === 'object' ? declared(value.type) : false;
      entry.has_licence = Boolean(declared(entry.license) || declared(entry.licenses));
      if (entry.has_licence) summary.alerts.push(`LICENCE WATCH: ${entry.name} version ${entry.version ?? 'unread'} declares a licence; a session must review it`);
    } catch { /* No error body, URL response or unselected registry field is retained. */ }
    summary.licence_watch.push(entry);
  }
  if (options.workflows) {
    let state = 'absent';
    try {
      if (protectedPath(path.resolve(options.workflows)) || protectedPath(fs.realpathSync(options.workflows))) throw new Error('protected');
      const workflows = JSON.parse(fs.readFileSync(options.workflows, 'utf8')).workflows;
      if (!Array.isArray(workflows)) throw new Error('invalid');
      state = workflows.find(w => w.path === '.github/workflows/sync-branches.yml')?.state ?? 'absent';
      if (!['active', 'disabled_manually', 'disabled_inactivity', 'disabled_fork', 'deleted', 'absent'].includes(state)) state = 'unread';
    } catch { state = 'unread'; }
    summary.workflow = { state, warning: state !== 'disabled_manually' };
    if (summary.workflow.warning) summary.alerts.push(`F8 WARNING: sync-branches.yml is ${state}; run gh workflow disable sync-branches.yml immediately after enabling Actions`);
  }
  summary.verdict = summary.stops.length ? `Stops: ${summary.stops.join('; ')}` : summary.commits.length ? 'Merges cleanly and every step passes.' : 'Nothing new.';
  const markdown = renderReport(summary);
  fs.writeFileSync(jsonFile, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(markdownFile, markdown, { flag: 'wx' });
  return { summary, markdown, markdownFile, jsonFile };
}

export function renderReport(s) {
  const quoted = v => JSON.stringify(v).replaceAll('`', '\\u0060');
  const text = [s.verdict, '', ...s.alerts.map(a => `**${a}**`), '', '## 1. What is new', '', s.last ? `Last merged upstream: ${s.last}. New upstream: ${s.new}.` : 'Upstream comparison unavailable.'];
  if (!s.commits.length) text.push('', 'No new upstream commits. Merge, install, build and tests skipped.');
  for (const c of s.commits) text.push('', `- ${c.id} ${c.date} ${c.subject}`, ...c.files.map(f => `  - ${quoted(f)}`));
  text.push('', '## 2. F10: licence and scope comparison', '', ...s.f10.map(c => `- ${c.field}: ${quoted(c.before)} -> ${quoted(c.after)}`));
  if (!s.f10.length) text.push(s.commits.length && s.merge.status !== 'skipped' ? 'PASS: no changes.' : 'Not run or incomplete; see verdict.');
  text.push('', '## 3. Trial merge', '', `Status: ${s.merge.status}. The trial copy is removed after the attempt.`, ...s.merge.conflicts.map(f => `- Conflict: ${quoted(f)}`));
  text.push('', '## 4. F1 and lockfile check', '', s.f1 ? `F1: ${s.f1.count} of limit ${s.f1.limit} upstream files modified or deleted.` : 'F1 not run.', ...(s.f1?.files ?? []).map(f => `- ${quoted(f)}`));
  const showStep = step => { text.push('', `### ${step.name}: ${step.status}`, '', `Command: ${quoted(step.command)} (exit ${step.exit ?? 'unavailable'})`, '', 'Last 40 output lines:', '', '~~~~text', step.output.replace(/^~~~~/gm, ' ~~~~'), '~~~~'); };
  s.steps.filter(step => step.name === 'lockfile').forEach(showStep);
  text.push('', '## 5. Install, build and test', '', 'WRANGLER_SEND_METRICS=false. Install evidence, when attempted: install.ndjson.');
  s.steps.filter(step => step.name !== 'lockfile').forEach(showStep);
  if (!s.steps.some(step => step.name === 'install')) text.push('', 'Skipped before install; see verdict.');
  text.push('', '## 6. The licence watch', '');
  for (const p of s.licence_watch) text.push(`- ${p.name}: ${p.status === 'unread' ? 'unread (read failed; licence unknown)' : `${p.has_licence ? 'licence declared' : 'no licence declared'}; version=${quoted(p.version)}; license=${quoted(p.license)}; licenses=${quoted(p.licenses)}`}`);
  text.push('', '## 7. Upstream workflow (F8)', '', `sync-branches.yml: ${s.workflow.state}.${s.workflow.warning ? ' WARNING: must be disabled_manually.' : ''}`, '');
  // Outside the fenced logs, & and < are escaped so no entity or tag decodes to an @; then a
  // word joiner after each @ keeps the issue from mentioning anyone, Clawnify included.
  let fenced = false;
  const full = text.join('\n').split('\n').map(line => {
    if (line.startsWith('~~~~')) { fenced = !fenced; return line; }
    return fenced ? line : line.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  }).join('\n').replace(/@(?=[A-Za-z0-9_-])/g, '@' + String.fromCharCode(0x2060));
  // GitHub refuses an issue body over 65,536 characters; the verdict and alerts lead, so they survive.
  if (full.length <= REPORT_LIMIT) return full;
  let cut = full.lastIndexOf('\n', REPORT_LIMIT - 200);
  if (cut < 1) cut = REPORT_LIMIT - 200;
  return `${full.slice(0, cut)}\n\n**Report truncated at ${REPORT_LIMIT} characters for the issue; run the report locally, as release/README.md says, for the rest.**\n`;
}
export const REPORT_LIMIT = 60000;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runReport(argumentsFor(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ report: result.markdownFile, summary: result.jsonFile }) + '\n');
  } catch (e) { process.stderr.write(`upstream report: ${e.message}\n`); process.exitCode = 1; }
}
