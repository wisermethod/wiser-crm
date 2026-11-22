import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from './local-worker.mjs';

let executable = process.env.WISER_TEST_CHROME;
if (!executable) {
  for (const path of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (await access(path, fsConstants.X_OK).then(() => true, () => false)) {
      executable = path;
      break;
    }
  }
}

async function chromePage(t, url, token) {
  const profile = await mkdtemp(join(tmpdir(), 'wiser-people-chrome-'));
  const child = spawn(executable, [
    '--headless', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let close;
  const closed = new Promise((resolve) => { close = resolve; });
  const pending = new Map();
  function disconnect(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  child.once('error', (error) => { disconnect(error); close(); });
  child.once('exit', (status) => { disconnect(new Error(`Chrome exited with status ${status}`)); close(); });
  t.after(async () => {
    child.kill();
    await closed;
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  });
  const input = child.stdio[3];
  const output = child.stdio[4];
  input.on('error', disconnect);
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    const messages = buffer.split('\0');
    buffer = messages.pop();
    for (const message of messages) {
      const { id, result, error } = JSON.parse(message);
      const response = pending.get(id);
      if (!response) continue;
      pending.delete(id);
      if (error) response.reject(new Error(error.message));
      else response.resolve(result);
    }
  });
  let id = 0;
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      id++;
      pending.set(id, { resolve, reject });
      input.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => command(method, params, sessionId);
  await page('Network.enable');
  await page('Network.setExtraHTTPHeaders', { headers: { 'Cf-Access-Jwt-Assertion': token } });
  return {
    async navigate(path) {
      const result = await page('Page.navigate', { url: new URL(path, url).href });
      assert.equal(result.errorText, undefined);
    },
    async evaluate(expression) {
      const result = await page('Runtime.evaluate', { expression, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, expression);
      return result.result.value;
    },
    async click(x, y) {
      await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y });
      await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y });
    },
  };
}

async function waitFor(browser, expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await browser.evaluate(expression)) return;
    await delay(50);
  }
  assert.fail(`Chrome did not reach: ${expression}`);
}

test('S1-21 built client opens People by normal click and by direct load', {
  timeout: 120_000, skip: !executable && 'No local Chrome or Chromium executable',
}, async (t) => {
  const app = await startApp(t);
  const browser = await chromePage(t, app.url, app.person);
  await browser.navigate('/');
  const link = "document.querySelector('a[href=\"/settings/people\"]')";
  await waitFor(browser, `Boolean(${link})`);
  const bounds = await browser.evaluate(`(() => {
    window.peopleProofDocument = true;
    const { x, y, width, height } = ${link}.getBoundingClientRect();
    return [x + width / 2, y + height / 2];
  })()`);
  await browser.click(...bounds);

  const loaded = "location.pathname === '/settings/people' && document.querySelector('main h1')?.textContent === 'People' && document.querySelector('main li')?.textContent.includes('person@example.test')";
  await waitFor(browser, loaded);
  assert.equal(await browser.evaluate('window.peopleProofDocument'), true, 'the click remained in the original document');
  assert.equal(await browser.evaluate("document.querySelector('main').textContent.includes('Not found')"), false);
  await browser.navigate('/settings/people');
  await waitFor(browser, `${loaded} && !window.peopleProofDocument`);
  assert.equal(await browser.evaluate("document.querySelector('main').textContent.includes('Not found')"), false);
  t.diagnostic('Headless Chrome used the built assets and the local Worker. The normal mouse click kept the same document.');
});

test('an unassigned person gets the waiting page in Chrome', {
  timeout: 120_000, skip: !executable && 'No local Chrome or Chromium executable',
}, async (t) => {
  const app = await startApp(t);
  const browser = await chromePage(t, app.url, await app.personFor('waiting@example.test'));
  await browser.navigate('/');
  await waitFor(browser, "document.querySelector('h1')?.textContent === 'Waiting for access'");
  assert.equal(await browser.evaluate('Boolean(document.querySelector("nav, script"))'), false);
});

for (const [path, title, overview] of [
  ['/customers', 'Customers', 'No customers yet.'],
  ['/deals?view=next-steps', 'Open deals', 'No open deals.'],
]) {
  test(`viewer opens the ${title} overview in the built client when sync is off`, {
    timeout: 120_000, skip: !executable && 'No local Chrome or Chromium executable',
  }, async (t) => {
    const app = await startApp(t);
    await app.api('PUT', '/api/wiser/people/viewer%40example.test', 204, { body: { role: 'viewer' } });
    const browser = await chromePage(t, app.url, await app.personFor('viewer@example.test'));
    await browser.navigate(path);
    await waitFor(browser, `document.querySelector('main h1')?.textContent === ${JSON.stringify(title)}
      && document.querySelector('main')?.textContent.includes(${JSON.stringify(overview)})`);
    assert.equal(await browser.evaluate("document.querySelector('main').textContent.includes('Loading…')"), false);
    assert.equal(await browser.evaluate("Boolean(document.querySelector('[aria-label=\"Dismiss error\"]'))"), false);
  });
}
