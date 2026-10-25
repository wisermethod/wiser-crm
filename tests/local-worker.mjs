import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = '/private/tmp/wiser-crm-m2b';
await mkdir(scratch, { recursive: true });
Object.assign(process.env, {
  WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true',
  CLOUDFLARE_CF_FETCH_ENABLED: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  WRANGLER_LOG: 'none', WRANGLER_LOG_PATH: join(scratch, 'wrangler-logs'),
  XDG_CONFIG_HOME: join(scratch, 'config'), TMPDIR: `${scratch}/`, CI: 'true',
});
const require = createRequire(import.meta.url);
const wranglerCli = resolve(dirname(require.resolve('wrangler')), '../bin/wrangler.js');
const { unstable_startWorker } = await import('wrangler');

async function portClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolve(true) : reject(error));
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error(`Port ${port} did not answer`)); });
  });
}

/** Real local entry, real wrapper, real app and a fresh Wrangler-migrated D1. */
export async function startApp(t) {
  const directory = await mkdtemp(join(scratch, 'worker-'));
  const persist = join(directory, 'state');
  const keys = await generateKeyPair('RS256', { extractable: true });
  const kid = crypto.randomUUID();
  const jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid, alg: 'RS256', use: 'sig' }] };
  await writeFile(join(directory, 'private-key.pem'), await exportPKCS8(keys.privateKey), { mode: 0o600 });
  await writeFile(join(directory, 'jwks.json'), JSON.stringify(jwks), { mode: 0o600 });
  const config = join(directory, 'wrangler.json');
  // Keep all Wrangler build/state files outside the checkout. These are the
  // local config's entry, flags and bindings, with absolute paths for scratch.
  const local = JSON.parse(await readFile(join(root, 'wrangler.local.jsonc'), 'utf8'));
  await writeFile(config, JSON.stringify({
    ...local, main: join(root, local.main),
    d1_databases: local.d1_databases.map((db) => ({ ...db, migrations_dir: join(root, db.migrations_dir) })),
    assets: { ...local.assets, directory: join(root, local.assets.directory) },
    send_metrics: false,
  }));
  const migrated = spawnSync(process.execPath, [wranglerCli, 'd1', 'migrations', 'apply',
    'wiser-crm-db', '--config', config, '--local', '--persist-to', persist], {
    cwd: directory, env: process.env, encoding: 'utf8', timeout: 120_000,
  });
  assert.ifError(migrated.error);
  assert.equal(migrated.status, 0, `Local migration failed: ${migrated.stdout}${migrated.stderr}`);
  t.diagnostic('Wrangler d1 migrations apply --local: exit 0');
  const worker = await unstable_startWorker({
    config, envFiles: [], sendMetrics: false,
    bindings: { DEV_JWKS: { type: 'plain_text', value: JSON.stringify(jwks) } },
    dev: {
      remote: false, persist, inspector: false, watch: false, liveReload: false,
      logLevel: 'none', server: { hostname: '127.0.0.1', port: 0 },
      registry: join(directory, 'registry'), generateTypes: false,
      outboundService() { throw new Error('External network requests are forbidden in local tests'); },
    },
  });
  // Register teardown immediately, including when readiness or an assertion fails.
  const ports = new Set();
  t.after(async () => {
    await worker.dispose();
    for (const port of ports) {
      assert.equal(await portClosed(port), true, `Worker still listens on ${port}`);
      t.diagnostic(`127.0.0.1:${port} CLOSED after dispose`);
    }
  });
  await worker.ready;
  const url = await worker.url;
  assert.equal(url.hostname, '127.0.0.1');
  ports.add(Number(url.port));
  // workerd and Wrangler may have additional internal listeners. Record those
  // in the run's port audit rather than treating the public URL as every port.
  await writeFile(join(directory, 'port.json'), JSON.stringify({ pid: process.pid, port: Number(url.port) }));
  t.diagnostic(`Local Worker listening at 127.0.0.1:${url.port}`);

  async function mint(claims = {}, privateKey = keys.privateKey, keyId = kid) {
    return new SignJWT({
      type: 'app', sub: 'local-person', email: 'person@example.test',
      iss: 'https://local.cloudflareaccess.com', aud: 'local',
      exp: Math.floor(Date.now() / 1000) + 600, ...claims,
    }).setProtectedHeader({ alg: 'RS256', kid: keyId }).sign(privateKey);
  }
  const person = await mint();
  const agent = await mint({ sub: '', email: undefined, common_name: 'local-agent' });
  async function request(method, path, { token = person, body, headers = {} } = {}) {
    assert.ok(path.startsWith('/'), 'Requests must be local paths');
    // http.request preserves a deliberate Host override while the TCP peer
    // always remains 127.0.0.1; redirects are never followed.
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: Number(url.port), method, path,
        headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        agent: false,
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          let data;
          try { data = JSON.parse(text); } catch { data = text; }
          resolve({ status: response.statusCode, headers: response.headers, data });
        });
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => req.destroy(new Error(`Timed out: ${method} ${path}`)));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function api(method, path, status, options) {
    const response = await request(method, path, options);
    assert.equal(response.status, status, `${method} ${path}: expected ${status}, got ${response.status}`);
    t.diagnostic(`${method} ${path}: ${response.status}`);
    return response.data;
  }
  const openapi = await api('GET', '/api/openapi.json', 200);
  function operation(method, path) {
    const operation = openapi.paths[path]?.[method.toLowerCase()];
    assert.ok(operation, `Live OpenAPI is missing ${method} ${path}`);
    return operation;
  }
  return { directory, request, api, operation, openapi, mint, person, agent, kid };
}
