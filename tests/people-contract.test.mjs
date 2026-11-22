import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = new URL('../', import.meta.url);

// From "Every sentence, on its own." Use the approved examples to resolve the
// three dynamic templates in source, independently of the shipped copy.
const examples = {
  count: '5',
  'email || "jane@example.com"': 'jane@example.com',
  removing: 'sam@example.com',
};
const approved = {
  'src/client/app.tsx': ['People'],
  'src/client/wiser-people.tsx': [
    'People',
    '5 people',
    'Everyone who can use this CRM, and what each person can do.',
    'Email', 'Role', 'Added by',
    'Owner', 'Member', 'Viewer',
    'First owner', 'Set at install',
    'Add person', 'Cancel',
    'This sets what they can do. To let a new person sign in, ask Wiser: "Add jane@example.com to my CRM."',
    'Waiting for a role',
    'These people can sign in but see nothing until you give them a role.',
    'Choose a role', 'Signed in, no role yet',
    'Remove', 'Remove sam@example.com?', 'They lose access straight away.',
    'Only an owner can change this list.', 'You',
  ],
  'worker/people.ts': [
    "You're signed in, but not set up yet",
    'An owner of this CRM needs to give you a role. Ask them, then reload this page.',
    'The first owner is set when the CRM is installed. Ask Wiser to change it.',
    // Added after the mockup, at the second review round.
    "You can't change your own access. Ask another owner.",
  ],
  'worker/sign-in.ts': ['You have view-only access. Ask an owner if you need to make changes.'],
};

function sourceStrings(source) {
  const texts = new Set();
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isJsxText(node)) texts.add(node.text.trim());
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const part of node.templateSpans) {
        text += (examples[part.expression.getText(source)] ?? part.expression.getText(source)) + part.literal.text;
      }
      texts.add(text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return texts;
}

test('each approved People sentence appears verbatim in its shipped source', async () => {
  for (const [name, sentences] of Object.entries(approved)) {
    const content = await readFile(new URL(name, root), 'utf8');
    const source = ts.createSourceFile(name, content, ts.ScriptTarget.Latest);
    const texts = sourceStrings(source);
    for (const sentence of sentences) {
      assert.ok(texts.has(sentence), `${name} is missing the approved text: ${sentence}`);
    }
  }
});

test('runtime/people is portable and only names its own table', async () => {
  const baseline = await readFile(new URL('migrations/0001_baseline.sql', root), 'utf8');
  const crmTables = [...baseline.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gim)].map(([, table]) => table);
  assert.ok(crmTables.length > 0, 'Check against the actual CRM table names');
  const crmNames = new RegExp(`\\b(?:wiser-crm|opencrm|clawnify|${crmTables.join('|')})\\b`, 'i');
  const directory = new URL('runtime/people/', root);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const code = entries.filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name));
  assert.ok(code.length > 0, 'Check actual module source');
  for (const entry of code) {
    const file = join(entry.parentPath, entry.name);
    const content = await readFile(file, 'utf8');
    assert.doesNotMatch(content, crmNames, `${entry.name} names a CRM concept`);
    const { importedFiles, referencedFiles } = ts.preProcessFile(content, true, true);
    const imports = [...importedFiles, ...referencedFiles].map(({ fileName }) => fileName);
    for (const specifier of imports) {
      const local = relative(fileURLToPath(directory), join(entry.parentPath, specifier));
      assert.ok(specifier.startsWith('.') && local !== '..' && !local.startsWith('../'),
        `${entry.name} depends on ${specifier} outside runtime/people`);
    }

    const literals = sourceStrings(ts.createSourceFile(entry.name, content, ts.ScriptTarget.Latest));
    for (const literal of literals) {
      assert.doesNotMatch(literal, /\/api\/|\/settings\/|\b(?:opencrm|wiser[ -]crm|clawnify)\b/i);
      if (!/^(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(literal)) continue;
      const tables = [...literal.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+["`\[]?(\w+)/gi)]
        .map(([, table]) => table.toLowerCase())
        .filter((table) => table !== 'set');
      assert.ok(tables.length > 0, `No table found in SQL: ${literal}`);
      assert.deepEqual([...new Set(tables)], ['wiser_people'], `Unexpected table in SQL: ${literal}`);
    }
  }
});
