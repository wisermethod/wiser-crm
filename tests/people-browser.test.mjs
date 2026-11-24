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
  const requests = [];
  const responses = [];
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    const messages = buffer.split('\0');
    buffer = messages.pop();
    for (const message of messages) {
      const { id, result, error, method, params } = JSON.parse(message);
      if (method === 'Network.requestWillBeSent') {
        requests.push({ url: params.request.url, method: params.request.method, type: params.type });
      } else if (method === 'Network.responseReceived') {
        responses.push({ url: params.response.url, status: params.response.status });
      }
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
    requests,
    responses,
    async navigate(path) {
      const result = await page('Page.navigate', { url: new URL(path, url).href });
      assert.equal(result.errorText, undefined);
    },
    async evaluate(expression) {
      const result = await page('Runtime.evaluate', { expression, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, expression);
      return result.result.value;
    },
    async type(text) {
      await page('Input.insertText', { text });
    },
    async pressEnter() {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
      await page('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
      await page('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    },
    async click(x, y) {
      await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y });
      await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y });
    },
    async hover(x, y) {
      await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
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

  const loaded = "location.pathname === '/settings/people' && document.querySelector('main h1')?.textContent === 'People' && document.querySelector('main tbody tr')?.textContent.includes('person@example.test')";
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
  await waitFor(browser, "document.querySelector('h1')?.textContent === \"You're signed in, but not set up yet\"");
  assert.equal(await browser.evaluate("document.querySelector('main p')?.textContent"),
    'An owner of this CRM needs to give you a role. Ask them, then reload this page.');
  assert.equal(await browser.evaluate('Boolean(document.querySelector("nav, script"))'), false);
  assert.deepEqual(await browser.evaluate(`[
    (${exactText('main a', 'Sign out')})?.href ?? null,
    Boolean(${exactText('main p', viewOnlyText)}),
  ]`), [new URL('/cdn-cgi/access/logout', app.url).href, false]);
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

const browserOptions = { timeout: 120_000, skip: !executable && 'No local Chrome or Chromium executable' };
const email = 'jane@example.test';
const roster = '/api/wiser/people';
const janePath = `${roster}/${encodeURIComponent(email)}`;
const viewOnlyText = "View only. You can see everything here but can't change it. Ask an owner if you need to make changes.";
const refusedText = "That change wasn't saved.";
const viewerError = 'You have view-only access. Ask an owner if you need to make changes.';
const toast = "document.querySelector('button[aria-label=\"Dismiss error\"]')?.previousElementSibling.textContent";
const janeRow = `[...document.querySelectorAll('main tbody tr')].find(row => row.cells[0]?.innerText.includes(${JSON.stringify(email)}))`;
const confirmation = exactText('main [role=status]', refusedText);

async function elementPoint(browser, expression) {
  await waitFor(browser, `Boolean(${expression})`);
  await browser.evaluate(`(${expression}).scrollIntoView({ block: 'nearest' })`);
  const point = `(() => {
    const element = ${expression};
    if (!element) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    const point = [x + width / 2, y + height / 2];
    return element.contains(document.elementFromPoint(...point)) ? point : null;
  })()`;
  await waitFor(browser, `Boolean(${point})`);
  return browser.evaluate(point);
}

async function clickElement(browser, expression) {
  await browser.click(...await elementPoint(browser, expression));
}

function exactText(selector, text) {
  return `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.innerText.trim() === ${JSON.stringify(text)})`;
}

for (const [path, title] of [['/customers', 'Customers'], ['/deals?view=next-steps', 'Open deals']]) {
  test(`viewer opens ${title} with meeting sync on without refetching or reloading`, browserOptions, async (t) => {
    const app = await startApp(t, { inspect: true });
    await app.crmDb.prepare('INSERT INTO meeting_sync (id, enabled) VALUES (1, 1)').run();
    await app.api('PUT', janePath, 204, { body: { role: 'viewer' } });
    const browser = await chromePage(t, app.url, await app.personFor(email));
    await browser.navigate(path);
    await waitFor(browser, `document.querySelector('main h1')?.textContent === ${JSON.stringify(title)}
      && Boolean(${exactText('main p', viewOnlyText)})`);
    await delay(2300);

    const reads = (path) => browser.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === path).length;
    const counts = {
      sync: reads('/api/meetings/sync'),
      contacts: reads('/api/contacts'),
      stats: reads('/api/stats'),
      documents: browser.requests.filter(({ type }) => type === 'Document').length,
    };
    assert.ok(browser.responses.some(({ url, status }) =>
      new URL(url).pathname === '/api/meetings/sync' && status === 403), 'the sync read was refused');
    assert.deepEqual({
      syncRequestedOnce: counts.sync === 1,
      contactsReadNormally: counts.contacts >= 1 && counts.contacts <= 2,
      statsReadOnce: counts.stats === 1,
      documents: counts.documents,
      refusedChangeShown: await browser.evaluate(`Boolean(${confirmation})`),
    }, {
      syncRequestedOnce: true, contactsReadNormally: true, statsReadOnce: true, documents: 1, refusedChangeShown: false,
    }, JSON.stringify(counts));
  });
}

async function openPeople(t, role) {
  const app = await startApp(t);
  if (role) await app.api('PUT', janePath, 204, { body: { role } });
  const browser = await chromePage(t, app.url, role === 'member' || role === 'viewer' ? await app.personFor(email) : app.person);
  await browser.navigate('/settings/people');
  await waitFor(browser, "Boolean(document.querySelector('main tbody tr'))");
  return { app, browser };
}

test('owner adds a person through the dialog and sees the new row', browserOptions, async (t) => {
  const { browser } = await openPeople(t);
  assert.equal(await browser.evaluate("document.querySelector('main header').innerText.includes('1 person')"), true);
  await clickElement(browser, exactText('main header button', 'Add person'));
  await waitFor(browser, "document.activeElement === document.querySelector('[role=dialog] input[autocomplete=email]')");
  await browser.type(email);
  assert.equal(await browser.evaluate("document.querySelector('[role=dialog] p').innerText"),
    `This sets what they can do. To let a new person sign in, ask Wiser: "Add ${email} to my CRM."`);
  await clickElement(browser, exactText('[role=dialog] button[type=submit]', 'Add person'));
  await waitFor(browser, `(${janeRow})?.querySelector('[role=combobox]')?.innerText === 'Member'`);
  assert.equal(await browser.evaluate("document.querySelector('main header').innerText.includes('2 people')"), true);
});

test('owner changes a role in the grid', browserOptions, async (t) => {
  const { app, browser } = await openPeople(t, 'owner');
  const select = `(${janeRow})?.querySelector('[role=combobox]')`;
  await clickElement(browser, select);
  await clickElement(browser, exactText('[role=option]', 'Viewer'));
  await waitFor(browser, `${select}?.innerText === 'Viewer'`);
  const result = await app.api('GET', roster, 200);
  assert.equal(result.people.find((person) => person.email === email).role, 'viewer');

  const waitingEmail = 'waiting@example.test';
  await app.api('GET', roster, 403, { token: await app.personFor(waitingEmail) });
  await browser.navigate('/settings/people');
  const waiting = "document.querySelector('tbody[aria-labelledby=wiser-waiting-title]')";
  const waitingSelect = `${waiting}?.querySelector('[role=combobox]')`;
  await waitFor(browser, `${waitingSelect}?.innerText === 'Choose a role'`);
  assert.equal(await browser.evaluate(`${waiting}.querySelector('p').textContent`),
    'These people can sign in but see nothing until you give them a role.');
  await clickElement(browser, waitingSelect);
  await clickElement(browser, exactText('[role=option]', 'Member'));
  await waitFor(browser, `!${waiting} && Boolean(document.querySelector('[aria-label="Role for ${waitingEmail}"]'))`);
  assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Role for ${waitingEmail}"]').innerText`), 'Member');
});

test('owner removes a person through the confirmation and the row goes', browserOptions, async (t) => {
  const { app, browser } = await openPeople(t, 'owner');
  const remove = `(${janeRow})?.querySelector('button[aria-label^="Remove "]')`;
  await clickElement(browser, remove);
  await waitFor(browser, `document.querySelector('[role=dialog] h2')?.textContent === ${JSON.stringify(`Remove ${email}?`)}`);
  assert.equal(await browser.evaluate("document.querySelector('[role=dialog] p').textContent"), 'They lose access straight away.');
  assert.equal(Boolean(await browser.evaluate(`(${janeRow})?.isConnected`)), true);
  await clickElement(browser, exactText('[role=dialog] button', 'Remove'));
  try {
    await waitFor(browser, `!(${janeRow}) && !document.querySelector('[role=dialog]')`);
  } catch (error) {
    t.diagnostic(JSON.stringify(await browser.evaluate(`({
      dialog: document.querySelector('[role=dialog]')?.innerText,
      banner: document.querySelector('[aria-label="Dismiss error"]')?.previousElementSibling.textContent,
    })`)));
    t.diagnostic(JSON.stringify(await app.api('GET', roster, 200)));
    throw error;
  }
});

for (const [role, label] of [['member', 'Member'], ['viewer', 'Viewer']]) {
  test(`${label} sees their own role and You mark without People controls`, browserOptions, async (t) => {
    const { browser } = await openPeople(t, role);
    assert.equal(await browser.evaluate("Boolean(document.querySelector('main button, main [role=combobox]'))"), false);
    assert.deepEqual(await browser.evaluate(`Array.from((${janeRow}).cells[1].querySelectorAll('span > span'), span => span.textContent)`),
      [label, 'You']);
    assert.equal(await browser.evaluate("document.querySelector('main section p').textContent.trim()"),
      'Everyone who can use this CRM, and what each person can do. Only an owner can change this list.');
  });
}

test('a second owner changes other people and not their own row', browserOptions, async (t) => {
  const app = await startApp(t);
  await app.api('PUT', janePath, 204, { body: { role: 'owner' } });
  await app.api('PUT', '/api/wiser/people/other%40example.test', 204, { body: { role: 'member' } });
  const browser = await chromePage(t, app.url, await app.personFor(email));
  await browser.navigate('/settings/people');
  await waitFor(browser, "document.querySelectorAll('main tbody tr').length >= 3");
  assert.equal(await browser.evaluate(`Boolean((${janeRow}).querySelector('button, [role=combobox]'))`), false,
    'no control on the signed-in owner\'s own row');
  assert.deepEqual(await browser.evaluate(`Array.from((${janeRow}).cells[1].querySelectorAll('span > span'), span => span.textContent)`),
    ['Owner', 'You']);
  const other = "[...document.querySelectorAll('main tbody tr')].find(row => row.innerText.includes('other@example.test'))";
  assert.equal(await browser.evaluate(`Boolean((${other}).querySelector('[role=combobox]')) && Boolean((${other}).querySelector('button[aria-label^="Remove "]'))`), true,
    'another person stays editable');
});

test('a second owner adding their own address is refused and stays an owner', browserOptions, async (t) => {
  const app = await startApp(t);
  await app.api('PUT', janePath, 204, { body: { role: 'owner' } });
  const browser = await chromePage(t, app.url, await app.personFor(email));
  await browser.navigate('/settings/people');
  await waitFor(browser, "Boolean(document.querySelector('main tbody tr'))");
  await clickElement(browser, exactText('main header button', 'Add person'));
  await waitFor(browser, "document.activeElement === document.querySelector('[role=dialog] input[autocomplete=email]')");
  await browser.type('Jane@Example.Test');
  await clickElement(browser, exactText('[role=dialog] button[type=submit]', 'Add person'));
  await waitFor(browser, `document.querySelector('[aria-label="Dismiss error"]')?.previousElementSibling.textContent === "You can't change your own access. Ask another owner."`);
  const result = await app.api('GET', roster, 200);
  assert.equal(result.people.find((person) => person.email === email).role, 'owner');
  assert.equal(await browser.evaluate(`Boolean(${exactText('main header button', 'Add person')})`), true, 'still an owner on screen');
});

test('an owner demoted while their screen is open loses the controls at their next change', browserOptions, async (t) => {
  const app = await startApp(t);
  await app.api('PUT', janePath, 204, { body: { role: 'owner' } });
  await app.api('PUT', '/api/wiser/people/other%40example.test', 204, { body: { role: 'member' } });
  const browser = await chromePage(t, app.url, await app.personFor(email));
  await browser.navigate('/settings/people');
  await waitFor(browser, "document.querySelectorAll('main tbody tr').length >= 3");
  await app.api('PUT', janePath, 204, { body: { role: 'member' } });
  const other = "[...document.querySelectorAll('main tbody tr')].find(row => row.innerText.includes('other@example.test'))";
  await clickElement(browser, `(${other})?.querySelector('[role=combobox]')`);
  await clickElement(browser, exactText('[role=option]', 'Viewer'));
  await waitFor(browser, "!document.querySelector('main [role=combobox]') && !document.querySelector('main header button')");
  assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Dismiss error"]')?.previousElementSibling.textContent`), 'Only an owner can change people.');
  const result = await app.api('GET', roster, 200);
  assert.equal(result.people.find((person) => person.email === 'other@example.test').role, 'member');
});

test('each person sees their account and only the viewer sees the view-only bar', browserOptions, async (t) => {
  const app = await startApp(t);
  for (const [role, address] of [
    ['owner', 'person@example.test'],
    ['member', 'member@example.test'],
    ['viewer', 'viewer@example.test'],
  ]) {
    await t.test(role, async (t) => {
      if (role !== 'owner') await app.api('PUT', `${roster}/${encodeURIComponent(address)}`, 204, { body: { role } });
      const browser = await chromePage(t, app.url, await app.personFor(address));
      await browser.navigate('/contacts');
      await waitFor(browser, `Boolean(${exactText('main header button', 'Add contact')})`);
      const account = exactText('aside span', `Signed in as ${address}`);
      const signOut = exactText('aside a', 'Sign out');
      const bar = exactText('main p', viewOnlyText);
      const signOutUrl = new URL('/cdn-cgi/access/logout', app.url).href;
      await waitFor(browser, `Boolean(${account}) && (${signOut})?.href === ${JSON.stringify(signOutUrl)} && Boolean(${bar}) === ${role === 'viewer'}`);
    });
  }
});

test('the contacts list has no Gmail, Google Calendar or Slack status chips', browserOptions, async (t) => {
  const app = await startApp(t);
  const browser = await chromePage(t, app.url, app.person);
  await browser.navigate('/contacts');
  await waitFor(browser, `Boolean(${exactText('main header button', 'Add contact')})`);
  const headerText = `(() => {
    const header = document.querySelector('main header');
    return [header.innerText, ...[...header.querySelectorAll('[title], [aria-label], [role=tooltip]')]
      .flatMap(el => [el.title, el.getAttribute('aria-label'), el.textContent])].join(' ');
  })()`;
  const text = [await browser.evaluate(headerText)];
  // An icon-only chip can put its name in a tooltip that appears only on hover.
  const triggers = "document.querySelectorAll('main header span[data-state]')";
  const count = await browser.evaluate(`${triggers}.length`);
  for (let index = 0; index < count; index++) {
    await browser.hover(0, 0);
    await delay(150);
    await browser.hover(...await elementPoint(browser, `${triggers}[${index}]`));
    await delay(850);
    text.push(await browser.evaluate(headerText));
  }
  assert.doesNotMatch(text.join(' '), /Gmail|Google Calendar|Slack/);
});

test('a refused viewer edit reloads the open contact and shows the bar feedback', browserOptions, async (t) => {
  const app = await startApp(t);
  await app.api('PUT', janePath, 204, { body: { role: 'viewer' } });
  const { contact } = await app.api('POST', '/api/contacts', 201, {
    body: { first_name: 'Mary', last_name: 'Jackson', title: 'Engineer' },
  });
  const browser = await chromePage(t, app.url, await app.personFor(email));
  const contactPath = `/api/contacts/${contact.id}`;
  const contactUrl = new URL(contactPath, app.url).href;
  const field = "document.querySelector('button[aria-label=\"Edit set job title…\"]')";
  await browser.navigate(`/contacts?record=${contact.id}`);
  await waitFor(browser, `${field}?.innerText === 'Engineer'`);
  await browser.evaluate('window.originalContactDocument = true');
  await clickElement(browser, field);
  await waitFor(browser, "document.activeElement.matches('main input') && document.activeElement.value === 'Engineer'");
  await browser.type('Unsaved title');
  await waitFor(browser, "document.activeElement.value === 'Unsaved title'");

  // The stored title changes after the viewer opens the record. Only a fresh
  // read will show it, even if the field already discarded its local draft.
  await app.api('PUT', contactPath, 200, { body: { title: 'Principal Engineer' } });
  const responseStart = browser.responses.length;
  await browser.pressEnter();
  await waitFor(browser, `Boolean(${confirmation}) || ${toast} === ${JSON.stringify(viewerError)}`);
  const responses = () => browser.responses.slice(responseStart);

  await t.test('the 403 displays the refusal in the view-only bar', async () => {
    assert.deepEqual([
      responses().find(({ url, status }) => url === contactUrl && status === 403)?.status,
      await browser.evaluate(`(${confirmation})?.innerText ?? null`),
    ], [403, refusedText]);
  });
  await t.test('the bottom toast does not repeat the view-only refusal', async () => {
    assert.notEqual(await browser.evaluate(toast), viewerError);
  });
  await t.test('the open contact returns to the latest stored title', async () => {
    await waitFor(browser, `${field}?.innerText === 'Principal Engineer'`);
    assert.equal(await browser.evaluate('window.originalContactDocument === true'), false, 'the document reloaded');
    assert.equal(await browser.evaluate('location.pathname + location.search'), `/contacts?record=${contact.id}`);
  });
  await t.test('the contacts list re-reads after the refusal', async () => {
    assert.ok(responses().some(({ url, status }) => url.startsWith(new URL('/api/contacts?', app.url).href) && status === 200));
  });
});

test('a refused viewer column change reloads and restores the stored layout', browserOptions, async (t) => {
  const app = await startApp(t);
  await app.api('PUT', janePath, 204, { body: { role: 'viewer' } });
  await app.api('POST', '/api/contacts', 201, { body: { first_name: 'Mary', email: 'mary@example.test' } });
  const browser = await chromePage(t, app.url, await app.personFor(email));
  await browser.navigate('/contacts');
  const column = "document.querySelector('main th button[aria-label=\"Sort by Email\"]')";
  await waitFor(browser, `Boolean(${column}) && Boolean(${exactText('main p', viewOnlyText)})`);
  await browser.evaluate('window.originalContactsDocument = true');
  await clickElement(browser, "document.querySelector('button[aria-label=\"Show or hide columns\"]')");
  await clickElement(browser, exactText('[role=option]', 'Email'));
  await waitFor(browser, `Boolean(${confirmation}) && (window.originalContactsDocument || Boolean(${column}))`);
  assert.ok(browser.responses.some(({ url, status }) => /\/api\/views\/[^/]+\/fields\/email$/.test(url) && status === 403));
  assert.deepEqual(await browser.evaluate(`[Boolean(window.originalContactsDocument), Boolean(${column})]`), [false, true]);

  await browser.navigate('/contacts');
  await waitFor(browser, `Boolean(${column}) && Boolean(${exactText('main p', viewOnlyText)})`);
  assert.equal(await browser.evaluate(`Boolean(${confirmation})`), false, 'the next load does not repeat the refusal');
});

test('a refused viewer deal deletion reloads and keeps the deal', browserOptions, async (t) => {
  const app = await startApp(t);
  await app.api('PUT', janePath, 204, { body: { role: 'member' } });
  const { deal } = await app.api('POST', '/api/deals', 201, { body: { name: 'Keep this deal' } });
  const browser = await chromePage(t, app.url, await app.personFor(email));
  await browser.navigate('/deals');
  const remove = "document.querySelector('button[aria-label=\"Delete Keep this deal\"]')";
  await waitFor(browser, `Boolean(${exactText('aside a', 'Sign out')}) && Boolean(${remove})`);
  assert.equal(await browser.evaluate(`Boolean(${exactText('main p', viewOnlyText)})`), false);
  await browser.evaluate('window.originalDealsDocument = true');
  await app.api('PUT', janePath, 204, { body: { role: 'viewer' } });
  await clickElement(browser, remove);
  await clickElement(browser, exactText('[role=dialog] button', 'Delete'));
  await waitFor(browser, `Boolean(${confirmation}) && Boolean(${remove})`);
  assert.ok(browser.responses.some(({ url, status }) => url === new URL(`/api/deals/${deal.id}`, app.url).href && status === 403));
  assert.equal(await browser.evaluate('window.originalDealsDocument === true'), false);
  assert.equal(await browser.evaluate("Boolean(document.querySelector('[role=dialog]'))"), false);
});

test('a view-only write error without a gesture clears without a refetch or reload', browserOptions, async (t) => {
  const app = await startApp(t, {
    wrapWorker: (worker) => ({
      fetch(request, env, context) {
        if (new URL(request.url).pathname === '/api/stats') {
          return Response.json({ error: 'You have view-only access. Ask an owner if you need to make changes.' }, { status: 403 });
        }
        return worker.fetch(request, env, context);
      },
    }),
  });
  await app.api('PUT', janePath, 204, { body: { role: 'viewer' } });
  const browser = await chromePage(t, app.url, await app.personFor(email));
  await browser.navigate('/contacts');
  await waitFor(browser, `Boolean(${exactText('main p', viewOnlyText)})`);
  await delay(500);
  const stats = browser.requests.filter(({ url }) => new URL(url).pathname === '/api/stats');
  const documents = browser.requests.filter(({ type }) => type === 'Document');
  assert.deepEqual([stats.length, documents.length, await browser.evaluate(`[${toast} ?? null, Boolean(${confirmation})]`)],
    [1, 1, [null, false]]);
});

test('the viewer account and sign-out return after two failed people reads', browserOptions, async (t) => {
  const app = await startApp(t, {
    wrapWorker: (worker) => {
      let attempts = 0;
      return {
        fetch(request, env, context) {
          if (request.method === 'GET' && new URL(request.url).pathname === '/api/wiser/people' && ++attempts <= 2) {
            return Response.json({ error: 'People are unavailable.' }, { status: 503 });
          }
          return worker.fetch(request, env, context);
        },
      };
    },
  });
  await app.api('PUT', janePath, 204, { body: { role: 'viewer' } });
  const browser = await chromePage(t, app.url, await app.personFor(email));
  await browser.navigate('/contacts');
  await waitFor(browser, `Boolean(${exactText('aside span', `Signed in as ${email}`)})
    && Boolean(${exactText('aside a', 'Sign out')}) && Boolean(${exactText('main p', viewOnlyText)})`);
  assert.deepEqual(browser.responses.filter(({ url }) => new URL(url).pathname === roster).map(({ status }) => status),
    [503, 503, 200]);
});

test('a viewer who cannot load their account still sees a refused write in the toast', browserOptions, async (t) => {
  const app = await startApp(t, {
    wrapWorker: (worker) => {
      return {
        fetch(request, env, context) {
          if (request.method === 'GET' && new URL(request.url).pathname === '/api/wiser/people') {
            return Response.json({ error: 'People are unavailable.' }, { status: 503 });
          }
          return worker.fetch(request, env, context);
        },
      };
    },
  });
  await app.api('PUT', janePath, 204, { body: { role: 'viewer' } });
  await app.api('POST', '/api/contacts', 201, { body: { first_name: 'Mary', email: 'mary@example.test' } });
  const browser = await chromePage(t, app.url, await app.personFor(email));
  await browser.navigate('/contacts');
  await browser.evaluate('window.originalContactsDocument = true');
  await clickElement(browser, "document.querySelector('button[aria-label=\"Show or hide columns\"]')");
  await clickElement(browser, exactText('[role=option]', 'Email'));
  await delay(1100);
  assert.equal(await browser.evaluate(toast), viewerError);
  assert.equal(await browser.evaluate('window.originalContactsDocument === true'), true);
  assert.deepEqual(browser.responses.filter(({ url }) => new URL(url).pathname === roster).map(({ status }) => status),
    [503, 503, 503]);
});

test('a refused owner change shows the Worker sentence in the app banner', browserOptions, async (t) => {
  const app = await startApp(t, { vars: { WISER_READ_ONLY: 'true' } });
  const browser = await chromePage(t, app.url, app.person);
  await browser.navigate('/settings/people');
  await clickElement(browser, exactText('main header button', 'Add person'));
  await waitFor(browser, "document.activeElement === document.querySelector('[role=dialog] input[autocomplete=email]')");
  await browser.type(email);
  await clickElement(browser, exactText('[role=dialog] button[type=submit]', 'Add person'));
  const dismiss = "document.querySelector('button[aria-label=\"Dismiss error\"]')";
  await waitFor(browser, `Boolean(${dismiss}) && !document.querySelector('[role=dialog]')`);
  assert.equal(await browser.evaluate(`${dismiss}.previousElementSibling.textContent`),
    'The CRM is read-only during an upgrade.');
  assert.equal(await browser.evaluate(`Boolean(${janeRow})`), false);
});
