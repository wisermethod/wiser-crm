import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const checker = fileURLToPath(new URL('./clawnify-free.mjs', import.meta.url));
const cleanLock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@clawnify/app':
        specifier: link:./runtime/app
        version: link:runtime/app
packages:
  'fixture-dep@1.2.3':
    resolution: {integrity: synthetic}
snapshots:
  'fixture-dep@1.2.3': {}
`;
function fixture(t) {
  // Real path: the checker compares real paths, and macOS's default temp directory is a link.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.WISER_RELEASE_TEST_TMPDIR ?? os.tmpdir(), 'wiser-release-fixture-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'fork');
  fs.mkdirSync(repo);
  function write(relative, text = '') {
    const file = path.join(repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }
  // All contents here are synthetic. The checker only resolves their paths.
  write('runtime/app/index.js');
  write('src/main.js');
  write('node_modules/.pnpm/fixture-dep@1.2.3/node_modules/fixture-dep/index.js');
  write('pnpm-lock.yaml', cleanLock);
  const log = path.join(base, 'install.ndjson');
  const meta = path.join(base, 'worker.json'), ui = path.join(base, 'ui.json');
  const manifest = { name: '@clawnify/open-crm', dependencies: { '@clawnify/app': 'link:./runtime/app' } };
  const event = { name: 'pnpm:package-manifest', prefix: repo, initial: manifest };
  const root = { name: 'pnpm:root', added: { name: '@clawnify/app', linkedFrom: path.join(repo, 'runtime/app') } };
  const events = [event, root, { name: 'pnpm:fetching-progress', packageId: 'fixture-dep@1.2.3' }];
  const worker = { inputs: { 'src/main.js': {}, 'node_modules/.pnpm/fixture-dep@1.2.3/node_modules/fixture-dep/index.js': {} } };
  const uiRecord = { root: repo, assets: [], publicFiles: [], chunks: [{ fileName: 'app.js', modules: [path.join(repo, 'runtime/app/index.js'), '\0commonjsHelpers.js', 'vite/preload-helper.js'] }] };
  function run(command, expected, reason) {
    fs.writeFileSync(log, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(meta, JSON.stringify(worker));
    fs.writeFileSync(ui, JSON.stringify(uiRecord));
    const more = command === 'install-log' ? [log] : command === 'bundle-inputs' ? [meta, ui] : [];
    const result = spawnSync(process.execPath, [checker, command, repo, ...more], { encoding: 'utf8' });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    const label = { lockfile: 'LOCKFILE', 'install-log': 'INSTALL-LOG', 'bundle-inputs': 'BUNDLE-INPUTS' }[command];
    assert.equal(result.stdout.trim().split('\n').at(-1), `${label}: ${expected ? 'FAIL' : 'PASS'}`);
    if (reason) assert.match(result.stdout, reason);
    return result;
  }
  return { base, repo, write, manifest, event, root, events, worker, ui: uiRecord, run };
}

test('A passes local runtime links', t => fixture(t).run('lockfile', 0));
for (const [name, change, reason] of [
  ['registry version', s => s.replace('version: link:runtime/app', 'version: 0.4.1'), /importer resolves @clawnify\/app to 0\.4\.1/],
  ['link outside runtime', s => s.replace('version: link:runtime/app', 'version: link:../elsewhere'), /link outside runtime\/: @clawnify\/app/],
  ['packages key', s => s.replace('packages:\n', "packages:\n  '@clawnify/integrations@0.4.0': {}\n"), /packages key names the scope: @clawnify\/integrations/],
  ['snapshots key', s => s.replace('snapshots:\n', "snapshots:\n  '@clawnify/routes@0.3.0': {}\n"), /snapshots key names the scope: @clawnify\/routes/],
  ['tarball', s => s.replace('packages:\n', 'packages:\n  control@1.0.0:\n    resolution: {tarball: https://registry.npmjs.org/@clawnify/app/-/app.tgz}\n'), /tarball or resolution\/value names the scope/],
  ['encoded resolution', s => s.replace('packages:\n', 'packages:\n  control@1.0.0:\n    resolution: https://registry.npmjs.org/%40CLAWNIFY%2Fapp\n'), /resolution\/value names the scope/],
  ['missing version', s => s.replace('        version: link:runtime/app\n', ''), /missing link: version/],
]) test(`A rejects ${name} for its planted reason`, t => {
  const f = fixture(t); f.write('pnpm-lock.yaml', change(cleanLock)); f.run('lockfile', 1, reason);
});
test('A rejects a runtime link escaping through a symlink', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.base, 'external'));
  fs.symlinkSync(path.join(f.base, 'external'), path.join(f.repo, 'runtime/escape'));
  f.write('pnpm-lock.yaml', cleanLock.replace('link:runtime/app', 'link:runtime/escape'));
  f.run('lockfile', 1, /link outside runtime/);
});

test('B passes only root manifest and runtime links', t => fixture(t).run('install-log', 0));
for (const [name, event, reason] of [
  ['encoded scoped fetch', { name: 'pnpm:fetching-progress', nested: { url: 'https://registry.npmjs.org/@clawnify%2fapp' } }, /pnpm:fetching-progress unexpected scope at \$\.nested.url/],
  ['tarball URL', { name: 'pnpm:progress', nested: ['https://registry.npmjs.org/@clawnify/app/-/app.tgz'] }, /pnpm:progress unexpected scope/],
  ['encoded at sign', { name: 'pnpm:resolve', resolution: '%40CLAWNIFY%2Fapp' }, /pnpm:resolve unexpected scope/],
  ['root missing linkedFrom', { name: 'pnpm:root', added: { name: '@clawnify/app' } }, /pnpm:root missing linkedFrom under runtime.*@clawnify\/app/],
  ['root outside runtime', { name: 'pnpm:root', added: { name: '@clawnify/app', linkedFrom: '/outside/runtime/app' } }, /pnpm:root missing linkedFrom under runtime.*outside/],
]) test(`B rejects ${name} for its planted reason`, t => {
  const f = fixture(t); f.events.push(event); f.run('install-log', 1, reason);
});
test('B rejects manifest scope dependency by version', t => {
  const f = fixture(t); f.manifest.dependencies['@clawnify/app'] = '0.4.1';
  f.run('install-log', 1, /manifest scope dependency is not an allowed runtime link: @clawnify\/app -> 0\.4\.1/);
});
test('B does not exempt other scope strings in a legitimate manifest event', t => {
  const f = fixture(t); f.event.url = 'https://registry.npmjs.org/@clawnify/app';
  f.run('install-log', 1, /unexpected scope at \$\.url/);
});
test('B does not exempt other scope strings in a legitimate root event', t => {
  const f = fixture(t); f.root.added.url = 'https://registry.npmjs.org/@clawnify/app';
  f.run('install-log', 1, /unexpected scope at \$\.added.url/);
});

test('C passes own files, pinned dependency and fixed internal IDs', t => fixture(t).run('bundle-inputs', 0));
test('C passes a scope alias only when its real path is our runtime', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.repo, 'node_modules/@clawnify'), { recursive: true });
  fs.symlinkSync(path.join(f.repo, 'runtime/app'), path.join(f.repo, 'node_modules/@clawnify/app'));
  f.ui.chunks[0].modules.push(path.join(f.repo, 'node_modules/@clawnify/app/index.js'));
  f.run('bundle-inputs', 0);
});
test('C rejects scoped Worker input for its planted reason', t => {
  const f = fixture(t);
  f.worker.inputs['node_modules/.pnpm/@clawnify+app@0.4.1/node_modules/@clawnify/app/index.js'] = {};
  f.run('bundle-inputs', 1, /worker: .*@clawnify\+app@0\.4\.1.*scope input outside runtime/);
});
test('C rejects scoped UI input for its planted reason', t => {
  const f = fixture(t); f.ui.chunks[0].modules.push('/outside/@clawnify/app/index.js');
  f.run('bundle-inputs', 1, /ui:app.js: .*@clawnify\/app.*scope input outside runtime/);
});
test('C rejects dependency missing from lockfile for its planted reason', t => {
  const f = fixture(t);
  const p = f.write('node_modules/.pnpm/unlisted@1.0.0/node_modules/unlisted/index.js');
  f.ui.chunks[0].modules.push(p);
  f.run('bundle-inputs', 1, /package not listed in lockfile packages: unlisted/);
});
test('C rejects wrong pinned version', t => {
  const f = fixture(t); const p = f.write('node_modules/.pnpm/fixture-dep@9.9.9/node_modules/fixture-dep/index.js');
  f.ui.chunks[0].modules.push(p); f.run('bundle-inputs', 1, /package not listed.*fixture-dep@9.9.9/);
});
test('C rejects input outside fork for its planted reason', t => {
  const f = fixture(t); const outside = path.join(f.base, 'outside.js'); fs.writeFileSync(outside, '');
  f.ui.chunks[0].modules.push(outside); f.run('bundle-inputs', 1, /outside.js.*input outside fork/);
});
test('C rejects virtual ID naming the scope', t => {
  const f = fixture(t); f.ui.chunks[0].modules.push('\0@clawnify/app');
  f.run('bundle-inputs', 1, /scope input outside runtime/);
});
test('C passes exactly the two synthetic inputs under locked Wrangler', t => {
  const f = fixture(t);
  f.write('pnpm-lock.yaml', cleanLock.replace('packages:\n', "packages:\n  'wrangler@4.0.0': {}\n"));
  fs.mkdirSync(path.join(f.repo, 'node_modules/.pnpm/wrangler@4.0.0/node_modules/wrangler'), { recursive: true });
  for (const name of ['console', 'process']) f.worker.inputs[`node_modules/.pnpm/wrangler@4.0.0/node_modules/wrangler/_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-${name}`] = {};
  f.run('bundle-inputs', 0);
});
test('C does not allow arbitrary Wrangler virtual paths', t => {
  const f = fixture(t);
  f.worker.inputs['node_modules/.pnpm/wrangler@4.0.0/node_modules/wrangler/_virtual_unenv_global_polyfill-anything'] = {};
  f.run('bundle-inputs', 1, /_virtual_unenv_global_polyfill-anything.*cannot be resolved/);
});
test('CLI usage and unreadable input exit 2', t => {
  const f = fixture(t);
  assert.equal(spawnSync(process.execPath, [checker], { encoding: 'utf8' }).status, 2);
  const r = spawnSync(process.execPath, [checker, 'install-log', f.repo, path.join(f.base, 'absent.ndjson')], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stdout, /input error:.*ENOENT/);
});
test('CLI refuses to open a package directory input', t => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [checker, 'install-log', f.repo, path.join(f.repo, 'node_modules/.pnpm/fixture-dep@1.2.3/node_modules/fixture-dep/index.js')], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stdout, /refusing to open protected input/);
});

// S10b controls contain only synthetic files, never a published scope package.
test('S10b finding 1: every accepted runtime target is walked, including missing links', async t => {
  for (const command of ['lockfile', 'install-log', 'bundle-inputs']) {
    for (const kind of ['escape', 'dangling']) await t.test(`${command}: nested ${kind}`, t => {
      const f = fixture(t), outside = path.join(f.base, 'outside');
      if (kind === 'escape') fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(f.repo, 'runtime/app/extra'));
      f.run(command, 1, /runtime.*(?:outside|missing|ENOENT|dangling)/i);
    });
    await t.test(`${command}: dangling root`, t => {
      const f = fixture(t);
      if (command === 'lockfile') f.write('pnpm-lock.yaml', cleanLock.replaceAll('runtime/app', 'runtime/missing'));
      else if (command === 'install-log') { f.events.splice(0, f.events.length, { name: 'pnpm:root', added: { name: '@clawnify/app', linkedFrom: path.join(f.repo, 'runtime/missing') } }); }
      else { fs.symlinkSync(path.join(f.repo, 'runtime/missing'), path.join(f.repo, 'runtime/app/missing')); }
      f.run(command, 1, /runtime.*(?:missing|ENOENT|dangling)/i);
    });
  }
});

test('S10b finding 2: lockfile syntax fails closed', async t => {
  const cases = [
    ['first document key', s => `unrelated: true\n${s}`, /first.*lockfileVersion/],
    ['escaped scope key', s => s.replace('packages:\n', 'packages:\n  "\\u0040clawnify/integrations@0.4.0": {}\n'), /backslash/],
    ['split quoted name', s => s + '  "fixture\\\n    continuation": {}\n', /backslash/],
    ['literal block', s => s + '  metadata: |\n    hidden\n', /block.scalar/],
    ['folded block', s => s + '  metadata: >-\n    hidden\n', /block.scalar/],
    ['duplicate version', s => s.replace('        version: link:runtime/app', '        version: link:runtime/app\n        version: 0.4.0'), /duplicate key.*version/],
    ['duplicate quoted key', s => s.replace('settings:', 'settings:').replace('importers:', 'settings:\n  flag: true\n  "flag": false\nimporters:'), /duplicate key.*flag/],
    ['unread line', s => s + '  unexplained syntax\n', /unrecognized.*line/],
    ['second document', s => s + '---\n', /unrecognized.*line/],
  ];
  for (const [name, change, reason] of cases) await t.test(name, t => {
    const f = fixture(t); f.write('pnpm-lock.yaml', change(cleanLock)); f.run('lockfile', 2, reason);
  });
});

test('S10b finding 3: NUL paths receive scope, ownership and pin checks', async t => {
  for (const kind of ['alias', 'outside', 'unlisted', 'unknown-helper']) await t.test(kind, t => {
    const f = fixture(t);
    let id;
    if (kind === 'alias') id = f.write('node_modules/integrations/index.js');
    if (kind === 'outside') { id = path.join(f.base, 'external.js'); fs.writeFileSync(id, ''); }
    if (kind === 'unlisted') id = f.write('node_modules/.pnpm/unlisted@1.0.0/node_modules/unlisted/index.js');
    if (kind === 'unknown-helper') id = 'unrecognizedHelper.js';
    f.ui.chunks[0].modules = [`\0${id}?commonjs-module`];
    f.run('bundle-inputs', 1, /not a locked|outside fork|not listed|cannot be resolved/);
  });
});

test('S10b finding 4: Wrangler virtual basenames must be absent in the exact pin directory', async t => {
  for (const kind of ['lookalike-missing', 'lookalike-file', 'pinned-file', 'pinned-dangling']) await t.test(kind, t => {
    const f = fixture(t);
    f.write('pnpm-lock.yaml', cleanLock.replace('packages:\n', "packages:\n  'wrangler@4.0.0': {}\n"));
    const dir = kind.startsWith('lookalike') ? 'wrangler@4.0.0_extra' : 'wrangler@4.0.0';
    const id = `node_modules/.pnpm/${dir}/node_modules/wrangler/_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-console`;
    fs.mkdirSync(path.dirname(path.join(f.repo, id)), { recursive: true });
    if (kind.endsWith('file')) f.write(id);
    if (kind.endsWith('dangling')) fs.symlinkSync(path.join(f.base, 'absent'), path.join(f.repo, id));
    f.worker.inputs[id] = {};
    f.run('bundle-inputs', 1, /Wrangler virtual|cannot be resolved/);
  });
});

test('S10b finding 5: recorder surfaces public files and imported asset origins to C', async t => {
  for (const kind of ['public', 'asset']) await t.test(kind, t => {
    const f = fixture(t);
    const releaseDir = path.dirname(checker), sourceRepo = path.dirname(releaseDir);
    // Use only the installed, unrestricted Vite dependency. No install or package scan.
    fs.symlinkSync(path.join(sourceRepo, 'node_modules/vite'), path.join(f.repo, 'node_modules/vite'));
    f.write('release/ui-inputs.mjs', fs.readFileSync(path.join(releaseDir, 'ui-inputs.mjs')));
    f.write('package.json', '{"type":"module"}\n');
    f.write('vite.config.ts', 'export default { publicDir: "public", build: { outDir: "dist", assetsInlineLimit: 0 } };\n');
    f.write('index.html', '<script type="module" src="/src/main.js"></script>\n');
    if (kind === 'public') f.write('public/@clawnify/integrations.js', '// synthetic public control\n');
    else {
      f.write('stand-in/@clawnify/integrations/picture.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
      f.write('src/main.js', 'import picture from "../stand-in/@clawnify/integrations/picture.svg"; console.log(picture);\n');
    }
    const recordPath = path.join(f.base, 'recorded-ui.json');
    const build = spawnSync(process.execPath, [path.join(f.repo, 'release/ui-inputs.mjs'), recordPath], { cwd: f.repo, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    Object.assign(f.ui, JSON.parse(fs.readFileSync(recordPath, 'utf8')));
    // Remove module evidence: this control must fail from the asset/public record alone.
    f.ui.chunks[0].modules = [path.join(f.repo, 'src/main.js')];
    f.run('bundle-inputs', 1, /(?:public|asset).*@clawnify.*scope input outside runtime/);
  });
});

test('S10b finding 6: README states the checks measured coverage and limits', () => {
  const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(readme, /each check covers (?:only )?the strings and paths it resolves/i);
  assert.match(readme, /runtime link is trusted only after its tree is walked/i);
  assert.match(readme, /contents, copied code and other builders. records are outside/i);
});

test('S10b amended grammar: block sequences are read and scope-checked', async t => {
  for (const [name, scalar, status, reason] of [
    ['plain scalar', 'fixture-dep', 0],
    ['single quoted scalar', "'@fixture/dep'", 0],
    ['scope scalar', "'@clawnify/integrations'", 1, /resolution\/value names the scope/],
    ['encoded scope scalar', "'%40clawnify%2fintegrations'", 1, /resolution\/value names the scope/],
    ['double quoted scalar', '"fixture-dep"', 2, /unrecognized.*line/],
    ['mapping item', 'name: fixture-dep', 2, /unrecognized.*line/],
  ]) await t.test(name, t => {
    const f = fixture(t);
    f.write('pnpm-lock.yaml', cleanLock + `  control@1.0.0:\n    transitivePeerDependencies:\n      - ${scalar}\n`);
    f.run('lockfile', status, reason);
  });
  await t.test('sequence without empty parent', t => {
    const f = fixture(t); f.write('pnpm-lock.yaml', cleanLock + '    scalar: value\n      - fixture-dep\n');
    f.run('lockfile', 2, /unrecognized.*line/);
  });
});


test('S10b duplicate keys in inline mappings also fail closed', t => {
  const f = fixture(t);
  f.write('pnpm-lock.yaml', cleanLock.replace('{integrity: synthetic}', '{integrity: synthetic, integrity: duplicate}'));
  f.run('lockfile', 2, /duplicate key.*integrity/);
});

test('S10b Wrangler uses the exact locked peer snapshot', async t => {
  for (const extra of ['', '_lookalike']) await t.test(extra || 'exact peer pin', t => {
    const f = fixture(t);
    f.write('pnpm-lock.yaml', cleanLock.replace('packages:\n', "packages:\n  'wrangler@4.0.0': {}\n").replace('snapshots:\n', "snapshots:\n  'wrangler@4.0.0(@fixture/peer@1.0.0)': {}\n"));
    const id = `node_modules/.pnpm/wrangler@4.0.0_@fixture+peer@1.0.0${extra}/node_modules/wrangler/_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-console`;
    fs.mkdirSync(path.dirname(path.join(f.repo, id)), { recursive: true });
    f.worker.inputs[id] = {};
    f.run('bundle-inputs', extra ? 1 : 0, extra ? /Wrangler virtual/ : undefined);
  });
});

test('S10b recorder includes assets emitted by later generateBundle hooks', t => {
  const f = fixture(t), releaseDir = path.dirname(checker);
  fs.symlinkSync(path.join(path.dirname(releaseDir), 'node_modules/vite'), path.join(f.repo, 'node_modules/vite'));
  f.write('release/ui-inputs.mjs', fs.readFileSync(path.join(releaseDir, 'ui-inputs.mjs')));
  f.write('package.json', '{"type":"module"}\n');
  f.write('vite.config.ts', `export default {
    publicDir: 'static',
    plugins: [{ name: 'synthetic-late-asset', generateBundle: { order: 'post', handler() {
      this.emitFile({ type: 'asset', fileName: 'late.txt', originalFileName: 'stand-in/@clawnify/integrations/data.txt', source: 'synthetic asset' });
    } } }]
  };\n`);
  f.write('index.html', '<script type="module" src="/src/main.js"></script>\n');
  f.write('src/main.js', 'console.log("synthetic");\n');
  f.write('static/nested/clean.txt', 'synthetic public file\n');
  f.write('stand-in/@clawnify/integrations/data.txt', 'synthetic asset\n');
  const output = path.join(f.base, 'recorded.json');
  const build = spawnSync(process.execPath, [path.join(f.repo, 'release/ui-inputs.mjs'), output], { cwd: f.repo, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  Object.assign(f.ui, JSON.parse(fs.readFileSync(output, 'utf8')));
  assert(f.ui.assets.some(asset => asset.fileName === 'index.html'), 'record must include final HTML asset');
  assert(f.ui.publicFiles.includes(path.join(f.repo, 'static/nested/clean.txt')));
  f.run('bundle-inputs', 1, /asset:late.txt.*@clawnify.*scope input outside runtime/);
});

test('S10b duplicate keys normalize unquoted YAML whitespace', t => {
  const f = fixture(t);
  f.write('pnpm-lock.yaml', cleanLock.replace('        version: link:runtime/app', '        version: link:runtime/app\n        version : 0.4.0'));
  f.run('lockfile', 2, /duplicate key.*version/);
});

test('S10b plain block scalars may start with non-indicator punctuation', t => {
  const f = fixture(t);
  f.write('pnpm-lock.yaml', cleanLock + '  control@1.0.0:\n    values:\n      - -1\n      - ?plain\n      - :plain\n');
  f.run('lockfile', 0);
});
