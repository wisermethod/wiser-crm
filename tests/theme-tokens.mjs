import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
export const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Extract flat rules, including those within a layer or media query.
const flatRules = (css) => [...withoutComments(css).matchAll(/([^{};]+)\{([^{}]*)\}/g)];
const ruleDeclarations = (body) => [...body.matchAll(/([\w-]+)\s*:\s*([^;]+)(?:;|$)/g)]
  .map(([, property, value]) => [property, value.trim()]);

export function declarations(css, selector) {
  const normalize = (header) => header.trim().replace(/\s*,\s*/g, ",").replace(/\s+/g, " ");
  const rules = flatRules(css)
    .filter(([, header]) => normalize(header) === normalize(selector));
  assert.ok(rules.length, `Missing CSS rule ${selector}`);
  return Object.fromEntries(rules.flatMap(([, , body]) => ruleDeclarations(body)));
}

const customProperties = (rule) => Object.fromEntries(
  Object.entries(rule).filter(([name]) => name.startsWith("--")),
);

function resolveToken(tokens, name, seen = []) {
  assert.ok(Object.hasOwn(tokens, name), `Undefined token ${name}`);
  assert.ok(!seen.includes(name), `Circular token ${name}`);
  return tokens[name].replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, reference) => (
    resolveToken(tokens, reference, [...seen, name])
  ));
}

const upstream = read("../src/client/styles.css");
export const overlay = read("../src/client/wiser-theme.css");
export const inlineTheme = customProperties(declarations(upstream, "@theme inline"));

export function resolvedThemes() {
  const radii = Object.entries(inlineTheme).filter(([name]) => name.startsWith("--radius-"));
  const rules = [...flatRules(upstream), ...flatRules(overlay)];
  // :root and .dark have equal specificity. The overlay loads last.
  return [[":root"], [":root", ".dark"]].map((selectors) => {
    const properties = rules
      .filter(([, header]) => selectors.includes(header.trim()))
      .flatMap(([, , body]) => ruleDeclarations(body).filter(([name]) => name.startsWith("--")));
    const tokens = Object.fromEntries([...radii, ...properties]);
    return Object.fromEntries(Object.keys(tokens).map((name) => [name.slice(2), resolveToken(tokens, name)]));
  });
}

// Keep the surrounding layer or media condition with every declaration block.
export function selectorRules(css) {
  const stack = [];
  const rules = [];
  let value = "";
  for (const part of withoutComments(css).split(/([{}])/)) {
    if (part === "{") {
      stack.push(value.trim().replace(/\s+/g, " "));
    } else if (part === "}") {
      if (value.trim()) rules.push([stack.join(" > "), value.trim().replace(/\s+/g, " ")]);
      stack.pop();
    } else {
      value = part;
    }
  }
  return rules;
}
