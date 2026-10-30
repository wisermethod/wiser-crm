import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { checkRelease, keyFromSeed, printResult, printSummary, readHidden, signRelease } from './sign.mjs';
import * as signing from './sign.mjs';

const signer = fileURLToPath(new URL('./sign.mjs', import.meta.url));
const keyFile = fileURLToPath(new URL('./key.json', import.meta.url));
const committed = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, null, 2) + '\n';
function throwaway() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { seed: Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'), expected: { id: hash(raw).slice(0, 16), ed25519: raw.toString('base64') } };
}

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiser-crm-sign-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const release = path.join(base, 'wiser-crm', '0.1.0');
  const files = path.join(release, 'files');
  fs.mkdirSync(files, { recursive: true });
  function record(bytes) {
    const sha256 = hash(bytes);
    fs.writeFileSync(path.join(files, sha256), bytes);
    return { sha256, size: Buffer.byteLength(bytes) };
  }
  const shared = record('export default {};\n');
  const manifest = {
    format: 2, app: 'wiser-crm', version: '0.1.0', created: '2026-10-30T12:00:00.000Z',
    source: { repository: 'wisermethod/wiser-crm', commit: 'a'.repeat(40), upstream_commit: 'b'.repeat(40), f1: { count: 10, limit: 10 } },
    checks: { lockfile: 'PASS', install_log: 'PASS', bundle_inputs: 'PASS' },
    worker: { main_module: 'index.js', compatibility_date: '2025-04-01', compatibility_flags: ['nodejs_compat'], d1_binding: 'DB', assets_binding: 'ASSETS', vars_required: ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'AGENT_CLIENT_ID', 'WISER_INSTANCE', 'WISER_READ_ONLY'], modules: [
      { name: 'data.bin', type: 'application/octet-stream', ...record(Buffer.from([0, 1, 255])) },
      { name: 'index.js', type: 'application/javascript+module', ...shared },
    ] },
    assets: { config: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application', run_worker_first: true }, files: [
      { path: '/app.js', ...shared, content_type: 'application/javascript' },
      { path: '/index.html', ...record('<h1>fixture</h1>\n'), content_type: 'text/html; charset=utf-8' },
    ] },
    migrations: { table: 'd1_migrations', files: [{ name: '0001_baseline.sql', ...record('SELECT 1;\n') }] },
  };
  const manifestFile = path.join(release, 'manifest.json');
  const save = () => fs.writeFileSync(manifestFile, canonical(manifest));
  save();
  return { base, release, files, manifestFile, manifest, save, record, ...throwaway() };
}

// Record links themselves, never follow them, and include empty directories.
function snapshot(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix)).sort().flatMap(name => {
    const relative = path.join(prefix, name), file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return [[relative, 'link', fs.readlinkSync(file)]];
    if (stat.isDirectory()) return [[relative, 'directory'], ...snapshot(root, relative)];
    return [[relative, 'file', fs.readFileSync(file).toString('hex'), stat.mode & 0o777]];
  });
}
function unchanged(f, before, hasSignature = false) {
  assert.equal(fs.existsSync(path.join(f.release, 'manifest.sig')), hasSignature);
  assert.deepEqual(snapshot(f.base), before);
}
function capture() {
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  return { output, text: () => text };
}
function secretAbsent(text, seed) {
  assert.ok(!text.includes(seed), 'seed text must never be disclosed');
}
async function verifies(f, signature, bytes = fs.readFileSync(f.manifestFile)) {
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(f.expected.ed25519, 'base64'), { name: 'Ed25519' }, false, ['verify']);
  return webcrypto.subtle.verify('Ed25519', key, signature, bytes);
}

test('signs exact manifest bytes, deduplicates counts, mode 0644 and one JSON output line', async t => {
  const f = fixture(t), checked = checkRelease(f.release), before = snapshot(f.base);
  assert.equal(checked.fileCount, 4);
  const result = await signRelease(f.release, ` \n${f.seed}\t `, f.expected);
  const signature = fs.readFileSync(path.join(f.release, 'manifest.sig'));
  assert.equal(signature.length, 64);
  assert.equal(fs.statSync(path.join(f.release, 'manifest.sig')).mode & 0o777, 0o644);
  assert.equal(await verifies(f, signature), true);
  assert.deepEqual(snapshot(f.base).filter(([name]) => !name.endsWith('manifest.sig')), before);
  const expected = { release: f.release, app: 'wiser-crm', version: '0.1.0', key_id: f.expected.id, manifest_sha256: hash(fs.readFileSync(f.manifestFile)), signature: 'manifest.sig' };
  secretAbsent(JSON.stringify(result), f.seed);
  assert.deepEqual(result, expected);
  const out = capture();
  printResult(result, out.output);
  assert.equal(out.text(), JSON.stringify(expected) + '\n');
  secretAbsent(out.text(), f.seed);
  const summary = capture();
  printSummary(checked, summary.output);
  for (const value of ['wiser-crm', '0.1.0', f.manifest.source.commit, f.manifest.source.upstream_commit, 'F1: 10 / 10', 'lockfile: PASS', 'install_log: PASS', 'bundle_inputs: PASS', 'modules: 2', 'assets: 2', 'migrations: 1', 'unique files: 4', `total bytes: ${checked.totalBytes}`, hash(fs.readFileSync(f.manifestFile))]) assert.ok(summary.text().includes(value), `summary missing ${value}`);
  secretAbsent(summary.text(), f.seed);
});

const refusals = [
  ['existing signature', f => fs.writeFileSync(path.join(f.release, 'manifest.sig'), 'keep this signature'), /already exists/, true],
  ['missing referenced file', f => fs.unlinkSync(path.join(f.files, f.manifest.worker.modules[0].sha256)), /file set/],
  ['bytes do not match digest', f => fs.writeFileSync(path.join(f.files, f.manifest.worker.modules[0].sha256), 'wrong bytes'), /digest/],
  ['size mismatch on shared asset', f => { f.manifest.assets.files[0].size++; f.save(); }, /size/],
  ['unreferenced file', f => fs.writeFileSync(path.join(f.files, hash('extra')), 'extra'), /file set/],
  ['extra release entry', f => fs.writeFileSync(path.join(f.release, 'extra'), 'extra'), /exactly/],
  ['symlinked manifest', f => { fs.renameSync(f.manifestFile, path.join(f.base, 'manifest-original')); fs.symlinkSync(path.join(f.base, 'manifest-original'), f.manifestFile); }, /regular file/],
  ['symlinked content', f => { const file = path.join(f.files, f.manifest.worker.modules[0].sha256); fs.renameSync(file, path.join(f.base, 'file-original')); fs.symlinkSync(path.join(f.base, 'file-original'), file); }, /regular files/],
  ['content subdirectory', f => { const file = path.join(f.files, f.manifest.worker.modules[0].sha256); fs.unlinkSync(file); fs.mkdirSync(file); }, /regular files/],
  ['noncanonical manifest', f => fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest)), /canonical/],
  ['version mismatch', f => { f.manifest.version = '0.2.0'; f.save(); }, /version/],
  ['wrong app', f => { f.manifest.app = 'other'; f.save(); }, /release names another version/],
  ['format 1', f => { f.manifest.format = 1; f.save(); }, /release manifest malformed/],
  ...['lockfile', 'install_log', 'bundle_inputs'].map(name => [`${name} not PASS`, f => { f.manifest.checks[name] = 'FAIL'; f.save(); }, /release checks malformed/]),
  ['extra failing check', f => { f.manifest.checks.extra = 'FAIL'; f.save(); }, /release checks malformed/],
  ['missing check', f => { delete f.manifest.checks.lockfile; f.save(); }, /release checks malformed/],
  ['F1 overflow', f => { f.manifest.source.f1.count++; f.save(); }, /release source malformed/],
  ['invalid UTF-8', f => fs.writeFileSync(f.manifestFile, Buffer.from([0xc3, 0x28])), /UTF-8/],
  ['invalid JSON', f => fs.writeFileSync(f.manifestFile, '{\n'), /JSON/],
  ['manifest over 1 MiB', f => fs.writeFileSync(f.manifestFile, ' '.repeat(1024 * 1024 + 1)), /1 MiB/],
  ...['commit', 'upstream_commit'].map(name => [`invalid ${name}`, f => { f.manifest.source[name] = 'A'.repeat(40); f.save(); }, /release source malformed/]),
  ['invalid digest record', f => { f.manifest.worker.modules[0].sha256 = '../outside'; f.save(); }, /release module malformed/],
  ['negative size', f => { f.manifest.worker.modules[0].size = -1; f.save(); }, /release module malformed/],
];
for (const [name, mutate, reason, hasSignature] of refusals) {
  test(`refuses ${name} without changing release files`, async t => {
    const f = fixture(t); mutate(f);
    const before = snapshot(f.base);
    await assert.rejects(signRelease(f.release, f.seed, f.expected), reason);
    unchanged(f, before, hasSignature);
  });
}
for (const [name, input, reason] of [
  ['relative path', f => path.relative(process.cwd(), f.release), /absolute/],
  ['memory segment', f => path.join(f.base, 'memory/wiser-crm/0.1.0'), /memory or .env/],
  ['case-insensitive memory segment', f => path.join(f.base, 'Memory/wiser-crm/0.1.0'), /memory or .env/],
  ['.env segment', f => path.join(f.base, '.env.local/wiser-crm/0.1.0'), /memory or .env/],
  ['wrong release layout', f => f.base, /wiser-crm/],
]) test(`refuses ${name} without writing`, async t => {
  const f = fixture(t), before = snapshot(f.base);
  await assert.rejects(signRelease(input(f), f.seed, f.expected), reason);
  unchanged(f, before);
});

for (const [name, text] of [
  ['43 characters', seed => seed.slice(0, -1)],
  ['45 characters', seed => seed + '='],
  ['non-base64 character', seed => '!' + seed.slice(1)],
  ['noncanonical base64', seed => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    return seed.slice(0, 42) + alphabet[alphabet.indexOf(seed[42]) | 1] + '=';
  }],
]) test(`refuses key with ${name} without disclosure or writes`, async t => {
  const f = fixture(t), seed = text(f.seed), before = snapshot(f.base);
  let error;
  try { keyFromSeed(seed, f.expected); } catch (e) { error = e; }
  assert.ok(error, 'key must be refused');
  assert.match(error.message, /32-byte.*44 characters.*base64/);
  secretAbsent(error.message, seed);
  await assert.rejects(signRelease(f.release, seed, f.expected), e => { secretAbsent(e.message, seed); return /32-byte.*44 characters.*base64/.test(e.message); });
  unchanged(f, before);
});
test('refuses a throwaway seed against the committed release key without disclosure', async t => {
  const f = fixture(t), before = snapshot(f.base);
  await assert.rejects(signRelease(f.release, f.seed, committed), e => {
    secretAbsent(e.message, f.seed);
    return /This key is not release key 67d424dc40b23ed9\./.test(e.message);
  });
  unchanged(f, before);
});
test('refuses a mismatched public key id', async t => {
  const f = fixture(t), before = snapshot(f.base);
  await assert.rejects(signRelease(f.release, f.seed, { ...f.expected, id: '0'.repeat(16) }), e => { secretAbsent(e.message, f.seed); return /not release key/.test(e.message); });
  unchanged(f, before);
});

test('refuses a changed manifest immediately before writing', async t => {
  const f = fixture(t);
  let before;
  await assert.rejects(signRelease(f.release, f.seed, f.expected, { beforeWrite() {
    f.manifest.created = '2026-10-30T13:00:00.000Z'; f.save(); before = snapshot(f.base);
  } }), /manifest.*changed/);
  unchanged(f, before);
});
test('an exclusive-create race preserves the other signature', async t => {
  const f = fixture(t);
  let before;
  await assert.rejects(signRelease(f.release, f.seed, f.expected, { beforeWrite() {
    fs.writeFileSync(path.join(f.release, 'manifest.sig'), 'another signer'); before = snapshot(f.base);
  } }), /signature/);
  unchanged(f, before, true);
});
test('a failed read-back verification removes only the new signature', async t => {
  const f = fixture(t), before = snapshot(f.base), original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const bytes = original.call(this, file, ...args);
    return file === path.join(f.release, 'manifest.sig') ? Buffer.alloc(64) : bytes;
  });
  await assert.rejects(signRelease(f.release, f.seed, f.expected), /read-back/);
  unchanged(f, before);
});

test('CLI refuses a pipe before reading a seed and prints the checked summary', t => {
  const f = fixture(t), before = snapshot(f.base);
  const result = spawnSync(process.execPath, [signer, f.release], { input: f.seed, encoding: 'utf8' });
  secretAbsent(result.stdout + result.stderr, f.seed);
  assert.equal(result.status, 1);
  assert.ok(result.stdout === '', 'CLI stdout must be empty on refusal');
  assert.match(result.stderr, /Run this in your own Terminal; the key is read only from a hidden prompt\./);
  assert.match(result.stderr, /manifest SHA-256:/);
  secretAbsent(result.stdout + result.stderr, f.seed);
  unchanged(f, before);
});
test('CLI checks release before rejecting a pipe', t => {
  const f = fixture(t); f.manifest.format = 1; f.save();
  const before = snapshot(f.base);
  const result = spawnSync(process.execPath, [signer, f.release], { input: f.seed, encoding: 'utf8' });
  secretAbsent(result.stdout + result.stderr, f.seed);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release manifest malformed/);
  assert.doesNotMatch(result.stderr, /hidden prompt/);
  assert.ok(result.stdout === '', 'CLI stdout must be empty on refusal');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  secretAbsent(result.stderr, f.seed);
  unchanged(f, before);
});
test('CLI refuses missing, relative, flag and extra arguments', t => {
  const f = fixture(t), before = snapshot(f.base);
  for (const args of [[], ['relative'], ['--help'], [f.release, 'extra']]) {
    const result = spawnSync(process.execPath, [signer, ...args], { encoding: 'utf8', input: '' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /one absolute release directory/);
    assert.equal(result.stderr.trim().split('\n').length, 1);
    unchanged(f, before);
  }
});

function tty() {
  const input = new PassThrough(), modes = [], out = capture();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { modes.push(value); input.isRaw = value; };
  return { input, modes, ...out };
}
for (const name of ['one chunk', 'three chunks', 'backspace', 'delete', 'bracketed paste', 'split bracketed paste', 'LF Enter']) {
  test(`hidden prompt accepts ${name} without echo`, async () => {
    const f = tty(), { seed } = throwaway(), pending = readHidden(f.input, f.output, 'Key: ');
    let chunks;
    if (name === 'one chunk') chunks = [seed + '\r'];
    if (name === 'three chunks') chunks = [seed.slice(0, 10), seed.slice(10, 30), seed.slice(30) + '\r'];
    if (name === 'backspace' || name === 'delete') chunks = [seed.slice(0, 10) + '!' + (name === 'backspace' ? '\b' : '\x7f') + seed.slice(10) + '\r'];
    if (name === 'bracketed paste') chunks = ['\x1b[200~' + seed + '\x1b[201~\r'];
    if (name === 'split bracketed paste') chunks = ['\x1b[2', '00~' + seed.slice(0, 20), seed.slice(20) + '\x1b[20', '1~\r'];
    if (name === 'LF Enter') chunks = [seed + '\n'];
    for (const chunk of chunks) f.input.write(chunk);
    assert.ok(await pending === seed, 'hidden input mismatch');
    assert.deepEqual(f.modes, [true, false]);
    assert.ok(f.text() === 'Key: \n', 'hidden output must contain only the prompt and newline');
    secretAbsent(f.text(), seed);
    assert.equal(f.input.listenerCount('data'), 0);
    assert.equal(f.input.listenerCount('error'), 0);
  });
}
for (const [name, finish] of [
  ['Ctrl-C', f => f.input.write('\x03')],
  ['Ctrl-D', f => f.input.write('\x04')],
  ['stream error', f => f.input.emit('error', new Error('terminal failure'))],
  ['stream end', f => f.input.end()],
  ['stream close', f => f.input.destroy()],
]) test(`hidden prompt restores raw mode after ${name}`, async () => {
  const f = tty(), { seed } = throwaway(), pending = readHidden(f.input, f.output, 'Key: ');
  const refused = assert.rejects(pending, /aborted|hidden prompt/);
  f.input.write(seed.slice(0, 20)); finish(f);
  await refused;
  assert.deepEqual(f.modes, [true, false]);
  secretAbsent(f.text(), seed);
  assert.ok(f.text() === 'Key: ', 'aborted output must contain only the prompt');
});
test('hidden prompt restores raw mode on a synchronous prompt exception', async () => {
  const f = tty();
  f.output.write = () => { throw new Error('output failed'); };
  await assert.rejects(readHidden(f.input, f.output, 'Key: '), /hidden prompt/);
  assert.deepEqual(f.modes, [true, false]);
});
test('hidden prompt itself refuses a non-TTY without reading or enabling raw mode', async () => {
  const f = tty(); f.input.isTTY = false;
  await assert.rejects(readHidden(f.input, f.output, 'Key: '), /own Terminal/);
  assert.deepEqual(f.modes, []);
  assert.equal(f.text(), '');
});
test('hidden prompt supports an EventEmitter TTY without flow-control methods', async () => {
  const f = tty(), input = new EventEmitter(), { seed } = throwaway();
  input.isTTY = true;
  input.setRawMode = value => f.modes.push(value);
  const pending = readHidden(input, f.output, 'Key: ');
  input.emit('data', Buffer.from(seed + '\r'));
  assert.ok(await pending === seed, 'hidden input mismatch');
  assert.deepEqual(f.modes, [true, false]);
  assert.ok(f.text() === 'Key: \n', 'hidden output must contain only the prompt and newline');
});

test('committed public key has exact shape, canonical bytes and matching id', () => {
  assert.deepEqual(Object.keys(committed), ['id', 'ed25519']);
  assert.deepEqual(committed, { id: '67d424dc40b23ed9', ed25519: 'MeXSDrYhrdC7XE1m8LFX5SPkOA6RXXWaSgmPPVoZf48=' });
  assert.equal(fs.readFileSync(keyFile, 'utf8'), canonical(committed));
  const raw = Buffer.from(committed.ed25519, 'base64');
  assert.equal(raw.length, 32);
  assert.equal(committed.id, hash(raw).slice(0, 16));
});


const wiserRefusals = [
  ['empty module list', f => { fs.unlinkSync(path.join(f.files, f.manifest.worker.modules[0].sha256)); f.manifest.worker.modules = []; }, 'release worker malformed'],
  ['duplicate module name', f => { f.manifest.worker.modules.push({ ...f.manifest.worker.modules[0] }); }, 'release module malformed'],
  ['module type mismatching extension', f => { f.manifest.worker.modules[0].type = 'text/plain'; }, 'release module malformed'],
  ['top-level key out of order', f => { const { format, ...rest } = f.manifest; f.manifest = { ...rest, format }; }, 'release manifest malformed'],
  ['nested key out of order', f => { const { repository, ...rest } = f.manifest.source; f.manifest.source = { ...rest, repository }; }, 'release source malformed'],
  ['missing created', f => { delete f.manifest.created; }, 'release manifest malformed'],
  ['wrong source.repository', f => { f.manifest.source.repository = 'other/repository'; }, 'release source malformed'],
  ['record total over 64 MiB with honest repeated digests', f => {
    // 65 distinct paths reference one real 1 MiB file: Wiser sums records, not hashes.
    const shared = f.record(Buffer.alloc(1024 * 1024, 42));
    for (let i = 0; i < 65; i++) f.manifest.assets.files.push({ path: `/shared-${i}.bin`, ...shared, content_type: 'application/octet-stream' });
    assert.equal(fs.statSync(path.join(f.files, shared.sha256)).size, shared.size);
    assert.ok(f.manifest.assets.files.reduce((n, file) => n + file.size, 0) > 64 * 1024 * 1024);
  }, 'release exceeds 64 MiB total'],
  ['main_module absent from modules', f => { f.manifest.worker.main_module = 'absent.js'; }, 'release main module missing'],
  ['invalid created date', f => { f.manifest.created = '2026-02-30T12:00:00.000Z'; }, 'release manifest malformed'],
  ['invalid compatibility date', f => { f.manifest.worker.compatibility_date = '2026-02-30'; }, 'release worker malformed'],
  ['duplicate compatibility flag', f => { f.manifest.worker.compatibility_flags.push('nodejs_compat'); }, 'release worker malformed'],
  ['colliding bindings', f => { f.manifest.worker.assets_binding = 'DB'; }, 'release worker malformed'],
  ['secret variable name', f => { f.manifest.worker.vars_required.push('API_TOKEN'); }, 'release worker malformed'],
  ['duplicate asset path', f => { f.manifest.assets.files.push({ ...f.manifest.assets.files[0] }); }, 'release asset malformed'],
  ['invalid asset MIME', f => { f.manifest.assets.files[0].content_type = 'text/plain\r\nextra'; }, 'release asset malformed'],
  ['invalid assets config', f => { f.manifest.assets.config.run_worker_first = false; }, 'release assets malformed'],
  ['duplicate migration name', f => { f.manifest.migrations.files.push({ ...f.manifest.migrations.files[0] }); }, 'release migration malformed'],
  ['invalid migration table', f => { f.manifest.migrations.table = 'bad-table'; }, 'release migrations malformed'],
  ['file over 25 MiB', f => { f.manifest.worker.modules[0].size = 25 * 1024 * 1024 + 1; }, 'release module malformed'],
];
for (const [name, mutate, reason] of wiserRefusals) {
  test(`Wiser parity refuses ${name} without changing the directory`, async t => {
    const f = fixture(t); mutate(f);
    fs.writeFileSync(f.manifestFile, canonical(f.manifest));
    const before = snapshot(f.base);
    await assert.rejects(signRelease(f.release, f.seed, f.expected), { message: reason });
    unchanged(f, before);
  });
}

test('Wiser predicates run before inspecting content files', t => {
  const f = fixture(t); delete f.manifest.created; f.save();
  fs.rmSync(f.files, { recursive: true });
  fs.writeFileSync(f.files, 'not a directory');
  const before = snapshot(f.base);
  assert.throws(() => checkRelease(f.release), { message: 'release manifest malformed' });
  unchanged(f, before);
});

test('read-back refuses manifest replacement after the signature write', async t => {
  const f = fixture(t);
  let before;
  await assert.rejects(signRelease(f.release, f.seed, f.expected, { afterWrite() {
    f.manifest.created = '2026-10-30T14:00:00.000Z'; f.save();
    before = snapshot(f.base).filter(([name]) => !name.endsWith('manifest.sig'));
  } }), /read-back/);
  unchanged(f, before);
});

test('atomic publication links a complete synced file and preserves a racing signature', async t => {
  const f = fixture(t), originalLink = fs.linkSync, originalSync = fs.fsyncSync;
  let before, linked = false, synced = false;
  t.mock.method(fs, 'fsyncSync', function (fd) { synced = true; return originalSync.call(this, fd); });
  t.mock.method(fs, 'linkSync', function (temp, destination) {
    linked = true;
    assert.equal(synced, true);
    assert.equal(fs.readFileSync(temp).length, 64);
    assert.equal(fs.existsSync(destination), false);
    fs.writeFileSync(destination, 'another signer');
    before = snapshot(f.base).filter(([name]) => !name.endsWith('.tmp'));
    return originalLink.call(this, temp, destination);
  });
  await assert.rejects(signRelease(f.release, f.seed, f.expected), /signature/);
  assert.equal(linked, true, 'signature must be published by linkSync');
  unchanged(f, before, true);
  assert.deepEqual(fs.readdirSync(f.release).sort(), ['files', 'manifest.json', 'manifest.sig']);
});

test('leftover signature temporary file refusal names the file to remove', t => {
  const f = fixture(t), name = '.manifest.sig.123.tmp';
  fs.writeFileSync(path.join(f.release, name), '');
  const before = snapshot(f.base);
  assert.throws(() => checkRelease(f.release), error => /remove/i.test(error.message) && error.message.includes(name));
  unchanged(f, before);
});

for (const [name, chunks] of [
  ['arrow key mid-input', ['abc\x1b[Adef\r']],
  ['CSI split across chunks', ['abc\x1b', '[1;', '5', 'Ddef\r']],
  ['CSI intermediate byte', ['abc\x1b[1', ' ', 'qdef\r']],
  ['SS3 split across chunks', ['abc\x1b', 'O', 'Ddef\r']],
  ['bracketed paste with arrows', ['\x1b[200~abc\x1b[Bdef\x1b[201~\r']],
]) test(`escape handling accepts ${name} without echo or early restore`, async () => {
  const f = tty(), pending = readHidden(f.input, f.output, 'Key: ');
  const settled = pending.then(value => ({ value }), error => ({ error }));
  for (const chunk of chunks) f.input.write(chunk);
  const result = await settled;
  assert.equal(result.error, undefined);
  assert.equal(result.value, 'abcdef');
  assert.deepEqual(f.modes, [true, false]);
  assert.equal(f.text(), 'Key: \n');
});

const earlyMessage = 'Input arrived before the prompt; nothing was signed. Run again and paste only after the prompt appears.';
function callMain(f, input, out = capture(), err = capture()) {
  assert.equal(typeof signing.main, 'function', 'main must support injected streams');
  return { pending: signing.main({ argv: [f.release], stdin: input, stdout: out.output, stderr: err.output }), out, err };
}

test('main non-TTY refusal performs zero reads and installs no data listener', async t => {
  const f = fixture(t), before = snapshot(f.base), input = new EventEmitter();
  let reads = 0;
  input.isTTY = false;
  input.read = input.resume = () => { reads++; throw new Error('must never read'); };
  input.on = function (event, listener) {
    if (event === 'data') { reads++; throw new Error('must never listen for data'); }
    return EventEmitter.prototype.on.call(this, event, listener);
  };
  const { pending, out, err } = callMain(f, input);
  await assert.rejects(pending, /own Terminal/);
  assert.equal(reads, 0);
  assert.equal(out.text(), '');
  secretAbsent(err.text(), f.seed);
  unchanged(f, before);
});

for (const wasRaw of [false, true]) test(`main refuses pre-prompt data and restores original raw=${wasRaw}`, async t => {
  const f = fixture(t), before = snapshot(f.base), terminal = tty(), err = capture();
  terminal.input.isRaw = wasRaw;
  const originalWrite = err.output.write.bind(err.output);
  let sent = false;
  err.output.write = (...args) => {
    assert.equal(terminal.input.isRaw, true, 'echo must already be off during summary');
    if (!sent) { sent = true; terminal.input.emit('data', Buffer.from(f.seed + '\r')); }
    if (String(args[0]).includes('Release key (hidden):')) setImmediate(() => terminal.input.emit('data', Buffer.from('\x04')));
    return originalWrite(...args);
  };
  const { pending, out } = callMain(f, terminal.input, capture(), err);
  await assert.rejects(pending, { message: earlyMessage });
  assert.equal(terminal.modes[0], true);
  assert.equal(terminal.modes.at(-1), wasRaw);
  assert.equal(terminal.input.isRaw, wasRaw);
  assert.equal(terminal.input.listenerCount('data'), 0);
  assert.doesNotMatch(err.text(), /Release key \(hidden\):/);
  secretAbsent(out.text() + err.text(), f.seed);
  unchanged(f, before);
});

test('main catches pre-prompt input queued while the synchronous release check runs', async t => {
  const f = fixture(t), terminal = tty(), before = snapshot(f.base);
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === f.manifestFile) {
      assert.equal(terminal.input.isRaw, true);
      setImmediate(() => terminal.input.write(f.seed + '\r'));
    }
    return original.call(this, file, ...args);
  });
  const { pending, out, err } = callMain(f, terminal.input);
  await assert.rejects(pending, { message: earlyMessage });
  assert.equal(terminal.input.isRaw, false);
  t.mock.restoreAll();
  assert.doesNotMatch(err.text(), /Release key \(hidden\):/);
  secretAbsent(out.text() + err.text(), f.seed);
  unchanged(f, before);
});

test('main restores mode and process listeners after release check or prompt failure', async t => {
  const f = fixture(t), modules = f.manifest.worker.modules;
  for (const event of ['check', 'prompt']) {
    const terminal = tty(), err = capture();
    const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'];
    const counts = events.map(name => process.listenerCount(name));
    if (event === 'check') { f.manifest.worker.modules = []; f.save(); }
    else { f.manifest.worker.modules = modules; f.save(); }
    const current = snapshot(f.base);
    if (event === 'prompt') err.output.write = text => { if (text.includes('Release key (hidden):')) throw new Error('output failed'); return true; };
    const { pending } = callMain(f, terminal.input, capture(), err);
    await assert.rejects(pending, event === 'check' ? /worker malformed/ : /hidden prompt/);
    assert.equal(terminal.input.isRaw, false);
    assert.deepEqual(events.map(name => process.listenerCount(name)), counts);
    unchanged(f, current);
  }
});


for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) test(`main restores terminal on ${signal} and leaves the release unchanged`, t => {
  const f = fixture(t), before = snapshot(f.base);
  const code = `
    import { EventEmitter } from 'node:events';
    import { main } from ${JSON.stringify(new URL('./sign.mjs', import.meta.url).href)};
    const input = new EventEmitter();
    input.isTTY = true; input.isRaw = false;
    input.setRawMode = raw => { input.isRaw = raw; process.stdout.write('raw=' + raw + '\\n'); };
    const output = { write(text) {
      if (text.includes('Release key (hidden):')) {
        setTimeout(() => process.exit(99), 3000);
        setImmediate(() => {
        if (process.argv[2] === 'exit') process.exit(17);
        else process.kill(process.pid, process.argv[2]);
        });
      }
    } };
    await main({ argv: [process.argv[1]], stdin: input, stdout: process.stdout, stderr: output });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.release, signal], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, signal === 'exit' ? 17 : 1);
  assert.equal(result.stdout, 'raw=true\nraw=false\n');
  unchanged(f, before);
});


for (const [name, method, choose, reason] of [
  ['temp open', 'openSync', args => args[1] === 'wx', /Could not write release signature/],
  ['temp stat', 'fstatSync', () => true, /Could not write release signature/],
  ['temp chmod', 'fchmodSync', () => true, /Could not write release signature/],
  ['temp write', 'writeFileSync', args => typeof args[0] === 'number', /Could not write release signature/],
  ['temp sync', 'fsyncSync', () => true, /Could not write release signature/],
  ['temp close', 'closeSync', (args, calls, f) => fs.existsSync(path.join(f.release, `.manifest.sig.${process.pid}.tmp`)), /Could not write release signature/],
  ['publication link', 'linkSync', () => true, /Could not publish the signature/],
  ['temp unlink', 'unlinkSync', () => true, /Could not remove temporary file \.manifest\.sig\.\d+\.tmp/],
]) test(`atomic write cleans up after ${name} failure`, async t => {
  const f = fixture(t), before = snapshot(f.base), original = fs[method];
  let failed = false, calls = 0;
  t.mock.method(fs, method, function (...args) {
    calls++;
    if (!failed && choose(args, calls, f)) { failed = true; throw new Error('injected filesystem failure'); }
    return original.apply(this, args);
  });
  await assert.rejects(signRelease(f.release, f.seed, f.expected), reason);
  assert.equal(failed, true);
  t.mock.restoreAll();
  unchanged(f, before);
});

for (const [name, method, choose] of [
  ['directory open', 'openSync', (args, calls, f) => args[0] === f.release && args[1] === 'r'],
  ['directory sync', 'fsyncSync', (args, calls) => calls === 2],
]) test(`a ${name} failure after publication keeps the durable signature`, async t => {
  const f = fixture(t), original = fs[method];
  let failed = false, calls = 0;
  t.mock.method(fs, method, function (...args) {
    calls++;
    if (!failed && choose(args, calls, f)) { failed = true; throw new Error('injected filesystem failure'); }
    return original.apply(this, args);
  });
  const result = await signRelease(f.release, f.seed, f.expected);
  assert.equal(failed, true);
  t.mock.restoreAll();
  assert.equal(result.signature, 'manifest.sig');
  assert.deepEqual(fs.readdirSync(f.release).sort(), ['files', 'manifest.json', 'manifest.sig']);
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(f.expected.ed25519, 'base64'), { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify('Ed25519', key, fs.readFileSync(path.join(f.release, 'manifest.sig')), fs.readFileSync(f.manifestFile)), true);
});

test('a temporary file swapped before publication is never left as manifest.sig', async t => {
  const f = fixture(t), originalLink = fs.linkSync, temp = `.manifest.sig.${process.pid}.tmp`;
  t.mock.method(fs, 'linkSync', function (from, to) {
    fs.unlinkSync(from); fs.writeFileSync(from, Buffer.alloc(64));
    return originalLink.call(this, from, to);
  });
  await assert.rejects(signRelease(f.release, f.seed, f.expected), /not the file this run wrote/);
  t.mock.restoreAll();
  // The swapped file is not this run's, so it is left for the operator and named by the next check.
  assert.deepEqual(fs.readdirSync(f.release).sort(), [temp, 'files', 'manifest.json']);
});

for (const [name, chunks, expected] of [
  ['Enter after a bare ESC', ['abc\x1b', '\r'], { value: 'abc' }],
  ['Enter inside an unfinished CSI', ['abc\x1b[1;', '\r'], { value: 'abc' }],
  ['Ctrl-C inside an unfinished CSI', ['abc\x1b[', '\x03'], { error: /Key input aborted/ }],
]) test(`hidden prompt handles ${name}`, { timeout: 3000 }, async () => {
  const f = tty(), pending = readHidden(f.input, f.output, 'Key: ');
  const settled = pending.then(value => ({ value }), error => ({ error }));
  for (const chunk of chunks) f.input.write(chunk);
  const result = await settled;
  if (expected.error) assert.match(result.error.message, expected.error);
  else assert.equal(result.value, expected.value);
  assert.deepEqual(f.modes, [true, false]);
});

test('main drains input queued during a failing release check before restoring the terminal', async t => {
  const f = fixture(t), terminal = tty();
  f.manifest.worker.modules = []; f.save();
  let listening;
  // Arrives on the next turn, as a paste queued in the terminal during the synchronous check would.
  setImmediate(() => { listening = terminal.input.listenerCount('data') > 0; terminal.input.write('PASTED-SEED\r'); });
  const { pending } = callMain(f, terminal.input);
  await assert.rejects(pending, /worker malformed/);
  assert.equal(listening, true, 'input must still be read and dropped when it arrives');
  assert.equal(terminal.input.readableLength, 0);
  assert.deepEqual(terminal.modes, [true, false]);
});

test('main signs with injected streams and keeps echo off through result output', async t => {
  const f = fixture(t), terminal = tty(), err = capture(), out = capture();
  const originalRead = fs.readFileSync, writeError = err.output.write.bind(err.output), writeResult = out.output.write.bind(out.output);
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file instanceof URL && file.href === new URL('./key.json', import.meta.url).href) return canonical(f.expected);
    assert.equal(terminal.input.isRaw, true, 'all signing reads must happen with echo off');
    return originalRead.call(this, file, ...args);
  });
  err.output.write = (...args) => {
    assert.equal(terminal.input.isRaw, true);
    if (String(args[0]).includes('Release key (hidden):')) setImmediate(() => terminal.input.write(f.seed + '\r'));
    return writeError(...args);
  };
  out.output.write = (...args) => { assert.equal(terminal.input.isRaw, true); return writeResult(...args); };
  const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'], counts = events.map(name => process.listenerCount(name));
  await signing.main({ argv: [f.release], stdin: terminal.input, stdout: out.output, stderr: err.output });
  t.mock.restoreAll();
  assert.deepEqual(terminal.modes, [true, false]);
  assert.deepEqual(events.map(name => process.listenerCount(name)), counts);
  assert.equal(terminal.input.listenerCount('data'), 0);
  assert.equal(out.text().trim().split('\n').length, 1);
  assert.equal(JSON.parse(out.text()).key_id, f.expected.id);
  assert.equal(await verifies(f, fs.readFileSync(path.join(f.release, 'manifest.sig'))), true);
  secretAbsent(out.text() + err.text(), f.seed);
});

test('main refuses data buffered before startup without prompting', async t => {
  const f = fixture(t), terminal = tty(), before = snapshot(f.base);
  terminal.input.write(f.seed + '\r');
  const { pending, out, err } = callMain(f, terminal.input);
  await assert.rejects(pending, { message: earlyMessage });
  assert.deepEqual(terminal.modes, [true, false]);
  assert.doesNotMatch(err.text(), /Release key \(hidden\):/);
  secretAbsent(out.text() + err.text(), f.seed);
  unchanged(f, before);
});
