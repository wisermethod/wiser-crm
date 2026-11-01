import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runReport, runCommand, renderReport, REPORT_LIMIT, WATCH, F9, argumentsFor } from './upstream-report.mjs';

const sourceFile = fileURLToPath(new URL('./upstream-report.mjs', import.meta.url));
const unmention = text => text.replace(/@(?=[A-Za-z0-9_-])/g, '@' + String.fromCharCode(0x2060));
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiser-upstream-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const upstream = path.join(base, 'upstream'), repo = path.join(base, 'fork'), out = path.join(base, 'out');
  const invocations = [], steps = [], fetches = [];
  function git(cwd, ...args) {
    invocations.push(args);
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(r.status, 0, `fixture git ${args[0]}: ${r.stderr}`);
    return r.stdout;
  }
  function write(where, file, contents) {
    const target = path.join(where, file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents);
  }
  // Scratch repositories only. No commits in the real fork; no installed packages.
  fs.mkdirSync(upstream); git(upstream, 'init', '-b', 'main');
  for (const dir of [upstream]) {
    git(dir, 'config', 'user.name', 'Synthetic fixture'); git(dir, 'config', 'user.email', 'fixture@invalid');
  }
  const commit = (where, message) => { git(where, 'add', '.'); git(where, 'commit', '-m', message); };
  write(upstream, 'LICENSE', 'Synthetic fixture permission\n');
  write(upstream, 'package.json', '{"name":"fixture-app","license":"MIT"}\n');
  write(upstream, 'packages/a/package.json', '{"name":"fixture-nested","license":"MIT"}\n');
  write(upstream, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  fixture-only@1.0.0: {}\n");
  write(upstream, 'shared.txt', 'base\n');
  write(upstream, 'deleted.txt', 'base\n');
  for (let i = 0; i < 11; i++) write(upstream, `count-${i}.txt`, 'base\n');
  commit(upstream, 'initial upstream');
  git(base, 'clone', '--no-hardlinks', upstream, repo);
  git(repo, 'config', 'user.name', 'Synthetic fixture'); git(repo, 'config', 'user.email', 'fixture@invalid');
  write(repo, 'shared.txt', 'fork\n');
  fs.unlinkSync(path.join(repo, 'deleted.txt'));
  write(repo, 'ours.txt', 'new fork file does not count\n');
  write(repo, 'tests/README.md', 'Run every suite:\n\n```bash\nWRANGLER_SEND_METRICS=false node --test tests/fixture.test.mjs\n```\n');
  commit(repo, 'fork additions and changes');
  const update = (changes = { 'fresh.txt': 'upstream addition\n' }) => {
    for (const [name, content] of Object.entries(changes)) write(upstream, name, content);
    commit(upstream, 'new upstream work');
  };
  const snapshot = () => {
    const result = Object.fromEntries([
      ['HEAD', ['rev-parse', 'HEAD']], ['refs', ['for-each-ref']], ['status', ['status', '--porcelain']], ['worktrees', ['worktree', 'list', '--porcelain']],
    ].map(([name, args]) => [name, git(repo, ...args)]));
    result.index = createHash('sha256').update(fs.readFileSync(path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'index').trim()))).digest('hex');
    return result;
  };
  async function report(settings = {}) {
    git(repo, 'fetch', 'origin', 'main');
    const before = snapshot();
    const temp = path.join(base, 'temporary'); fs.mkdirSync(temp);
    let workflowFile;
    if (settings.workflow !== undefined) {
      workflowFile = path.join(base, 'workflows.json');
      fs.writeFileSync(workflowFile, JSON.stringify({ workflows: settings.workflow === 'absent' ? [] : [{ path: '.github/workflows/sync-branches.yml', state: settings.workflow }] }));
    }
    const result = await runReport({ repo, upstream: 'origin/main', out, workflows: workflowFile }, {
      tmpdir: temp,
      now: () => new Date('2026-11-01T00:00:00Z'),
      fetch: async url => {
        fetches.push(url);
        assert.match(url, /^https:\/\/registry\.npmjs\.org\/@clawnify%2F[a-z]+\/latest$/);
        if (settings.unread && url.includes('%2Fqueue/')) throw new Error('REGISTRY-OTHER-FIELD-MARKER');
        return { ok: true, json: async () => ({ version: '1.2.3', ...(settings.licensed && url.includes('%2Fapp/') ? { license: 'MIT' } : {}), ...(settings.licenses && url.includes('%2Fconnections/') ? { licenses: [{ type: 'Apache-2.0' }] } : {}), description: 'REGISTRY-OTHER-FIELD-MARKER', dist: { tarball: 'REGISTRY-OTHER-FIELD-MARKER' } }) };
      },
      run: (program, args, options) => {
        if (program === 'git') {
          invocations.push(args);
          assert.ok(!args.includes('push'));
          return runCommand(program, args, options);
        }
        assert.equal(options.env.WRANGLER_SEND_METRICS, 'false');
        assert.ok(!Object.hasOwn(options.env, 'GITHUB_TOKEN'));
        const name = program === 'pnpm' ? (args[0] === 'exec' ? 'wiser-typecheck' : args[0]) : args[0] === '--test' ? 'tests' : args[1];
        steps.push(name);
        if (settings.throwStep === name) throw new Error('command exception');
        const failed = settings.fail === name;
        const output = name === 'lockfile' ? (failed || settings.missingPass === name ? 'LOCKFILE: FAIL' : 'LOCKFILE: PASS') : name === 'install-log' ? (failed || settings.missingPass === name ? 'INSTALL-LOG: FAIL' : 'INSTALL-LOG: PASS') : name === 'install' && failed ? `${settings.installMessage ?? (settings.frozen === false ? 'generic install error' : 'ERR_PNPM_OUTDATED_LOCKFILE')}\n${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}` : Array.from({ length: 50 }, (_, i) => `output ${i}`).join('\n');
        if (options.log) fs.writeFileSync(options.log, output);
        if (name === 'tests') assert.deepEqual(args, ['--test', 'tests/fixture.test.mjs']);
        if (name === 'install') assert.deepEqual(args, ['install', '--frozen-lockfile', '--reporter=ndjson']);
        assert.ok(options.env.HOME && options.env.HOME.startsWith(temp + path.sep), 'pnpm and node steps run with a scratch HOME');
        return { status: failed ? 1 : 0, output };
      },
    });
    assert.deepEqual(snapshot(), before, 'caller HEAD, refs, status and worktree list unchanged');
    assert.deepEqual(fs.readdirSync(temp), [], 'no temporary clone/worktree left');
    assert.ok(invocations.every(args => !args.includes('push')), 'no git push in setup or report');
    assert.equal(fetches.length, WATCH.length);
    assert.equal(new Set(fetches).size, WATCH.length);
    assert.ok(!fs.existsSync(path.join(repo, 'node_modules')));
    assert.equal(result.markdown.split('\n')[0], unmention(result.summary.verdict));
    assert.doesNotMatch(result.markdown, /@[A-Za-z0-9_-]/, 'no mention survives into the issue body');
    assert.deepEqual(JSON.parse(fs.readFileSync(result.jsonFile)), result.summary);
    assert.equal(fs.readFileSync(result.markdownFile, 'utf8'), result.markdown);
    return result;
  }
  return { base, repo, upstream, out, git, write, commit, update, report, steps, invocations };
}

const allSteps = ['lockfile', 'install', 'install-log', 'typecheck', 'wiser-typecheck', 'build', 'tests'];
test('no new upstream commits', async t => {
  const f = fixture(t), r = await f.report();
  assert.equal(r.summary.verdict, 'Nothing new.'); assert.deepEqual(f.steps, []);
  assert.equal(r.summary.merge.status, 'skipped');
});
test('clean merge passes and counts modified/deleted upstream files only', async t => {
  const f = fixture(t); f.update(); const r = await f.report();
  assert.equal(r.summary.verdict, 'Merges cleanly and every step passes.');
  assert.deepEqual(r.summary.f1, { count: 2, limit: 10, files: ['deleted.txt', 'shared.txt'] });
  assert.equal(r.summary.commits.length, 1); assert.deepEqual(r.summary.commits[0].files, ['fresh.txt']);
  assert.deepEqual(f.steps, allSteps);
  assert.equal(r.summary.steps.at(-1).output.split('\n').length, 40);
  assert.ok(fs.existsSync(path.join(f.out, 'install.ndjson')));
});
test('conflicting merge stops and lists files before install', async t => {
  const f = fixture(t); f.update({ 'shared.txt': 'upstream conflict\n' }); const r = await f.report();
  assert.match(r.summary.verdict, /^Stops: merge conflicts: shared\.txt/);
  assert.deepEqual(r.summary.merge.conflicts, ['shared.txt']); assert.deepEqual(f.steps, []);
});
for (const [name, changes, field] of [
  ['LICENSE', { LICENSE: 'changed permission\n' }, 'LICENSE SHA-256'],
  ['nested package licence', { 'packages/a/package.json': '{"name":"fixture-nested","license":"BSD-3-Clause"}' }, 'packages/a/package.json license'],
  ['new scope name in a comment', { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# string only: @clawnify/stand-in\n" }, 'pnpm-lock.yaml @clawnify/ names'],
  ['encoded scope name', { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# string only: %2540clawnify%252Fstand-in\n" }, 'pnpm-lock.yaml @clawnify/ names'],
  ['added package licence', { 'packages/new/package.json': '{"name":"fixture-new","license":"MIT"}' }, 'packages/new/package.json license'],
  ['removed licence field', { 'packages/a/package.json': '{"name":"fixture-nested"}' }, 'packages/a/package.json license'],
]) test(`F10 stops before copying or merging: ${name}`, async t => {
  const f = fixture(t); f.update(changes); const r = await f.report();
  assert.match(r.summary.verdict, /^Stops: F10:/); assert.equal(r.summary.f10[0].field, field);
  assert.equal(r.summary.merge.status, 'skipped'); assert.deepEqual(f.steps, []);
  assert.ok(!f.invocations.some(args => args.includes('--no-checkout')), 'no trial copy before F10');
});
test('lockfile check failure stops before install', async t => {
  const f = fixture(t); f.update(); const r = await f.report({ fail: 'lockfile' });
  assert.match(r.summary.verdict, /^Stops: lockfile check failed/); assert.deepEqual(f.steps, ['lockfile']);
});
test('LICENSE comparison hashes exact bytes rather than decoded text', async t => {
  const f = fixture(t);
  f.write(f.upstream, 'LICENSE', Buffer.from([0xff])); f.commit(f.upstream, 'binary licence baseline');
  f.git(f.repo, 'fetch', 'origin', 'main');
  f.git(f.repo, 'merge', '--no-ff', '--no-edit', 'origin/main');
  f.update({ LICENSE: Buffer.from([0xfe]) });
  const r = await f.report();
  assert.match(r.summary.verdict, /^Stops: F10: LICENSE SHA-256 changed/);
  assert.notEqual(r.summary.f10[0].before, r.summary.f10[0].after);
  assert.deepEqual(f.steps, []);
});
test('lockfile check requires PASS as well as zero exit', async t => {
  const f = fixture(t); f.update(); const r = await f.report({ missingPass: 'lockfile' });
  assert.match(r.summary.verdict, /^Stops: lockfile check failed/); assert.deepEqual(f.steps, ['lockfile']);
});
test('frozen-lockfile failure reports F9 without retry and keeps complete log', async t => {
  const f = fixture(t); f.update(); const r = await f.report({ fail: 'install' });
  assert.equal(r.summary.verdict, `Stops: F9: ${F9}`);
  assert.deepEqual(f.steps, ['lockfile', 'install', 'install-log']);
  assert.match(fs.readFileSync(path.join(f.out, 'install.ndjson'), 'utf8'), /ERR_PNPM_OUTDATED_LOCKFILE/);
});
test('generic install failure is not mislabelled F9', async t => {
  const f = fixture(t); f.update(); const r = await f.report({ fail: 'install', frozen: false });
  assert.equal(r.summary.verdict, 'Stops: pnpm install failed');
  assert.deepEqual(f.steps, ['lockfile', 'install', 'install-log']);
});
test('frozen-lockfile configuration mismatch reports F9', async t => {
  const f = fixture(t); f.update(); const r = await f.report({ fail: 'install', installMessage: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' });
  assert.equal(r.summary.verdict, `Stops: F9: ${F9}`);
  assert.deepEqual(f.steps, ['lockfile', 'install', 'install-log']);
});
test('F1 over 10 stops before install', async t => {
  const f = fixture(t);
  for (let i = 0; i < 9; i++) f.write(f.repo, `count-${i}.txt`, 'fork change\n');
  f.commit(f.repo, 'nine more upstream modifications'); f.update(); const r = await f.report();
  assert.match(r.summary.verdict, /^Stops: F1: 11 upstream files exceeds limit 10/);
  assert.equal(r.summary.f1.count, 11); assert.equal(r.summary.f1.files.length, 11); assert.deepEqual(f.steps, []);
});
test('install-log failure stops dependent builds and tests', async t => {
  const f = fixture(t); f.update(); const r = await f.report({ fail: 'install-log' });
  assert.match(r.summary.verdict, /^Stops: install-log check failed/); assert.deepEqual(f.steps, ['lockfile', 'install', 'install-log']);
});
for (const failed of ['typecheck', 'wiser-typecheck', 'build', 'tests']) test(`${failed} failure stops the verdict but independent steps still run`, async t => {
  const f = fixture(t); f.update(); const r = await f.report({ fail: failed });
  assert.equal(r.summary.verdict, `Stops: failed steps: ${failed}`); assert.deepEqual(f.steps, allSteps);
});
test('a thrown command still cleans the copy and produces a stop report', async t => {
  const f = fixture(t); f.update(); const r = await f.report({ throwStep: 'lockfile' });
  assert.match(r.summary.verdict, /^Stops: report check could not complete/); assert.deepEqual(f.steps, ['lockfile']);
});
test('registry licences lead, other fields never persist, failed reads are unread', async t => {
  const f = fixture(t), r = await f.report({ licensed: true, licenses: true, unread: true });
  assert.equal(r.summary.verdict, 'Nothing new.'); assert.deepEqual(f.steps, []);
  assert.equal(r.summary.licence_watch.find(p => p.name.endsWith('/queue')).status, 'unread');
  assert.equal(r.summary.alerts.filter(a => a.startsWith('LICENCE WATCH')).length, 2);
  const alert = r.markdown.indexOf(unmention('LICENCE WATCH: @clawnify/app version 1.2.3'));
  assert.ok(alert !== -1 && alert < r.markdown.indexOf('## 1.'));
  assert.match(r.markdown, /queue: unread \(read failed; licence unknown\)/);
  for (const file of fs.readdirSync(f.out)) assert.doesNotMatch(fs.readFileSync(path.join(f.out, file), 'utf8'), /REGISTRY-OTHER-FIELD-MARKER/);
});
for (const state of ['disabled_manually', 'active', 'absent']) test(`workflow state ${state}`, async t => {
  const f = fixture(t), r = await f.report({ workflow: state });
  assert.equal(r.summary.verdict, 'Nothing new.'); assert.deepEqual(f.steps, []);
  assert.equal(r.summary.workflow.warning, state !== 'disabled_manually');
  assert.equal(r.summary.alerts.some(a => a.startsWith('F8 WARNING')), state !== 'disabled_manually');
  if (state !== 'disabled_manually') assert.ok(r.markdown.indexOf('F8 WARNING') < r.markdown.indexOf('## 1.'));
});
for (const [name, changes, reason] of [
  ['a registry dependency on a scoped name', { 'package.json': '{"name":"fixture-app","license":"MIT","dependencies":{"@clawnify/new":"1.0.0"}}\n' }, /^Stops: scope preflight refused/],
  ['a root postinstall', { 'package.json': '{"name":"fixture-app","license":"MIT","scripts":{"postinstall":"node fetch.js"}}\n' }, /^Stops: root package\.json changed by the merge \(scripts\)/],
  ['a changed build script', { 'package.json': '{"name":"fixture-app","license":"MIT","scripts":{"build":"node fetch.js"}}\n' }, /^Stops: root package\.json changed by the merge \(scripts\)/],
  ['the pnpm field', { 'package.json': '{"name":"fixture-app","license":"MIT","pnpm":{"onlyBuiltDependencies":["fixture-only"]}}\n' }, /^Stops: root package\.json changed by the merge \(pnpm\)/],
  ['a file: dependency', { 'package.json': '{"name":"fixture-app","license":"MIT","dependencies":{"esbuild":"file:./vendor/esbuild"}}\n' }, /^Stops: root package\.json changed by the merge \(dependencies\)/],
  ['pnpm-workspace.yaml', { 'pnpm-workspace.yaml': 'overrides:\n  fixture-only: 2.0.0\n' }, /^Stops: pnpm-workspace\.yaml changed by the merge/],
  ['a pnpmfile', { '.pnpmfile.cjs': 'module.exports = {}\n' }, /^Stops: \.pnpmfile\.cjs changed by the merge/],
]) test(`install preflight stops before pnpm runs: ${name}`, async t => {
  const f = fixture(t); f.update(changes); const r = await f.report();
  assert.equal(r.summary.merge.status, 'clean'); assert.match(r.summary.verdict, reason);
  assert.deepEqual(f.steps, ['lockfile']); assert.ok(!fs.existsSync(path.join(f.out, 'install.ndjson')));
});
test('a version bump alone still installs, builds and tests', async t => {
  const f = fixture(t); f.update({ 'package.json': '{"name":"fixture-app","version":"9.9.9","description":"new","license":"MIT"}\n' }); const r = await f.report();
  assert.equal(r.summary.verdict, 'Merges cleanly and every step passes.'); assert.deepEqual(f.steps, allSteps);
});
test('a patch file pnpm names, changed upstream, stops before pnpm runs', async t => {
  const f = fixture(t);
  f.update({ 'package.json': '{"name":"fixture-app","license":"MIT","pnpm":{"patchedDependencies":{"fixture-only@1.0.0":"patches/fixture-only.patch"}}}\n', 'patches/fixture-only.patch': 'first\n' });
  f.git(f.repo, 'fetch', 'origin', 'main'); f.git(f.repo, 'merge', '--no-ff', '--no-edit', 'origin/main');
  f.update({ 'patches/fixture-only.patch': 'second\n' }); const r = await f.report();
  assert.match(r.summary.verdict, /^Stops: patches\/fixture-only\.patch changed by the merge/); assert.deepEqual(f.steps, ['lockfile']);
});
test('the trial copy has no remote back to the caller, and every report git call names safe.directory', async t => {
  const f = fixture(t); f.update(); const before = f.invocations.length; await f.report();
  const mine = f.invocations.slice(before).filter(args => args[0] === '-c' && args[1] === 'core.hooksPath=/dev/null');
  assert.ok(mine.length > 5 && mine.every(args => args[2] === '-c' && args[3] === 'safe.directory=*'));
  assert.ok(mine.some(args => args.slice(-3).join(' ') === 'remote remove origin'));
});
test('a fork that already merged upstream lists only the commits it lacks', async t => {
  const f = fixture(t); f.update({ 'first.txt': 'one\n' });
  f.git(f.repo, 'fetch', 'origin', 'main'); f.git(f.repo, 'merge', '--no-ff', '--no-edit', 'origin/main');
  f.update({ 'second.txt': 'two\n' }); const r = await f.report();
  assert.equal(r.summary.commits.length, 1); assert.deepEqual(r.summary.commits[0].files, ['second.txt']);
});
test('a commit subject naming someone is not a mention in the issue body', async t => {
  const f = fixture(t); f.write(f.upstream, 'thanks.txt', 'x\n'); f.commit(f.upstream, 'Thanks @someone and @clawnify/app');
  const r = await f.report();
  assert.equal(r.summary.commits[0].subject, 'Thanks @someone and @clawnify/app');
  assert.ok(r.markdown.includes(unmention('Thanks @someone and @clawnify/app')));
});
test('an entity-encoded @ or a tag in a subject cannot become a mention', async t => {
  const f = fixture(t); f.write(f.upstream, 'thanks.txt', 'x\n'); f.commit(f.upstream, 'Thanks &#64;clawnify &#x40;someone &commat;other <b>bold</b>');
  const r = await f.report();
  assert.ok(r.markdown.includes('Thanks &amp;#64;clawnify &amp;#x40;someone &amp;commat;other &lt;b>bold&lt;/b>'));
  assert.doesNotMatch(r.markdown.split('~~~~')[0], /&#|&commat;|<b>/);
});
test('a one-line verdict longer than the limit is still cut to fit an issue body', () => {
  const s = { verdict: `Stops: merge conflicts: ${'x'.repeat(70000)}`, alerts: [], last: 'a', new: 'b', f10: [], merge: { status: 'conflict', conflicts: [] }, f1: null, licence_watch: [], workflow: { state: 'not supplied', warning: false }, commits: [], steps: [] };
  const markdown = renderReport(s);
  assert.ok(markdown.length <= 65536); assert.match(markdown, /Report truncated at 60000 characters/);
});
test('a report too long for an issue body is cut below the limit with the verdict and alerts kept', () => {
  const s = { verdict: 'Stops: failed steps: tests', alerts: ['F8 WARNING: sync-branches.yml is active'], last: 'a', new: 'b', f10: [], merge: { status: 'clean', conflicts: [] }, f1: null, licence_watch: [], workflow: { state: 'active', warning: true },
    commits: [{ id: 'abc1234', date: '2026-11-01', subject: 'many files', files: Array.from({ length: 4000 }, (_, i) => `src/generated/file-${i}.ts`) }],
    steps: [{ name: 'tests', command: 'node --test', status: 'FAIL', exit: 1, output: 'x'.repeat(200) }] };
  const markdown = renderReport(s);
  assert.ok(markdown.length <= 65536 && REPORT_LIMIT < 65536);
  assert.ok(markdown.startsWith('Stops: failed steps: tests')); assert.match(markdown, /F8 WARNING/); assert.match(markdown, /Report truncated at 60000 characters/);
  const short = renderReport({ ...s, commits: [] }); assert.doesNotMatch(short, /truncated/);
});
test('argument validation needs no network or package manager', () => {
  assert.deepEqual(argumentsFor(['--repo', '.', '--upstream', 'clawnify/main', '--out', '/tmp/report']), { repo: '.', upstream: 'clawnify/main', out: '/tmp/report', workflows: undefined });
  for (const args of [[], ['--repo'], ['--nope', 'a'], ['--repo', '.', '--repo', '.']]) assert.throws(() => argumentsFor(args));
});

// Opt-in mutation controls run the same tests against a broken scratch copy.
// They never alter the production module, and every network/pnpm call stays stubbed.
test('deliberately broken stop checks are caught by their tests', { skip: process.env.WISER_REPORT_CONTROLS !== '1' }, t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiser-upstream-controls-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = fs.readFileSync(sourceFile, 'utf8');
  const tests = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const controls = [
    ['conflict', 'if (merge.error || merge.status !== 0)', 'if (false)', '^conflicting merge stops'],
    ['LICENSE', 'before.license_sha256 !== after.license_sha256', 'false', '^(F10 stops before copying or merging: LICENSE$|LICENSE comparison hashes exact bytes)'],
    ['package licence', 'canonical(a) !== canonical(b)', 'false', '^F10 stops before copying or merging: (nested package licence|added package licence|removed licence field)$'],
    ['scope names', 'canonical(before.scope) !== canonical(after.scope)', 'false', '^F10 stops before copying or merging: (new scope name in a comment|encoded scope name)$'],
    ['lockfile', "if (lock.status !== 'PASS')", 'if (false)', '^lockfile check (failure stops|requires PASS)'],
    ['frozen install', "if (install.status !== 'PASS')", 'if (false)', '^(frozen-lockfile|generic install failure)'],
    ['F1', 'summary.f1.count > summary.f1.limit', 'false', '^F1 over 10 stops'],
    ['install audit', "if (audit.status !== 'PASS')", 'if (false)', '^install-log failure stops'],
    ['failed checks', 'if (failed.length)', 'if (false)', '^(typecheck|wiser-typecheck|build|tests) failure stops'],
    ['licence watch', 'entry.has_licence = Boolean(declared(entry.license) || declared(entry.licenses))', 'entry.has_licence = false', '^registry licences lead'],
    ['workflow warning', "warning: state !== 'disabled_manually'", 'warning: false', '^workflow state active$'],
    ['scope preflight', 'try { noScopeRegistry(copy); } catch {', 'try { } catch {', '^install preflight stops before pnpm runs: a registry dependency'],
    ['root package.json', 'if (changed.length)', 'if (false)', '^install preflight stops before pnpm runs: (a root postinstall|a changed build script|the pnpm field|a file: dependency)$'],
    ['patch files', '...INSTALL_CONFIG, ...patches]', '...INSTALL_CONFIG]', '^a patch file pnpm names'],
    ['entity escape', ".replaceAll('&', '&amp;')", '', '^an entity-encoded @'],
    ['install config', 'if ((before === null) !== (after === null) || (before && !Buffer.from(before).equals(after)))', 'if (false)', '^install preflight stops before pnpm runs: (pnpm-workspace\\.yaml|a pnpmfile)$'],
    ['origin removed', "git(copy, ['remote', 'remove', 'origin']);", '', '^the trial copy has no remote'],
    ['mentions', ".replace(/@(?=[A-Za-z0-9_-])/g, '@' + String.fromCharCode(0x2060))", '', '^a commit subject naming someone'],
    ['hard cut', 'if (cut < 1) cut = REPORT_LIMIT - 200;', '', '^a one-line verdict longer'],
  ];
  const childEnv = { ...process.env, WISER_REPORT_CONTROLS: '0' };
  // Node otherwise treats the child --test process as recursive and runs no files.
  delete childEnv.NODE_TEST_CONTEXT;
  fs.writeFileSync(path.join(base, 'upstream-report.test.mjs'), tests);
  fs.copyFileSync(fileURLToPath(new URL('./build.mjs', import.meta.url)), path.join(base, 'build.mjs'));
  for (const [name, from, to, pattern] of controls) {
    assert.ok(source.includes(from), `mutation target: ${name}`);
    fs.writeFileSync(path.join(base, 'upstream-report.mjs'), source.replace(from, to));
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, path.join(base, 'upstream-report.test.mjs')], { encoding: 'utf8', env: childEnv });
    assert.equal(result.status, 1, `broken ${name} must fail its test: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /ERR_ASSERTION/);
    t.diagnostic(`Broken ${name}: test exited 1 with ERR_ASSERTION (${pattern}).`);
    // Restore the scratch module and prove the same selected test passes.
    fs.writeFileSync(path.join(base, 'upstream-report.mjs'), source);
    const restored = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, path.join(base, 'upstream-report.test.mjs')], { encoding: 'utf8', env: childEnv });
    assert.equal(restored.status, 0, `restored ${name}: ${restored.stdout}${restored.stderr}`);
  }
});
