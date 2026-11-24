import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inlineTheme, selectorRules, overlay, read, resolvedThemes, withoutComments } from "./theme-tokens.mjs";

test("the CRM loads upstream CSS before the overlay", () => {
  const app = read("../src/client/app.tsx");
  const styles = [...app.matchAll(/^import ["']\.\/([^"']+\.css)["']/gm)].map(([, file]) => file);
  assert.deepEqual(styles, ["styles.css", "wiser-theme.css"]);
});

test("DESIGN.wiser.md lists every app token resolved for light and dark in source order", () => {
  const [opening, frontMatter, prose] = read("../DESIGN.wiser.md").split(/^---\n/gm);
  assert.equal(opening, "");
  assert.ok(frontMatter && prose, "Design requires front matter and prose");
  // Each front matter token is a YAML flow sequence of two JSON strings.
  const design = {};
  for (const [, token, values] of frontMatter.matchAll(/^  ([\w-]+): (.*)$/gm)) {
    assert.ok(!Object.hasOwn(design, token), `Duplicate design token --${token}`);
    design[token] = JSON.parse(values);
    assert.ok(Array.isArray(design[token]) && design[token].length === 2,
      `Expected light and dark values for --${token}`);
  }

  const [light, dark] = resolvedThemes();
  for (const [index, [mode, tokens]] of [["light", light], ["dark", dark]].entries()) {
    assert.deepEqual(Object.keys(design).sort(), Object.keys(tokens).sort(), `Token list in ${mode}`);
    for (const [name, value] of Object.entries(tokens)) {
      assert.equal(design[name][index], value, `--${name} in ${mode}`);
    }
  }
});

test("the overlay does not override literals in @theme inline", () => {
  const declarations = withoutComments(overlay).matchAll(/(?:\{|;)\s*(--[\w-]+)\s*:/g);
  for (const [, name] of declarations) {
    assert.ok(!Object.hasOwn(inlineTheme, name) || /\bvar\(/.test(inlineTheme[name]),
      `${name} is inlined as ${inlineTheme[name]} and cannot be overridden by the overlay`);
  }
});

const mistSelectors = [
  ["@layer base > body",
    "font-family: var(--font-sans); line-height: 1.5;"],
  [":is(h1, [role=\"dialog\"] h2).font-semibold",
    "font-weight: 560;"],
  ["table.table-fixed, table.table-fixed th",
    "font-size: 0.875rem; line-height: 1.45;"],
  ["table.table-fixed :is(th, td).text-right",
    "font-variant-numeric: tabular-nums;"],
  ["table.table-fixed td > span.tabular",
    "font-size: 0.8125rem;"],
  [":is(:root, .dark) aside.cn-nav :is(a.cn-nav-brand, .cn-nav-item):hover",
    "background: var(--card);"],
  ["aside.cn-nav .cn-nav-item .cn-nav-icon",
    "color: var(--muted-foreground);"],
  [":is(:root, .dark) aside.cn-nav a.cn-nav-item[data-active]",
    "background: var(--sidebar-accent); color: var(--sidebar-accent-foreground);"],
  ["aside.cn-nav .cn-nav-item[data-active] :is(.cn-nav-icon, .cn-nav-count)",
    "color: var(--sidebar-accent-foreground);"],
  ["aside.cn-nav a.cn-nav-brand:focus-visible",
    "outline-offset: -2px;"],
  [".wiser-account",
    "display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem; padding: 0.25rem 0.5rem; color: var(--muted-foreground); font-size: 0.8125rem; overflow-wrap: anywhere;"],
  ["@media (min-width: 768px) > [data-nav-collapsed] .wiser-account",
    "align-items: center; padding-inline: 0;"],
  ["@media (min-width: 768px) > [data-nav-collapsed] .wiser-account a",
    "display: grid; width: 1.75rem; height: 1.75rem; place-items: center;"],
  ["@media (max-width: 767px) > aside.cn-nav:has(.wiser-account)",
    "flex: 1; min-width: 0; flex-direction: column; overflow-x: visible;"],
  ["@media (max-width: 767px) > aside.cn-nav:has(.wiser-account) .cn-nav-groups",
    "flex: initial; overflow-x: auto;"],
  ["@media (max-width: 767px) > aside.cn-nav .cn-nav-footer:has(.wiser-account)",
    "display: block; border-top: 1px solid var(--sidebar-border);"],
  ["@media (max-width: 767px) > .wiser-account",
    "flex-direction: row; justify-content: space-between; align-items: baseline; padding: 0.375rem 0.75rem;"],
  ["@media (max-width: 767px) > .wiser-account a",
    "flex: none;"],
  [".wiser-view-only",
    "flex-shrink: 0; padding: 0.5rem 1rem; background: var(--info-tint); color: var(--foreground); font-size: 0.875rem;"],
  [".wiser-view-only strong",
    "color: var(--info);"],
  [".wiser-view-only [role=\"status\"]",
    "font-weight: 600;"],
  ["a:is(.text-info, .text-link)",
    "color: var(--link); text-decoration-line: underline; text-underline-offset: 0.13em;"],
  [":is(input, textarea, select, button).shadow-edge,\n:is(button, a, [role=\"button\"]).shadow-raised",
    "box-shadow: inset 0 0 0 1px var(--input);"],
  ["[role=\"radio\"][aria-checked=\"false\"] > .border-border,\nbutton.border-border:is(.border, .border-dashed)",
    "border-color: var(--input);"],
  ["button[role=\"combobox\"].shadow-edge > svg.opacity-50,\nbutton.shadow-edge > svg.lucide-chevrons-up-down.opacity-50",
    "opacity: 0.75;"],
  ["@media (forced-colors: none) > input[type=\"checkbox\"]:enabled",
    "accent-color: var(--accent-text);"],
  ["@media (forced-colors: none) > input[type=\"checkbox\"]:enabled:not(:checked, :indeterminate)",
    "appearance: none; min-inline-size: 13px; min-block-size: 13px; background-color: var(--card); border: 1px solid var(--input); border-radius: 3px;"],
  ["table.table-fixed tr[data-state=\"selected\"],\ntable.table-fixed tr[data-state=\"selected\"] > td.sticky:first-child,\n[role=\"option\"][data-state=\"checked\"],\n[cmdk-item][data-selected=\"true\"]",
    "background-color: var(--accent-tint);"],
  ["table.table-fixed tr[data-state=\"selected\"] > td.sticky:first-child",
    "box-shadow: inset 2px 0 var(--ring), inset -1px 0 var(--rule);"],
  [".ring-ring\\/15, .ring-ring\\/30",
    "--tw-ring-color: var(--ring);"],
  ["aside:not(:has(#note-body, #meeting-title)) button[aria-label=\"Add note\"].shadow-raised",
    "color: var(--primary-foreground); background-color: var(--primary); border-radius: var(--radius-pill); box-shadow: var(--shadow-solid);"],
  [".bg-primary.text-primary-foreground",
    "border-radius: var(--radius-pill);"],
  [".text-primary:not(.bg-primary)",
    "color: var(--primary-text);"],
  ["@media (hover: hover) > aside:not(:has(#note-body, #meeting-title)) button[aria-label=\"Add note\"].shadow-raised:hover,\n  .bg-primary.text-primary-foreground:hover",
    "background-color: var(--primary-hover);"],
  ["@media (hover: hover) > .hover\\:bg-destructive-solid:hover",
    "background-color: var(--destructive-hover);"],
  [":where(a[href], button, input, select, textarea, [tabindex], [contenteditable]):focus-visible",
    "outline: 2px solid var(--ring); outline-offset: 2px;"],
  [":is(input, textarea, select, button).shadow-edge:focus-visible",
    "box-shadow: inset 0 0 0 1px var(--ring);"],
  ["aside:not(:has(#note-body, #meeting-title)) button[aria-label=\"Add note\"].shadow-raised:focus-visible,\n.bg-primary.text-primary-foreground:focus-visible",
    "box-shadow: inset 0 0 0 2px var(--primary-focus-inner);"],
  ["@media (forced-colors: active) > :where(a[href], button, input, select, textarea, [tabindex], [contenteditable]):focus-visible",
    "outline-color: Highlight;"],
  [".fixed.inset-0.bg-black\\/60.backdrop-blur-sm",
    "background-color: var(--dialog-scrim); backdrop-filter: blur(2px);"],
  ["[role=\"dialog\"].shadow-float.bg-background",
    "background-color: var(--popover);"],
  ["[role=\"dialog\"].shadow-float, .fixed.inset-0.bg-black\\/60.backdrop-blur-sm",
    "animation-duration: 140ms; --tw-enter-scale: 1; --tw-exit-scale: 1;"],
  ["@media (prefers-reduced-motion: reduce) > [role=\"dialog\"].shadow-float, .fixed.inset-0.bg-black\\/60.backdrop-blur-sm",
    "animation: none;"],
];

test("all documented Mist selector declarations apply in the right rule context", () => {
  assert.deepEqual(selectorRules(overlay).filter(([name]) => name !== ":root" && name !== ".dark"), mistSelectors.map(([name, body]) => [name.replace(/\s+/g, " "), body]));
});

test("Mist sets the native colour scheme for each mode", () => {
  const palettes = selectorRules(overlay).filter(([name]) => name === ":root" || name === ".dark");
  assert.deepEqual(palettes.map(([name, body]) => [name, body.split("; ").filter(entry => !entry.startsWith("--"))]), [
    [":root", ["color-scheme: light"]], [".dark", ["color-scheme: dark"]],
  ]);
});

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") return sourceFiles(path);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?|html)$/.test(entry.name) ? [path] : [];
  });
}

test("only the button component uses the primary pill's class pair", () => {
  const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
  const button = path("../src/client/components/ui/button.tsx");
  const files = [path("../index.html"), ...sourceFiles(path("../src/")), ...sourceFiles(path("../runtime/"))];

  const primary = /(?<![\w-])bg-primary(?![\w/-])/;
  const foreground = /(?<![\w-])text-primary-foreground(?![\w/-])/;
  const matches = files.filter((file) => {
    const source = readFileSync(file, "utf8");
    return primary.test(source) && foreground.test(source);
  });
  assert.deepEqual(matches, [button], "The primary pill class pair must be confined to the button component");
});
