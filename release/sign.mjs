#!/usr/bin/env node
// Operator-only signing. The seed is read from a hidden Terminal prompt.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = 'wiser-crm';
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]{43}=$/;
const CHECKS = ['lockfile', 'install_log', 'bundle_inputs'];
const TTY_MESSAGE = 'Run this in your own Terminal; the key is read only from a hidden prompt.';
const SEED_MESSAGE = 'Key must be a 32-byte Ed25519 seed: 44 characters of standard base64 (43 base64 characters followed by =).';
const MAX_MANIFEST = 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const protectedPath = file => file.split(path.sep).some(part => /^memory$/i.test(part) || /^\.env(?:\.|$)/i.test(part));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const EARLY_MESSAGE = 'Input arrived before the prompt; nothing was signed. Run again and paste only after the prompt appears.';
const RELEASE_APP = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;
const RELEASE_VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_NAME = /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIALS?|AUTHORIZATION)(?:_|$)/;
const BINDING = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MODULE_TYPES = { '.js': 'application/javascript+module', '.mjs': 'application/javascript+module',
  '.cjs': 'application/javascript', '.wasm': 'application/wasm', '.txt': 'text/plain',
  '.html': 'text/plain', '.bin': 'application/octet-stream' };
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const string = (v, pattern) => typeof v === 'string' && pattern.test(v);
const plainName = name => string(name, VAR_NAME) && !SECRET_NAME.test(name);
const orderedShape = (v, keys) => object(v) && Object.keys(v).length === keys.length
  && keys.every((key, i) => Object.keys(v)[i] === key);

function safePath(value, absolute) {
  if (typeof value !== 'string' || value.length > 512 || !value.length) return false;
  if (absolute !== value.startsWith('/')) return false;
  const path = absolute ? value.slice(1) : value;
  return /^[A-Za-z0-9_./-]+$/.test(path) && !path.includes('..')
    && path.split('/').every((part) => part.length > 0 && part !== '.');
}
function date(value) {
  return string(value, /^\d{4}-\d{2}-\d{2}$/)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function mime(value) {
  return string(value, /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:; charset=[A-Za-z0-9_-]+)?$/) && value.length <= 128;
}

// Mirrors checkedManifest and its predicates in wiser/connectors/cloudflare/worker-release.js.
function assetsConfig(config) {
  return orderedShape(config, ['html_handling', 'not_found_handling', 'run_worker_first'])
    && ['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none'].includes(config.html_handling)
    && ['none', '404-page', 'single-page-application'].includes(config.not_found_handling)
    && config.run_worker_first === true;
}
function checkedManifest(manifest, input) {
  if (!orderedShape(manifest, ['format', 'app', 'version', 'created', 'source', 'checks', 'worker', 'assets', 'migrations']) || manifest.format !== 2) throw new Error('release manifest malformed');
  if (manifest.app !== input.app || manifest.version !== input.version) throw new Error('release names another version');
  if (!string(manifest.app, RELEASE_APP) || !string(manifest.version, RELEASE_VERSION)
    || !string(manifest.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/) || !Number.isFinite(Date.parse(manifest.created))
    || new Date(manifest.created).toISOString().slice(0, 19) !== manifest.created.slice(0, 19)) throw new Error('release manifest malformed');
  const s = manifest.source;
  if (!orderedShape(s, ['repository', 'commit', 'upstream_commit', 'f1']) || s.repository !== 'wisermethod/wiser-crm'
    || !string(s.commit, COMMIT) || !string(s.upstream_commit, COMMIT)
    || !orderedShape(s.f1, ['count', 'limit']) || !Number.isSafeInteger(s.f1.count) || s.f1.count < 0
    || !Number.isSafeInteger(s.f1.limit) || s.f1.limit < 0 || s.f1.count > s.f1.limit) throw new Error('release source malformed');
  if (!orderedShape(manifest.checks, ['lockfile', 'install_log', 'bundle_inputs'])
    || !Object.values(manifest.checks).every((value) => value === 'PASS')) throw new Error('release checks malformed');
  const w = manifest.worker;
  if (!orderedShape(w, ['main_module', 'compatibility_date', 'compatibility_flags', 'd1_binding', 'assets_binding', 'vars_required', 'modules'])
    || !safePath(w.main_module, false) || !date(w.compatibility_date)
    || !Array.isArray(w.compatibility_flags) || w.compatibility_flags.length > 100
    || !w.compatibility_flags.every((flag) => string(flag, /^[a-z][a-z0-9_]{0,127}$/))
    || new Set(w.compatibility_flags).size !== w.compatibility_flags.length
    || !string(w.d1_binding, BINDING) || !string(w.assets_binding, BINDING) || w.d1_binding === w.assets_binding
    || !Array.isArray(w.vars_required) || !w.vars_required.every(plainName)
    || new Set(w.vars_required).size !== w.vars_required.length
    || w.vars_required.includes(w.d1_binding) || w.vars_required.includes(w.assets_binding)
    || !Array.isArray(w.modules) || !w.modules.length || w.modules.length > 50) throw new Error('release worker malformed');
  const a = manifest.assets;
  if (!orderedShape(a, ['config', 'files']) || !assetsConfig(a.config) || !Array.isArray(a.files) || a.files.length > 20000) throw new Error('release assets malformed');
  const m = manifest.migrations;
  if (!orderedShape(m, ['table', 'files']) || !string(m.table, /^[A-Za-z_][A-Za-z0-9_]*$/)
    || !Array.isArray(m.files)) throw new Error('release migrations malformed');
  const modules = new Set();
  const paths = new Set();
  const migrations = new Set();
  const files = new Map();
  let total = 0;
  for (const [items, kind] of [[w.modules, 'module'], [a.files, 'asset'], [m.files, 'migration']]) {
    for (const file of items) {
      const keys = kind === 'module' ? ['name', 'type', 'sha256', 'size']
        : kind === 'asset' ? ['path', 'sha256', 'size', 'content_type'] : ['name', 'sha256', 'size'];
      if (!orderedShape(file, keys) || !string(file.sha256, DIGEST) || !Number.isSafeInteger(file.size)
        || file.size < 0 || file.size > MAX_FILE_BYTES) throw new Error(`release ${kind} malformed`);
      if (kind === 'module') {
        if (!safePath(file.name, false) || file.name === 'metadata' || modules.has(file.name)
          || !Object.hasOwn(MODULE_TYPES, path.extname(file.name)) || MODULE_TYPES[path.extname(file.name)] !== file.type) throw new Error('release module malformed');
        modules.add(file.name);
      } else if (kind === 'asset') {
        if (!safePath(file.path, true) || paths.has(file.path) || !mime(file.content_type)) throw new Error('release asset malformed');
        paths.add(file.path);
      } else {
        if (!safePath(file.name, false) || !/^\d+_[A-Za-z0-9_-]+\.sql$/.test(file.name)
          || migrations.has(file.name)) throw new Error('release migration malformed');
        migrations.add(file.name);
      }
      total += file.size;
      if (total > MAX_TOTAL_BYTES) throw new Error('release exceeds 64 MiB total');
      if (files.has(file.sha256) && files.get(file.sha256).size !== file.size) throw new Error('release hash has inconsistent sizes');
      files.set(file.sha256, file);
    }
  }
  if (!modules.has(w.main_module)) throw new Error('release main module missing');
  return { files: [...files.values()] };
}

function manifestBytes(release) {
  const file = path.join(release, 'manifest.json'), stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error('manifest.json must be a regular file, not a symlink');
  if (stat.size > MAX_MANIFEST) throw new Error('manifest.json exceeds 1 MiB');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_MANIFEST) throw new Error('manifest.json exceeds 1 MiB');
  return bytes;
}

export function checkRelease(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('release directory must be absolute');
  if (protectedPath(dir)) throw new Error('refusing a memory or .env path');
  const release = fs.realpathSync(dir);
  if (protectedPath(release)) throw new Error('refusing a memory or .env path');
  const version = path.basename(release);
  if (path.basename(path.dirname(release)) !== APP || !VERSION.test(version) || !fs.lstatSync(release).isDirectory()) throw new Error('release real path must end wiser-crm/<version> with version x.y.z without leading zeroes');
  const entries = fs.readdirSync(release).sort();
  if (entries.includes('manifest.sig')) throw new Error('manifest.sig already exists; refusing to overwrite');
  if (entries.length !== 2 || entries[0] !== 'files' || entries[1] !== 'manifest.json') {
    const extra = entries.filter(name => name !== 'files' && name !== 'manifest.json');
    throw new Error('release must hold exactly manifest.json and files/' + (extra.length ? `; remove unexpected entry: ${extra.map(name => JSON.stringify(name)).join(', ')}` : ''));
  }
  const bytes = manifestBytes(release);
  let text, manifest;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('manifest.json must be valid UTF-8'); }
  try { manifest = JSON.parse(text); }
  catch { throw new Error('manifest.json must be valid JSON'); }
  if (!bytes.equals(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))) throw new Error('manifest.json must use canonical two-space JSON and a final LF');
  const valid = checkedManifest(manifest, { app: APP, version });
  const referenced = new Map(valid.files.map(record => [record.sha256, record.size]));
  const files = path.join(release, 'files');
  if (!fs.lstatSync(files).isDirectory()) throw new Error('files/ must be a real directory of regular files only');
  const names = fs.readdirSync(files).sort();
  for (const name of names) {
    if (protectedPath(name)) throw new Error('refusing a memory or .env path');
    if (!fs.lstatSync(path.join(files, name)).isFile()) throw new Error('files/ must contain regular files only, no symlinks or subdirectories');
  }
  if (names.length !== referenced.size || names.some(name => !referenced.has(name))) throw new Error('files/ file set must exactly equal the referenced digests');
  let totalBytes = 0;
  for (const name of names) {
    const contents = fs.readFileSync(path.join(files, name));
    if (sha256(contents) !== name) throw new Error('file digest does not match its name');
    if (contents.length !== referenced.get(name)) throw new Error('file size does not match its record');
    totalBytes += contents.length;
  }
  return { release, version, manifest, bytes, manifestHash: sha256(bytes), fileCount: names.length, totalBytes };
}

export function printSummary(checked, output = process.stderr) {
  const { manifest, fileCount, totalBytes, manifestHash } = checked;
  output.write([
    `app: ${manifest.app}`, `version: ${manifest.version}`,
    `commit: ${manifest.source.commit}`, `upstream commit: ${manifest.source.upstream_commit}`,
    `F1: ${manifest.source.f1.count} / ${manifest.source.f1.limit}`,
    ...CHECKS.map(name => `${name}: ${manifest.checks[name]}`),
    `modules: ${manifest.worker.modules.length}`, `assets: ${manifest.assets.files.length}`,
    `migrations: ${manifest.migrations.files.length}`, `unique files: ${fileCount}`,
    `total bytes: ${totalBytes}`, `manifest SHA-256: ${manifestHash}`,
  ].join('\n') + '\n');
}

export function readHidden(input, output, prompt, { manageRaw = true, beforePrompt } = {}) {
  return new Promise((resolve, reject) => {
    if (input.isTTY !== true) { reject(new Error(TTY_MESSAGE)); return; }
    const wasRaw = Boolean(input.isRaw);
    let value = '', escape = '', done = false, rawStarted = false;
    function finish(error, entered = false) {
      if (done) return;
      done = true;
      input.removeListener('data', data);
      input.removeListener('error', failed);
      input.removeListener('end', ended);
      input.removeListener('close', ended);
      try {
        if (rawStarted) input.setRawMode(wasRaw);
      } catch { error = new Error('Could not restore Terminal mode after hidden prompt.'); }
      try {
        input.pause?.();
        if (entered) output.write('\n');
      } catch { error = new Error('Could not finish hidden prompt.'); }
      const result = value;
      value = ''; escape = '';
      if (error) reject(error); else resolve(result);
    }
    function failed() { finish(new Error('Could not read key from hidden prompt.')); }
    function ended() { finish(new Error('Key input aborted.')); }
    function data(chunk) {
      try {
        for (const char of chunk.toString('utf8')) {
          if (done) return;
          if (char === '\x03' || char === '\x04') { ended(); return; }
          // Enter submits even inside an unfinished escape sequence.
          if (char === '\r' || char === '\n') { finish(null, true); return; }
          if (escape) {
            if (escape === 'esc') {
              escape = char === '[' ? 'csi' : char === 'O' ? 'ss3' : '';
              continue;
            }
            if (escape === 'ss3') { escape = ''; continue; }
            const code = char.charCodeAt(0);
            // CSI parameters/intermediates stay pending until one final byte.
            // This also strips ESC[200~ and ESC[201~ bracketed-paste markers.
            if (code >= 0x40 && code <= 0x7e) escape = '';
            continue;
          }
          if (char === '\x1b') { escape = 'esc'; continue; }
          if (char === '\b' || char === '\x7f') value = value.slice(0, -1);
          else value += char;
        }
      } catch { failed(); }
    }
    try {
      input.on('data', data);
      input.on('error', failed);
      input.on('end', ended);
      input.on('close', ended);
      if (manageRaw) { rawStarted = true; input.setRawMode(true); }
      beforePrompt?.();
      output.write(prompt);
      input.resume?.();
    } catch (error) { finish(new Error(error.message === EARLY_MESSAGE ? EARLY_MESSAGE : 'Could not read key from hidden prompt.')); }
  });
}

function publicKeyFor(expected) {
  try {
    const raw = Buffer.from(expected.ed25519, 'base64');
    if (!/^[0-9a-f]{16}$/.test(expected.id) || !BASE64.test(expected.ed25519) || raw.length !== 32 || raw.toString('base64') !== expected.ed25519) throw new Error();
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    return { raw, publicKey };
  } catch { throw new Error('Invalid release public key.'); }
}

export function keyFromSeed(text, expected) {
  let seed, der, privateKey, raw;
  const { publicKey } = publicKeyFor(expected);
  try {
    if (typeof text !== 'string') throw new Error();
    text = text.trim();
    if (!BASE64.test(text)) throw new Error();
    seed = Buffer.from(text, 'base64');
    if (seed.length !== 32 || seed.toString('base64') !== text) throw new Error();
  } catch {
    seed?.fill(0);
    throw new Error(SEED_MESSAGE);
  }
  try {
    der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch { throw new Error('Could not rebuild release key.'); }
  finally { seed.fill(0); der?.fill(0); }
  try { raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url'); }
  catch { throw new Error('Could not derive release public key.'); }
  if (raw.toString('base64') !== expected.ed25519 || sha256(raw).slice(0, 16) !== expected.id) throw new Error(`This key is not release key ${expected.id}.`);
  return { privateKey, publicKey };
}

async function subtleVerify(raw, signature, bytes) {
  const key = await webcrypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  return webcrypto.subtle.verify('Ed25519', key, signature, bytes);
}

function removeCreated(file, identity) {
  try {
    const current = fs.lstatSync(file);
    if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(file);
  } catch { /* Never remove a different signer's file. */ }
}

export async function signRelease(dir, seedText, expected, hooks = {}) {
  const checked = checkRelease(dir);
  const { privateKey, publicKey } = keyFromSeed(seedText, expected);
  const { raw } = publicKeyFor(expected);
  let signature;
  try {
    signature = sign(null, checked.bytes, privateKey);
    if (signature.length !== 64 || !verify(null, checked.bytes, publicKey, signature) || !await subtleVerify(raw, signature, checked.bytes)) throw new Error();
  } catch { throw new Error('Release signature verification failed.'); }
  try { await hooks.beforeWrite?.(); }
  catch { throw new Error('Could not prepare signature write.'); }
  if (!manifestBytes(checked.release).equals(checked.bytes)) throw new Error('manifest.json changed before signature write');
  const file = path.join(checked.release, 'manifest.sig');
  const tempName = `.manifest.sig.${process.pid}.tmp`, temp = path.join(checked.release, tempName);
  let fd, identity, linked = false, created = false;
  const cleanup = () => {
    // A successful link created manifest.sig, so that entry is this run's to remove.
    if (linked) { try { fs.unlinkSync(file); } catch { /* Already gone. */ } }
    if (created) {
      if (identity) removeCreated(temp, identity);
      else { try { fs.unlinkSync(temp); } catch { /* The exclusive temp file is already gone. */ } }
    }
  };
  process.once('exit', cleanup);
  try {
    try {
      fd = fs.openSync(temp, 'wx', 0o644);
      created = true;
      identity = fs.fstatSync(fd);
      fs.fchmodSync(fd, 0o644);
      fs.writeFileSync(fd, signature);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
    } catch { throw new Error('Could not write release signature.'); }
    try { fs.linkSync(temp, file); }
    catch { throw new Error('Could not publish the signature: manifest.sig exists or could not be created, and nothing was overwritten.'); }
    linked = true;
    const published = fs.lstatSync(file);
    if (published.dev !== identity.dev || published.ino !== identity.ino) throw new Error('manifest.sig is not the file this run wrote.');
    try { fs.unlinkSync(temp); created = false; }
    catch { throw new Error(`Could not remove temporary file ${tempName}.`); }
    // Best effort: the signature is already fsynced, and some network filesystems refuse a directory fsync.
    try {
      const directory = fs.openSync(checked.release, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { /* Not a reason to remove a durable signature. */ }
    try {
      await hooks.afterWrite?.();
      const stored = fs.readFileSync(file);
      const current = manifestBytes(checked.release);
      if (stored.length !== 64 || !await subtleVerify(raw, stored, current)) throw new Error();
    } catch { throw new Error('Release signature read-back verification failed.'); }
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Already refused. */ } }
    process.removeListener('exit', cleanup);
  }
  return { release: checked.release, app: APP, version: checked.version, key_id: expected.id, manifest_sha256: checked.manifestHash, signature: 'manifest.sig' };
}

export function printResult(result, output = process.stdout) {
  output.write(JSON.stringify(result) + '\n');
}

export async function main({ argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (stdin.isTTY !== true) {
    // Check and summarize the release without ever touching non-TTY input.
    if (argv.length !== 1 || !path.isAbsolute(argv[0])) throw new Error('provide exactly one absolute release directory, with no flags');
    printSummary(checkRelease(argv[0]), stderr);
    throw new Error(TTY_MESSAGE);
  }
  const wasRaw = Boolean(stdin.isRaw);
  let restored = false, earlyBytes = 0, inputError = false, ended = false;
  function restore() {
    if (restored) return;
    stdin.setRawMode(wasRaw);
    restored = true;
  }
  // Read and drop queued input while echo is still off, so no paste reaches the shell.
  async function drain() {
    let seen = true;
    const discard = () => { seen = true; };
    stdin.on('data', discard);
    try {
      // Resume every turn: the prompt pauses stdin when it finishes, which may race this.
      for (let turns = 0; turns < 20 && (seen || turns < 3); turns++) {
        seen = false;
        stdin.resume?.();
        await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
      }
    } finally { stdin.removeListener('data', discard); }
  }
  function stopped() {
    drain().catch(() => {}).finally(() => { try { restore(); } finally { process.exit(1); } });
  }
  function exiting() { try { restore(); } catch { process.exitCode = 1; } }
  function early(chunk) { earlyBytes += chunk.length; }
  function failed() { inputError = true; }
  function closed() { ended = true; }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  try {
    // Echo is off before arguments, release files, or the summary are checked.
    stdin.setRawMode(true);
    for (const signal of signals) process.once(signal, stopped);
    process.once('exit', exiting);
    stdin.on('data', early);
    stdin.on('error', failed);
    stdin.on('end', closed);
    stdin.on('close', closed);
    stdin.resume?.();
    if (argv.length !== 1 || !path.isAbsolute(argv[0])) throw new Error('provide exactly one absolute release directory, with no flags');
    const checked = checkRelease(argv[0]);
    printSummary(checked, stderr);
    let expected;
    try { expected = JSON.parse(fs.readFileSync(new URL('./key.json', import.meta.url), 'utf8')); }
    catch { throw new Error('Could not read release/key.json.'); }
    publicKeyFor(expected);
    // Give input queued during synchronous hashing a turn before the prompt.
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
    const seedText = await readHidden(stdin, stderr, 'Release key (hidden): ', {
      manageRaw: false,
      beforePrompt() {
        if (earlyBytes || stdin.readableLength > 0) throw new Error(EARLY_MESSAGE);
        if (inputError) throw new Error('Could not read key from hidden prompt.');
        if (ended) throw new Error('Key input aborted.');
        stdin.removeListener('data', early);
      },
    });
    if (!manifestBytes(checked.release).equals(checked.bytes)) throw new Error('manifest.json changed after the release summary');
    printResult(await signRelease(checked.release, seedText, expected), stdout);
  } finally {
    try { await drain(); } catch { /* Restore regardless. */ }
    try { restore(); }
    finally {
      stdin.pause?.();
      stdin.removeListener('data', early);
      stdin.removeListener('error', failed);
      stdin.removeListener('end', closed);
      stdin.removeListener('close', closed);
      for (const signal of signals) process.removeListener(signal, stopped);
      process.removeListener('exit', exiting);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (e) {
    process.stderr.write(`release sign: ${e.message.replace(/[\r\n]/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
